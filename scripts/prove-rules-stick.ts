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
import { POLICY } from "@mako/host/contracts/primer"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { scratchHostHome } from "./scratch-harness-home.ts"

/**
 * Mako's rules on real harnesses and real models, on a host of its own in a scratch home signed in as the person, on a
 * scratch project. Spends model calls on every harness it names.
 *
 *   npx tsx scripts/prove-rules-stick.ts --out <folder> [--harnesses claude,codex,grok,devin,cursor] [--steps denies,grok,report,split]
 *
 * - denies: each harness's Thread is asked to run a nohup'd agent CLI and `gh pr checks --watch`. Each is refused
 *   before it runs (the CLI's log file never appears), the host logs the deny, and the agent reads the call to make.
 *   Codex's rollout holds Mako's instructions as whole entries; Claude's transcript defers none of the tools Mako
 *   loads always.
 * - grok: Grok, which cuts a server's instructions at about 2,047 characters, quotes the wait rule and the
 *   agents_start rule from them word for word.
 * - report: a Fin on each harness is briefed to answer without calling a tool. Its turn ends without agents_report,
 *   Mako asks it once, and it reports.
 * - split: an Apex on Claude and one on Codex get a three-part task where the third part needs the first: the two
 *   independent parts start together, the third with after.
 *
 * Every step's answer, the host's log lines and each harness's transcript go to `--out`.
 */
const { values } = parseArgs({ options: {
  out: { type: "string" },
  harnesses: { type: "string", default: "claude,codex,grok,devin,cursor" },
  steps: { type: "string", default: "denies,grok,report,split" },
  "split-harnesses": { type: "string", default: "claude,codex" },
} })
if (!values.out) throw new Error("--out <folder> says where the proof's files go")
const out = resolve(values.out)
const harnesses = values.harnesses!.split(",").filter(Boolean)
const steps = new Set(values.steps!.split(","))
const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const root = await mkdtemp(join(tmpdir(), "mako-prove-rules-"))
const scratch = scratchHostHome(root)
const home = scratch.home
const dataRoot = join(root, "data")
const project = join(root, "project")
const location = runtimeLocation(dataRoot)
const THREADS = join(dataRoot, "threads.sqlite")
const HOST_LOG = join(dataRoot, "logs", "host.log")
const CLIENT = randomUUID()
const run = promisify(execFile)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))

/** Each harness's mode for full access, as its live driver names it. */
const FULL: Record<string, string | undefined> = { claude: "bypassPermissions", codex: "access:full", grok: "access:full", devin: "bypass", opencode: "access:full", cursor: undefined }

const Json = z.json()
type Json = z.infer<typeof Json>
const findings: { step: string; harness?: string; ok: boolean; evidence: Json }[] = []
async function found(step: string, harness: string | undefined, ok: boolean, evidence: Json): Promise<void> {
  findings.push({ step, ...harness && { harness }, ok, evidence })
  console.log(`${ok ? "PROVED" : "NOT PROVED"} ${step}${harness ? ` on ${harness}` : ""}: ${JSON.stringify(evidence).slice(0, 600)}`)
  await writeFile(join(out, "findings.json"), JSON.stringify(findings, null, 2))
}

async function until<T>(what: string, read: () => Promise<T | undefined> | T | undefined, timeoutMs = 300_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let failed: unknown
  for (;;) {
    const value = await Promise.resolve().then(read).catch((error: unknown) => {
      failed = error
      return undefined
    })
    if (value !== undefined && value !== false) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`, { cause: failed })
    await pause(2_000)
  }
}

const LogLine = z.looseObject({ scope: z.string().optional(), message: z.string().optional(), fields: z.record(z.string(), z.json()).optional() })
type LogLine = z.infer<typeof LogLine>
/** The host's log as JSON lines; a line that isn't one is skipped. */
function hostLines(): (LogLine & { raw: string })[] {
  if (!existsSync(HOST_LOG)) return []
  return readFileSync(HOST_LOG, "utf8").split("\n").flatMap((raw) => {
    try {
      const parsed = LogLine.safeParse(JSON.parse(raw))
      return parsed.success ? [{ ...parsed.data, raw }] : []
    } catch {
      return raw.trim() ? [{ raw }] : []
    }
  })
}
const mentions = (line: { raw: string }, ...words: string[]) => words.every((word) => line.raw.includes(word))

function store<T>(read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(THREADS, { readOnly: true })
  try {
    return read(db)
  } finally {
    db.close()
  }
}
const sessionOf = (conversation: string) => store((db) => z.object({ session_id: z.string() }).safeParse(db.prepare("SELECT session_id FROM journals WHERE conversation_id = ?").get(conversation)).data?.session_id)
const threadOf = (conversation: string) => store((db) => z.object({ thread_id: z.string() }).safeParse(db.prepare("SELECT m.thread_id FROM journals j JOIN memberships m ON m.session_id = j.session_id WHERE j.conversation_id = ?").get(conversation)).data?.thread_id)
const Edge = z.object({ child_thread: z.string(), name: z.string(), record: z.string(), created_at: z.number() })
const edgesUnder = (thread: string) => store((db) => z.array(Edge).parse(db.prepare("SELECT child_thread, name, record, created_at FROM thread_parents WHERE parent_thread = ? ORDER BY created_at").all(thread)))
const Report = z.object({ id: z.string(), record: z.string(), at: z.number() })
const reportsOf = (child: string) => store((db) => z.array(Report).parse(db.prepare("SELECT id, record, at FROM thread_reports WHERE child_thread = ? ORDER BY at").all(child))).map((row): Record<string, Json> & { id: string; at: number } => ({ ...z.record(z.string(), Json).parse(JSON.parse(row.record)), id: row.id, at: row.at }))
const conversationsOfThread = (thread: string) => store((db) => z.array(z.object({ conversation_id: z.string() })).parse(db.prepare("SELECT j.conversation_id FROM journals j JOIN memberships m ON m.session_id = j.session_id WHERE m.thread_id = ? ORDER BY j.created_at").all(thread))).map((row) => row.conversation_id)

let host: ChildProcess | undefined
const call = (channel: string, args: unknown[]) => invokeRuntime(location.socket, CLIENT, channel, args)
const mako = async (args: string[], env?: NodeJS.ProcessEnv) => {
  const { stdout } = await run(process.execPath, [cli, ...args, "--socket", location.socket, "--json"], { env: { ...scratch.env, ...env }, maxBuffer: 64 * 1024 * 1024 })
  return stdout.trim().split("\n").filter(Boolean).map((line) => Json.parse(JSON.parse(line)))
}
const HistoryLine = z.looseObject({ kind: z.string(), text: z.string().optional() })
const history = async (conversation: string) => (await mako(["history", conversation])).map((line) => HistoryLine.parse(line))

const Snapshot = z.looseObject({ requests: z.array(z.looseObject({ id: z.string(), status: z.string() })).default([]) })
const snapshot = async (conversation: string) => Snapshot.parse(await call("mako:live-snapshot", [conversation]))
/** Each Thread's first request, by its conversation. */
const firstRequest = new Map<string, string>()

/** A Thread of the person's on `harness`, its first message `text`, on full access. */
async function startThread(harness: string, text: string, title: string): Promise<string> {
  const conversationId = randomUUID()
  const request = randomUUID()
  firstRequest.set(conversationId, request)
  const mode = FULL[harness]
  await call("mako:live-start", [harness, project, { conversationId, title, initialRequest: { id: request, text, attachments: [] }, ...mode && { modeId: mode } }])
  return conversationId
}

const ENDED = new Set(["completed", "failed", "canceled", "interrupted", "uncertain"])
/** Waits for the conversation's first request (or `request`) to end, and then for nothing else in it to be at work. */
async function settled(conversation: string, what: string, timeoutMs = 600_000, request = firstRequest.get(conversation)): Promise<string> {
  const status = await until(`${what} to end its turn`, async () => {
    const found = (await snapshot(conversation)).requests.find((each) => each.id === request)
    return found && ENDED.has(found.status) ? found.status : undefined
  }, timeoutMs)
  await until(`${what} to settle`, async () => (await snapshot(conversation)).requests.every((each) => ENDED.has(each.status) || each.status === "held") ? true : undefined, timeoutMs).catch(() => undefined)
  return status
}

/** Files under `folder` whose name matches, newest first. */
function filesUnder(folder: string, match: (name: string) => boolean): string[] {
  if (!existsSync(folder)) return []
  const found: string[] = []
  const walk = (at: string) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (match(entry.name)) found.push(path)
    }
  }
  walk(folder)
  return found.toSorted((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

const DeveloperLine = z.object({ type: z.literal("response_item"), payload: z.object({ role: z.literal("developer"), content: z.array(z.object({ text: z.string().optional() }).loose()) }).loose() }).loose()
/** The `<mako_…>` entries a Codex rollout holds, each with its size and whether Codex cut it. */
function codexEntries(rollout: string): { key: string; bytes: number; truncated: boolean; text: string }[] {
  return readFileSync(rollout, "utf8").split("\n").flatMap((line) => {
    if (!line.includes("<mako")) return []
    const parsed = DeveloperLine.safeParse((() => { try { return JSON.parse(line) } catch { return undefined } })())
    if (!parsed.success) return []
    return parsed.data.payload.content.flatMap((part) => {
      const text = part.text?.trim() ?? ""
      const key = /^<(mako[a-z0-9_]*)>/.exec(text)?.[1]
      return key ? [{ key, bytes: Buffer.byteLength(text), truncated: /tokens truncated/.test(text), text }] : []
    })
  })
}

const DENY_PROMPT = (dir: string) => [
  "This is a check of how Mako routes shell commands. Run each of these two shell commands exactly as written, one at a time, and after each say in one line what your shell tool returned. Don't run anything else in their place.",
  `1) nohup claude -p 'Say hi' > ${dir}/cli.log 2>&1 &`,
  "2) gh pr checks 1 --watch",
].join("\n")

try {
  await mkdir(out, { recursive: true })
  await Promise.all([mkdir(project, { recursive: true }), mkdir(location.directory, { recursive: true, mode: 0o700 })])
  const env: NodeJS.ProcessEnv = { ...scratch.env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: location.socket, MAKO_TELEMETRY: "off", MAKO_FIN_SLOTS: "8", MAKO_PROD: "1" }
  const git = (...args: string[]) => run("git", ["-C", project, ...args], { env })
  await git("init", "-q", "-b", "main")
  await writeFile(join(project, "README.md"), "A scratch project for a proof of Mako's rules.\n")
  await git("add", "-A")
  await git("-c", "user.name=Proof", "-c", "user.email=proof@example.com", "commit", "-qm", "Start")
  host = spawn(process.execPath, [join(repo, "packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
  let errors = ""
  host.stderr?.on("data", (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  await until("the host", async () => {
    if (host?.exitCode !== null) throw new Error(`The host exited: ${errors}`)
    return (await probeRuntime(location.socket, { timeoutMs: 500 })).state === "ready"
  }, 90_000)

  // ── denies ──
  const threads = new Map<string, string>()
  if (steps.has("denies")) for (const harness of harnesses) {
    const dir = join(root, `deny-${harness}`)
    await mkdir(dir, { recursive: true })
    // The host's lines from this run on: Grok's name its session, Cursor's its owner, the rest the conversation.
    const before = hostLines().length
    const conversation = await startThread(harness, DENY_PROMPT(dir), `Routing check on ${harness}`)
    threads.set(harness, conversation)
    const ended = await settled(conversation, `${harness}'s routing check`).catch((error: Error) => error.message)
    const denied = hostLines().slice(before).filter((line) => mentions(line, "native call denied"))
    const rules = denied.map((line) => String(line.fields?.rule ?? /\brule=(\S+)/.exec(line.raw)?.[1] ?? /native call denied: \S+ (\S+)/.exec(line.raw)?.[1] ?? ""))
    const said = (await history(conversation).catch(() => [])).filter((line) => line.kind === "text" || line.kind === "tool").map((line) => line.text ?? "")
    await writeFile(join(out, `denies-${harness}.history.json`), JSON.stringify(said, null, 2))
    await found("a nohup'd agent CLI is refused before it runs, naming agents_start", harness, rules.some((rule) => rule.startsWith("agent-cli")) && !existsSync(join(dir, "cli.log")), { ended, rules, cliLogWritten: existsSync(join(dir, "cli.log")), lines: denied.map((line) => line.raw) })
    await found("gh pr checks --watch is refused before it runs, naming wait", harness, rules.includes("gh-watch"), { rules, reply: said.filter((text) => /agents_start|wait\(|wait\b/.test(text)).slice(-4) })
  }

  // Codex: its rollout holds every entry whole.
  if (steps.has("denies") && threads.has("codex")) {
    const rollouts = filesUnder(join(home, ".codex", "sessions"), (name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
    const rollout = rollouts.find((path) => codexEntries(path).length > 0)
    const entries = rollout ? codexEntries(rollout) : []
    if (rollout) await cp(rollout, join(out, "codex-rollout.jsonl"))
    const whole = entries.map((entry) => entry.text).join("\n")
    await found("Codex's rollout holds Mako's instructions whole, an entry per block", "codex", entries.length >= 3 && entries.every((entry) => !entry.truncated && entry.bytes <= 4_100) && whole.includes(POLICY.split("\n")[0]!) && whole.includes("call `agents_report`") && whole.includes("never gh --watch"), {
      rollout: rollout ?? null, entries: entries.map(({ key, bytes, truncated }) => ({ key, bytes, truncated })),
      holds: { policy: whole.includes(POLICY.split("\n")[0]!), finReport: whole.includes("call `agents_report`"), prWait: whole.includes("never gh --watch"), subagents: whole.includes("not your harness's own subagent tool") },
    })
  }

  // Claude: none of the tools Mako always loads is deferred.
  if (steps.has("denies") && threads.has("claude")) {
    const transcripts = filesUnder(join(home, ".claude", "projects"), (name) => name.endsWith(".jsonl"))
    const deferred = new Set<string>()
    for (const transcript of transcripts) for (const line of readFileSync(transcript, "utf8").split("\n")) {
      if (!line.includes("deferred_tools_delta")) continue
      for (const name of /"addedNames":\[([^\]]*)\]/.exec(line)?.[1]?.match(/"([^"]+)"/g) ?? []) deferred.add(name.slice(1, -1))
    }
    const makoDeferred = [...deferred].filter((name) => name.startsWith("mcp__mako__"))
    const always = ["agents_start", "agents_report", "agents_send", "wait"].map((tool) => `mcp__mako__${tool}`)
    await found("Claude defers none of agents_start, agents_send and wait behind its tool search", "claude", transcripts.length > 0 && always.every((name) => !deferred.has(name)), { transcripts: transcripts.length, makoDeferred, alwaysLoadedDeferred: always.filter((name) => deferred.has(name)) })
  }

  // ── grok: what reaches its model of the mako server's instructions, which it cuts at about 2,047 characters ──
  if (steps.has("grok")) {
    const asked = "Without calling any tool, quote word for word, each on its own line: the line of the mako MCP server's instructions that begins with \"wait:\", and the sentence of them that begins with \"Parallel, background\". If you can't see one, say so."
    const conversation = await startThread("grok", asked, "Grok's cut")
    await settled(conversation, "Grok's quote")
    const said = (await history(conversation)).filter((line) => line.kind === "text").map((line) => line.text ?? "").join("\n")
    await writeFile(join(out, "grok-cut.txt"), said)
    await found("Grok's model reads the wait rule and the agents_start rule inside its cut", "grok", said.includes("Never poll or sleep.") && said.includes("not your harness's own subagent tool"), { said: said.slice(0, 1200) })
  }

  // ── report ──
  if (steps.has("report")) {
    const apex = threads.get("claude") ?? await startThread("claude", "Reply with the single word ready.", "Report check Apex")
    await settled(apex, "the report check's Apex")
    const session = await until("the Apex's Session", () => sessionOf(apex), 60_000)
    const apexThread = await until("the Apex's Thread", () => threadOf(apex), 60_000)
    const brief = join(root, "brief.txt")
    await writeFile(brief, "Reply with one short sentence saying you're here. In this reply, don't call any tool.")
    for (const harness of harnesses) {
      const name = `here-${harness}`
      const started = await mako(["agents", "start", harness, "--brief-file", brief, "--name", name, "--key", name, "--cwd", project], { MAKO_SESSION_ID: session })
      const edge = await until(`fin:${name} to start`, () => edgesUnder(apexThread).find((row) => row.name === name), 120_000)
      const reported = await until(`fin:${name} to report`, () => reportsOf(edge.child_thread).find((report) => report.implicit !== true && report.status !== "progress"), 600_000).catch(() => undefined)
      const asked = hostLines().filter((line) => mentions(line, "asked to report") && line.raw.includes(edge.child_thread.slice(0, 8)) || mentions(line, "asked to report", ...conversationsOfThread(edge.child_thread).slice(0, 1)))
      const reports = reportsOf(edge.child_thread)
      await writeFile(join(out, `report-${harness}.json`), JSON.stringify({ started, reports, asked: asked.map((line) => line.raw) }, null, 2))
      const firstConversation = conversationsOfThread(edge.child_thread)[0]
      const said = firstConversation ? (await history(firstConversation).catch(() => [])).map((line) => ({ kind: line.kind, text: (line.text ?? "").slice(0, 400) })) : []
      await writeFile(join(out, `report-${harness}.history.json`), JSON.stringify(said, null, 2))
      await found("a Fin that ends its turn without agents_report is asked once and reports", harness, reported !== undefined && asked.length > 0 && reports.filter((report) => report.implicit === true).length === 0, {
        asked: asked.map((line) => line.raw.slice(0, 300)), reports: reports.map((report) => ({ status: report.status ?? null, implicit: report.implicit ?? false, unfinished: report.unfinished ?? false, summary: String(report.summary ?? "").slice(0, 200) })),
      })
    }
  }

  // ── split ──
  if (steps.has("split")) for (const harness of values["split-harnesses"]!.split(",").filter(Boolean)) {
    const task = [
      "Three pieces of work for this project, each for a Fin of yours:",
      "1) write notes/primes.md listing the first five prime numbers, one per line;",
      "2) write notes/colors.md listing three colours, one per line;",
      "3) write notes/summary.md whose one line is the largest number in notes/primes.md.",
      "Tell me in one line when all three are done.",
    ].join("\n")
    const before = hostLines().length
    const apex = await startThread(harness, task, `Split check on ${harness}`)
    const apexThread = await until(`${harness}'s Apex Thread`, () => threadOf(apex), 120_000)
    // The starts as the host took them: two together, the third queued after the first.
    await until(`${harness}'s Apex to start three Fins`, () => {
      const starts = hostLines().slice(before).filter((line) => (mentions(line, "start admitted") || mentions(line, "start queued")))
      return edgesUnder(apexThread).length + starts.filter((line) => mentions(line, "start queued") && line.raw.includes("after")).length >= 3 ? true : undefined
    }, 600_000).catch(() => undefined)
    await until(`${harness}'s Apex to say all three are done`, async () => {
      const said = await history(apex)
      const idle = (await snapshot(apex)).requests.every((each) => ENDED.has(each.status) || each.status === "held")
      const fins = edgesUnder(apexThread)
      const finished = fins.length >= 3 && fins.every((edge) => reportsOf(edge.child_thread).some((report) => report.status === "done" || report.status === "failed"))
      return said.filter((line) => line.kind === "text").length > 0 && finished && idle ? true : undefined
    }, 900_000).catch(() => undefined)
    const edges = edgesUnder(apexThread).map((edge) => {
      const record = JSON.parse(edge.record) as { asked?: { after?: Json }; createdAt?: number }
      return { name: edge.name, createdAt: edge.created_at, after: record.asked?.after ?? null }
    })
    const queued = hostLines().slice(before).filter((line) => mentions(line, "start queued") && line.raw.includes("after")).map((line) => line.raw)
    const released = hostLines().slice(before).filter((line) => mentions(line, "start released")).map((line) => line.raw)
    const toolCalls = (await history(apex).catch(() => [])).filter((line) => line.kind === "tool" && /agents_start/.test(line.text ?? "")).map((line) => (line.text ?? "").slice(0, 500))
    await writeFile(join(out, `split-${harness}.json`), JSON.stringify({ edges, queued, released, toolCalls }, null, 2))
    const independent = edges.filter((edge) => edge.after === null)
    const together = independent.length >= 2 && Math.abs(independent[0]!.createdAt - independent[1]!.createdAt) < 60_000
    await found("an Apex starts the two independent parts together and the dependent one with after", harness, together && (edges.some((edge) => edge.after !== null) || queued.length > 0), { edges, queued: queued.map((line) => line.slice(0, 300)), toolCalls })
  }
} finally {
  await cp(join(dataRoot, "logs"), join(out, "logs"), { recursive: true }).catch(() => undefined)
  await cp(join(home, ".codex", "sessions"), join(out, "codex-sessions"), { recursive: true }).catch(() => undefined)
  await cp(join(home, ".claude", "projects"), join(out, "claude-projects"), { recursive: true }).catch(() => undefined)
  host?.kill("SIGTERM")
  await pause(2_000)
  scratch.dispose()
  await removeScratch(root).catch(() => undefined)
  const failed = findings.filter((finding) => !finding.ok)
  console.log(`${findings.length - failed.length} of ${findings.length} proved${failed.length ? `; not proved: ${failed.map((finding) => `${finding.step}${finding.harness ? ` (${finding.harness})` : ""}`).join("; ")}` : ""}`)
}
