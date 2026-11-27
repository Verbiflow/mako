import "./lib/scratch-git.mjs"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs, promisify } from "node:util"
import { z } from "zod"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { scratchHostHome } from "./scratch-harness-home.ts"

/**
 * When Apexes split work into Fins, on real harnesses and real models: a host of its own in a scratch home signed in
 * as the person (`scratchHostHome`), a fresh scratch project for every Apex. Spends model calls on every harness it
 * names, so each Apex is stopped, with its Fins, as soon as it has made its choices: it needn't finish the work. Run
 * by hand, never by CI.
 *
 *   npx tsx scripts/prove-split-rule.ts --out <folder> [--harnesses claude,codex,grok,cursor,opencode,devin] [--tasks typo,research,same-function,feature]
 *
 * Each task has a known right answer:
 * - typo: fix one misspelling in README.md. No Fin.
 * - research: three independent questions, each about its own large module. Three Fins, started in one turn.
 * - same-function: two changes to one function in one file. One Fin or none, two only sequenced with after, or an
 *   overlap refusal the Apex then resolves (sent on, after, or proceed with a reason).
 * - feature: one small feature across a client and a server file that must agree on a shape. One Fin or none.
 *
 * For each Apex it keeps its agents_start calls as the host took them (started, queued, refused and why, proceed and
 * why), each Fin's touches, and how its turn ended; `results.json` and `table.md` in `--out` hold every one, with the
 * host's log and the harnesses' transcripts. A harness that isn't signed in or is out of usage says so in its row.
 */
const { values } = parseArgs({ options: {
  out: { type: "string" },
  harnesses: { type: "string", default: "claude,codex,grok,cursor,opencode,devin" },
  tasks: { type: "string", default: "typo,research,same-function,feature" },
  /** How long an Apex has to make its choices before it is stopped. */
  "apex-ms": { type: "string", default: String(6 * 60_000) },
  /** A model for a harness's Apex, as harness=model; absent, the harness's default. */
  model: { type: "string", multiple: true, default: ["claude=claude-opus-5-5"] },
} })
if (!values.out) throw new Error("--out <folder> says where the proof's files go")
const out = resolve(values.out)
const harnesses = values.harnesses!.split(",").filter(Boolean)
const tasks = values.tasks!.split(",").filter(Boolean)
const apexMs = Number(values["apex-ms"])
const models = new Map(values.model!.map((pair) => [pair.slice(0, pair.indexOf("=")), pair.slice(pair.indexOf("=") + 1)]))
const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const root = await mkdtemp(join(tmpdir(), "mako-prove-split-"))
const scratch = scratchHostHome(root)
const home = scratch.home
const dataRoot = join(root, "data")
const location = runtimeLocation(dataRoot)
const THREADS = join(dataRoot, "threads.sqlite")
const HOST_LOG = join(dataRoot, "logs", "host.log")
const CLIENT = randomUUID()
const run = promisify(execFile)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Each harness's mode for full access, as its live driver names it. */
const FULL = new Map([["claude", "bypassPermissions"], ["codex", "access:full"], ["grok", "access:full"], ["devin", "bypass"], ["opencode", "access:full"]])

const Json = z.json()
type Json = z.infer<typeof Json>

async function until<T>(what: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let failed: unknown
  for (;;) {
    let value: T | undefined
    try {
      value = await read()
    } catch (error) {
      failed = error
    }
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`, { cause: failed })
    await pause(2_000)
  }
}

const Quoted = z.string()
/** One host log line's `key=value` fields, a quoted value read as the JSON string it's written as. */
function fieldsOf(raw: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const [, key, value] of raw.matchAll(/ (\w+)=("(?:[^"\\]|\\.)*"|\S+)/g)) {
    if (!key || value === undefined) continue
    let read = value
    if (value.startsWith("\"")) {
      try {
        read = Quoted.parse(JSON.parse(value))
      } catch {
        read = value.slice(1, -1)
      }
    }
    fields.set(key, read)
  }
  return fields
}
/** The host's log as lines, each with its fields. */
function hostLines(): { raw: string; fields: Map<string, string> }[] {
  if (!existsSync(HOST_LOG)) return []
  return readFileSync(HOST_LOG, "utf8").split("\n").filter(Boolean).map((raw) => ({ raw, fields: fieldsOf(raw) }))
}

function store<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(THREADS, { readOnly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}
const SessionRow = z.object({ session_id: z.string() })
const ThreadRow = z.object({ thread_id: z.string() })
const sessionOf = (conversation: string) => store((db) => SessionRow.safeParse(db.prepare("SELECT session_id FROM journals WHERE conversation_id = ?").get(conversation)).data?.session_id)
const threadOf = (conversation: string) => store((db) => ThreadRow.safeParse(db.prepare("SELECT m.thread_id FROM journals j JOIN memberships m ON m.session_id = j.session_id WHERE j.conversation_id = ?").get(conversation)).data?.thread_id)
const Edges = z.array(z.object({ child_thread: z.string(), name: z.string(), record: z.string(), created_at: z.number() }))
const edgesUnder = (thread: string) => store((db) => Edges.parse(db.prepare("SELECT child_thread, name, record, created_at FROM thread_parents WHERE parent_thread = ? ORDER BY created_at").all(thread)))
const EdgeRecord = z.looseObject({ op: z.string().optional(), asked: z.looseObject({ touches: z.array(z.string()).optional(), proceed: z.string().optional(), workspace: Json.optional() }).optional() })

let host: ChildProcess | undefined
const call = (channel: string, args: unknown[]) => invokeRuntime(location.socket, CLIENT, channel, args)
const mako = async (args: string[], env?: NodeJS.ProcessEnv) => {
  const { stdout } = await run(process.execPath, [cli, ...args, "--socket", location.socket, "--json"], { env: { ...scratch.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim().split("\n").filter(Boolean).map((line) => Json.parse(JSON.parse(line)))
}
const HistoryLine = z.looseObject({ kind: z.string(), text: z.string().optional() })
const history = async (conversation: string) => (await mako(["history", conversation])).map((line) => HistoryLine.parse(line))
const Block = z.looseObject({ type: z.string(), name: z.string().optional(), title: z.string().optional(), input: z.string().optional(), output: z.string().optional(), text: z.string().optional(), status: z.string().optional() })
const Snapshot = z.looseObject({ requests: z.array(z.looseObject({ id: z.string(), status: z.string(), error: Json.optional() })).default([]), blocks: z.array(Block).default([]) })
const snapshot = async (conversation: string) => Snapshot.parse(await call("mako:live-snapshot", [conversation]))
const ENDED = new Set(["completed", "failed", "canceled", "interrupted", "uncertain"])

/** Real modules of this repository, each about 1,200 lines from its own domain: a review of one is careful reading, not a search. */
const REVIEWED = [
  { from: "packages/host/src/git/github.ts", to: "lib/github.ts" },
  { from: "packages/host/src/workspaces/thread-recipe.ts", to: "lib/recipe.ts" },
  { from: "packages/sessions/src/attachment-sweep.ts", to: "lib/sweep.ts" },
]

interface Task { id: string; prompt: string; files: Record<string, string> }
const TASK_LIST: Task[] = [
  {
    id: "typo",
    prompt: "Fix the typo 'recieve' in README.md.",
    files: { "README.md": "# Scratch\n\nThis project will recieve messages and store them.\n" },
  },
  {
    id: "research",
    prompt: [
      "Review three modules of this project for correctness bugs, no code changes. Each is about 1,200 lines of real code from its own part of the system, and a careful review of one takes about 20 minutes; the three reviews don't depend on each other:",
      ...REVIEWED.map((module, index) => `${index + 1}) ${module.to}`),
      "For each module, list the bugs you find, each with its line and why it's wrong, or say it has none you can show.",
    ].join("\n"),
    files: Object.fromEntries(REVIEWED.map((module) => [module.to, readFileSync(join(repo, module.from), "utf8")])),
  },
  {
    id: "same-function",
    prompt: "Two changes to the function `total` in src/cart.ts: 1) round the result to two decimal places; 2) skip items whose quantity is zero.",
    files: { "src/cart.ts": "export interface Item { price: number; quantity: number }\n\nexport function total(items: Item[]): number {\n  let sum = 0\n  for (const item of items) sum += item.price * item.quantity\n  return sum\n}\n" },
  },
  {
    id: "feature",
    prompt: "Add a `priority` field (\"low\" | \"high\") to tasks: src/client.ts must send it when it creates a task, and src/server.ts must accept and store it. The two must agree on the shape.",
    files: {
      "src/client.ts": "export interface NewTask { title: string }\n\nexport async function createTask(task: NewTask): Promise<Response> {\n  return fetch(\"/tasks\", { method: \"POST\", body: JSON.stringify({ title: task.title }) })\n}\n",
      "src/server.ts": "interface Task { id: number; title: string }\nconst tasks: Task[] = []\n\nexport function handleCreate(body: string): Task {\n  const { title } = JSON.parse(body) as { title: string }\n  const task = { id: tasks.length + 1, title }\n  tasks.push(task)\n  return task\n}\n",
    },
  },
  {
    // Not in the defaults: the person asks for two Fins on one function, so only the overlap check stands between them.
    id: "forced-overlap",
    prompt: "Start two Fins, one for each of these changes to the function `total` in src/cart.ts: 1) round the result to two decimal places; 2) skip items whose quantity is zero.",
    files: { "src/cart.ts": "export interface Item { price: number; quantity: number }\n\nexport function total(items: Item[]): number {\n  let sum = 0\n  for (const item of items) sum += item.price * item.quantity\n  return sum\n}\n" },
  },
]
const TASKS = new Map(TASK_LIST.map((task) => [task.id, task]))

interface Outcome {
  harness: string
  task: string
  /** How the Apex's turn ended, or why it never ran. */
  ended: string
  fins: { name: string; createdAt: number; touches?: string[]; proceed?: string }[]
  queued: { name?: string; after?: string }[]
  refused: { refused: string; why: string }[]
  proceeds: { proceed: string; files: string }[]
  /** Seconds between the first and the last Fin's start. */
  spread?: number
  said: string
  right: boolean
  verdict: string
}

interface Verdict { right: boolean; verdict: string }

function judge(task: string, result: Omit<Outcome, "right" | "verdict">): Verdict {
  const started = result.fins.length + result.queued.length
  const sequenced = result.queued.filter((each) => each.after).length
  switch (task) {
    case "typo":
      return started === 0 ? { right: true, verdict: "did it itself" } : { right: false, verdict: `started ${started} Fin(s) for a one-word fix` }
    case "research":
      if (started >= 3 && sequenced === 0 && (result.spread ?? 0) <= 90) return { right: true, verdict: "three Fins in one turn" }
      if (started >= 3) return { right: false, verdict: `three Fins, but ${sequenced ? "sequenced" : `${result.spread}s apart`}` }
      return { right: false, verdict: started === 0 ? "did all three itself" : `started ${started} of three` }
    case "same-function":
    case "forced-overlap":
    case "feature": {
      const refusedFirst = result.refused.some((each) => each.refused === "overlap") ? "refused for overlap, then " : ""
      if (started <= 1) return { right: true, verdict: `${refusedFirst}${started ? "one Fin" : "did it itself"}` }
      if (started - sequenced <= 1) return { right: true, verdict: `${refusedFirst}${started} Fins, sequenced with after` }
      // Asked for two Fins, an Apex that was refused and started anyway saying why heard the check and answered it.
      if (task === "forced-overlap" && refusedFirst && result.proceeds.every((each) => each.proceed.length > 20)) return { right: true, verdict: `${refusedFirst}proceeded as the person asked: ${result.proceeds.map((each) => JSON.stringify(each.proceed)).join("; ")}` }
      if (result.proceeds.length) return { right: false, verdict: `${refusedFirst}two Fins at once on one ${task === "feature" ? "feature" : "function"}, proceeding: ${result.proceeds.map((each) => JSON.stringify(each.proceed)).join("; ")}` }
      return { right: false, verdict: `${started} Fins in parallel on one ${task === "feature" ? "feature" : "function"}` }
    }
  }
  return { right: false, verdict: "unknown task" }
}

/** Starts the Apex on `harness` with `task` in a fresh project, waits for its choices, stops it and its Fins, and reads what it did. */
async function runApex(harness: string, task: Task, env: NodeJS.ProcessEnv): Promise<Outcome> {
  const project = join(root, `project-${harness}-${task.id}`)
  await mkdir(project, { recursive: true })
  const git = (...args: string[]) => run("git", ["-C", project, ...args], { env })
  await git("init", "-q", "-b", "main")
  for (const [path, text] of Object.entries(task.files)) {
    await mkdir(join(project, path, ".."), { recursive: true })
    await writeFile(join(project, path), text)
  }
  await git("add", "-A")
  await git("-c", "user.name=Proof", "-c", "user.email=proof@example.com", "commit", "-qm", "Start")
  const before = hostLines().length
  const conversation = randomUUID()
  const request = randomUUID()
  const mode = FULL.get(harness)
  await call("mako:live-start", [harness, project, { conversationId: conversation, title: `${task.id} on ${harness}`, initialRequest: { id: request, text: task.prompt, attachments: [] }, ...mode && { modeId: mode }, ...models.has(harness) && { tuning: { model: models.get(harness) } } }])
  const ended = await until(`${harness}'s Apex to end its turn on ${task.id}`, async () => {
    const found = (await snapshot(conversation)).requests.find((each) => each.id === request)
    return found && ENDED.has(found.status) ? found.status : undefined
  }, apexMs).catch(() => "still working: stopped")
  // Its choices are made: nothing more is spent on its Fins or on it.
  const session = sessionOf(conversation)
  if (session) await mako(["agents", "stop", "all", "--reason", "the proof has what it needs"], { MAKO_SESSION_ID: session }).catch(() => undefined)
  await call("mako:live-cancel", [conversation]).catch(() => undefined)
  await pause(3_000)
  const thread = threadOf(conversation)
  const ops = session ? `start:${session}:` : "\0"
  const lines = hostLines().slice(before).filter((line) => line.raw.includes(ops))
  const refused = lines.filter((line) => line.raw.includes("start refused")).map((line) => ({ refused: line.fields.get("refused") ?? "", why: (line.fields.get("why") ?? line.raw).slice(0, 600) }))
  const proceeds = lines.filter((line) => line.raw.includes("start overlap proceed")).map((line) => ({ proceed: line.fields.get("proceed") ?? "", files: line.fields.get("files") ?? "" }))
  const queued = lines.filter((line) => line.raw.includes("start queued")).map((line) => {
    const after = line.fields.get("after")
    return { ...(after !== undefined && { after }) }
  })
  const fins = (thread ? edgesUnder(thread) : []).map((edge) => {
    const record = EdgeRecord.parse(JSON.parse(edge.record))
    return { name: edge.name, createdAt: edge.created_at, ...(record.asked?.touches && { touches: record.asked.touches }), ...(record.asked?.proceed && { proceed: record.asked.proceed }) }
  })
  // A queued start that later launched has an edge too: count it once, as queued.
  const launchedFromQueue = Math.min(queued.length, lines.filter((line) => line.raw.includes("start released")).length)
  const counted = fins.slice(0, fins.length - launchedFromQueue)
  const times = fins.map((fin) => fin.createdAt)
  const words = await history(conversation).catch(() => [])
  const said = words.filter((line) => line.kind === "text").map((line) => line.text ?? "").join("\n").slice(-1_500)
  await writeFile(join(out, `${harness}-${task.id}.history.json`), JSON.stringify(words.map((line) => ({ kind: line.kind, text: (line.text ?? "").slice(0, 2_000) })), null, 2))
  // Every call it made and what it thought, from the conversation's own blocks: whether it saw agents_start, looked for it, or chose not to.
  const blocks = (await snapshot(conversation).catch(() => undefined))?.blocks ?? []
  const kept = blocks.flatMap((block): Json[] => {
    if (block.type === "tool") return [{ type: "tool", name: block.name ?? null, title: block.title ?? null, status: block.status ?? null, input: (block.input ?? "").slice(0, 1_500), output: (block.output ?? "").slice(0, 1_500) }]
    return block.type === "thinking" || block.type === "text" ? [{ type: block.type, text: (block.text ?? "").slice(0, 3_000) }] : []
  })
  await writeFile(join(out, `${harness}-${task.id}.blocks.json`), JSON.stringify(kept, null, 2))
  const failure = (await snapshot(conversation).catch(() => undefined))?.requests.find((each) => each.id === request)?.error
  const result = { harness, task: task.id, ended: failure ? `${ended}: ${JSON.stringify(failure).slice(0, 300)}` : ended, fins: counted, queued, refused, proceeds, ...(times.length > 1 && { spread: Math.round((Math.max(...times) - Math.min(...times)) / 1_000) }), said }
  return { ...result, ...judge(task.id, result) }
}

const DeveloperLine = z.object({ type: z.literal("response_item"), payload: z.object({ role: z.literal("developer"), content: z.array(z.object({ text: z.string().optional() }).loose()) }).loose() }).loose()
/** The `<mako…>` entries Codex's rollouts hold, by size and whether Codex cut one: each must fit its 4,000-byte entry. */
function codexEntries(): { key: string; bytes: number; truncated: boolean }[] {
  const folder = join(home, ".codex", "sessions")
  if (!existsSync(folder)) return []
  const rollouts: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(at, entry.name))
      else if (entry.name.startsWith("rollout-")) rollouts.push(join(at, entry.name))
    }
  }
  walk(folder)
  const newest = rollouts.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  if (!newest) return []
  return readFileSync(newest, "utf8").split("\n").flatMap((line) => {
    if (!line.includes("<mako")) return []
    const parsed = DeveloperLine.safeParse((() => { try { return JSON.parse(line) } catch { return undefined } })())
    return (parsed.data?.payload.content ?? []).flatMap((part) => {
      const text = part.text?.trim() ?? ""
      const key = /^<(mako[a-z0-9_]*)>/.exec(text)?.[1]
      return key ? [{ key, bytes: Buffer.byteLength(text), truncated: /tokens truncated/.test(text) }] : []
    })
  })
}

const results: Outcome[] = []
try {
  await mkdir(out, { recursive: true })
  await mkdir(location.directory, { recursive: true, mode: 0o700 })
  const env: NodeJS.ProcessEnv = { ...scratch.env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: location.socket, MAKO_TELEMETRY: "off", MAKO_FIN_SLOTS: "8", MAKO_PROD: "1" }
  host = spawn(process.execPath, [join(repo, "packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
  let errors = ""
  host.stderr?.on("data", (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  await until("the host", async () => {
    if (host?.exitCode !== null) throw new Error(`The host exited: ${errors}`)
    return (await probeRuntime(location.socket, { timeoutMs: 500 })).state === "ready"
  }, 90_000)
  for (const harness of harnesses) for (const id of tasks) {
    const task = TASKS.get(id)
    if (!task) throw new Error(`No task ${id}: ${[...TASKS.keys()].join(", ")}`)
    const outcome = await runApex(harness, task, env).catch((error: Error): Outcome => ({ harness, task: id, ended: `didn't run: ${error.message.slice(0, 300)}`, fins: [], queued: [], refused: [], proceeds: [], said: "", right: false, verdict: "no run" }))
    results.push(outcome)
    console.log(`${harness} · ${id}: ${outcome.fins.length} started, ${outcome.queued.length} queued, ${outcome.refused.length} refused, ${outcome.proceeds.length} proceeded · ${outcome.ended} · ${outcome.right ? "RIGHT" : "WRONG"} (${outcome.verdict})`)
    await writeFile(join(out, "results.json"), JSON.stringify(results, null, 2))
  }
  if (harnesses.includes("codex")) await writeFile(join(out, "codex-entries.json"), JSON.stringify(codexEntries(), null, 2))
} finally {
  const table = [
    "| harness | task | Fins started | queued (after) | refusals | proceed reasons | turn | right? |",
    "|---|---|---:|---:|---|---|---|---|",
    ...results.map((each) => `| ${each.harness} | ${each.task} | ${each.fins.length} | ${each.queued.length} (${each.queued.filter((one) => one.after).length}) | ${each.refused.map((one) => one.refused).join(", ") || "none"} | ${each.proceeds.map((one) => JSON.stringify(one.proceed)).join("; ") || "none"} | ${each.ended.replaceAll("|", "/").slice(0, 120)} | ${each.right ? "right" : "wrong"}: ${each.verdict} |`),
  ].join("\n")
  await writeFile(join(out, "table.md"), `${table}\n`).catch(() => undefined)
  console.log(table)
  await cp(join(dataRoot, "logs"), join(out, "logs"), { recursive: true }).catch(() => undefined)
  host?.kill("SIGTERM")
  await pause(2_000)
  scratch.dispose()
  await removeScratch(root).catch(() => undefined)
}
