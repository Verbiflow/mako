import "./lib/scratch-git.mjs"
import { execFile, spawn, type ChildProcess } from "node:child_process"
import { DatabaseSync } from "node:sqlite"
import { randomUUID } from "node:crypto"
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import assert from "node:assert/strict"
import { z } from "zod"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"
import { runtimeLocation } from "@mako/host/transport/service"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { scratchHostHome } from "./scratch-harness-home.ts"

/**
 * An Apex's move for real, on a host of its own in a scratch home: real Cursor and the person's next harness, signed in
 * as the person, on a scratch project. Spends a few model calls.
 *
 *   npx tsx scripts/prove-apex-move.ts --out <folder>
 *
 * It needs Cursor's plan really out: with room on the plan, Cursor answers and it times out waiting for the refusal.
 *
 * An Apex on Cursor is sent the person's message, which Cursor really refuses. A Fin starts under it on another harness
 * and reports. Nobody presses anything: the Apex moves by itself, the person's message goes there once and is answered,
 * the Fin's report reaches it once, and the person is told once. Everything each step answered is written to `--out`.
 */
const { values } = parseArgs({ options: { out: { type: "string" }, fin: { type: "string", default: "claude" } } })
if (!values.out) throw new Error("--out <folder> says where the proof's files go")
const out = resolve(values.out)
const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const root = await mkdtemp(join(tmpdir(), "mako-prove-apex-move-"))
const scratch = scratchHostHome(root)
const dataRoot = join(root, "data")
const project = join(root, "project")
const location = runtimeLocation(dataRoot)
const THREADS = join(dataRoot, "threads.sqlite")
const CLIENT = randomUUID()
const run = promisify(execFile)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const Json = z.json()
type Json = z.infer<typeof Json>
const Answer = z.looseObject({ child: z.string().optional(), conversation: z.string().optional(), children: z.array(z.looseObject({ child: z.string(), state: z.looseObject({ kind: z.string() }) })).optional() })
const SessionState = z.looseObject({ harness: z.string(), status: z.string() })
const Row = z.looseObject({ text: z.string(), status: z.string(), retry: z.json().optional(), error: z.string().optional(), continues: z.json().optional() })
const Agent = z.looseObject({ child: z.looseObject({ limitNotice: z.looseObject({ line: z.string() }).optional() }).optional() })
const Snapshot = z.looseObject({ requests: z.array(Row), nativeAgents: z.looseObject({ agents: z.array(Agent) }).optional() })
const HistoryLine = z.looseObject({ kind: z.string(), text: z.string().optional() })
const steps: { step: string; at: string; answer: Json }[] = []
const note = async (step: string, answer: Json) => {
  steps.push({ step, at: new Date().toISOString(), answer })
  console.log(`${step}: ${JSON.stringify(answer).slice(0, 400)}`)
  await writeFile(join(out, "steps.json"), JSON.stringify(steps, null, 2))
}
let host: ChildProcess | undefined

function sessionOf(conversation: string): string | undefined {
  const store = new DatabaseSync(THREADS, { readOnly: true })
  try {
    return z.object({ session_id: z.string() }).safeParse(store.prepare("SELECT session_id FROM journals WHERE conversation_id = ?").get(conversation)).data?.session_id
  } finally {
    store.close()
  }
}

async function until<T>(what: string, read: () => Promise<T | undefined>, timeoutMs = 240_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  let failed: Error | undefined
  for (;;) {
    const value = await read().catch((error: Error) => {
      failed = error
      return undefined
    })
    if (value) return value
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`, { cause: failed })
    await pause(1_000)
  }
}

try {
  await mkdir(out, { recursive: true })
  await Promise.all([mkdir(project, { recursive: true }), mkdir(location.directory, { recursive: true, mode: 0o700 })])
  const env: NodeJS.ProcessEnv = { ...scratch.env, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: location.socket, MAKO_TELEMETRY: "off", MAKO_FIN_SLOTS: "8", MAKO_PROD: "1" }
  const git = (...args: string[]) => run("git", ["-C", project, ...args], { env })
  await git("init", "-q", "-b", "main")
  await writeFile(join(project, "README.md"), "A scratch project for a move's proof.\n")
  await git("add", "-A")
  await git("-c", "user.name=Proof", "-c", "user.email=proof@example.com", "commit", "-qm", "Start")
  host = spawn(process.execPath, [join(repo, "packages/host/dist/mako-host.js")], { env, stdio: ["ignore", "ignore", "pipe"] })
  let errors = ""
  host.stderr?.on("data", (data: Buffer) => (errors = (errors + data.toString()).slice(-4_000)))
  await until("the host", async () => {
    assert.ok(host?.exitCode === null, `The host exited: ${errors}`)
    return (await probeRuntime(location.socket, { timeoutMs: 500 })).state === "ready"
  }, 60_000)
  const mako = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, [cli, "--socket", location.socket, "--json", ...args], { env, maxBuffer: 64 * 1024 * 1024 })
    return stdout.trim().split("\n").filter(Boolean).map((line) => Json.parse(JSON.parse(line)))
  }
  const call = (channel: string, args: unknown[]) => invokeRuntime(location.socket, CLIENT, channel, args)
  const word = `amber-${randomUUID().slice(0, 8)}`
  const ask = `Reply with this code word and nothing else: ${word}. When a Fin's report reaches you, reply with the single word heard.`
  // A refused turn fails the command, which is the point: its first line still names the conversation.
  const firstTurn = await run(process.execPath, [cli, "--socket", location.socket, "--json", "start", "cursor", ask, "--cwd", project], { env, maxBuffer: 64 * 1024 * 1024 }).catch((failure: Error) => z.looseObject({ stdout: z.string() }).parse(failure))
  const apex = z.object({ conversationId: z.string() }).parse(JSON.parse(firstTurn.stdout.split("\n")[0]!)).conversationId
  const state = async () => SessionState.parse(await call("mako:live-state", [apex]))
  const snapshot = async () => Snapshot.parse(await call("mako:live-snapshot", [apex]))
  const session = await until("the Apex's Session", async () => sessionOf(apex))
  const refused = await until("Cursor to refuse it, which it does only while its plan is out", async () => {
    const row = (await snapshot()).requests.find((request) => request.text.includes(word) && (request.status === "failed" || (request.status === "held" && request.retry)))
    return row && { status: row.status, error: row.error ?? "", retry: row.retry ?? null, waits: (await snapshot()).requests.filter((request) => request.status === "held").length }
  }, 120_000)
  await note("Cursor refused the person's message, for real", refused)
  assert.match(JSON.stringify(refused), /usage limit/i)
  assert.equal((await state()).harness, "cursor", "with no Fins open it stays, for the person to decide")
  await note("the card's offer, with no Fins open", Json.parse(await call("mako:agents-next-place", [apex])))

  const brief = join(root, "brief.txt")
  await writeFile(brief, "Reply in one line that you're here, then call agents_report with status done and the words proof finished.")
  const { stdout } = await run(process.execPath, [cli, "agents", "start", values.fin!, "--brief-file", brief, "--name", "proof", "--key", "start", "--socket", location.socket, "--cwd", project, "--json"], { env: { ...env, MAKO_SESSION_ID: session }, maxBuffer: 64 * 1024 * 1024 })
  const started = Answer.parse(JSON.parse(stdout))
  await note(`a Fin started on ${values.fin}`, Json.parse(stdout))
  assert.ok(started.child, stdout)

  const landed = await until("the Apex to move by itself", async () => {
    const now = await state()
    return now.harness !== "cursor" ? now : undefined
  })
  await note("the Apex moved, with nobody pressing anything", { harness: landed.harness })
  const answered = await until("the person's message answered there", async () => {
    const history = (await mako("history", apex)).map((line) => HistoryLine.parse(line))
    return history.find((line) => line.kind !== "user" && line.text?.includes(word))
  })
  await note("the person's message was answered", answered.text ?? "")
  const heard = await until("the Fin's report", async () => {
    const history = (await mako("history", apex)).map((line) => HistoryLine.parse(line))
    return history.find((line) => line.kind === "user" && line.text?.includes(FROM_AGENTS) && line.text.includes('"proof"'))
  })
  await note("the Apex heard its Fin", heard.text ?? "")
  const notice = await until("the notice", async () => (await snapshot()).nativeAgents?.agents.flatMap((agent) => agent.child?.limitNotice ?? []).at(0), 30_000)
  await note("the person is told", notice.line)
  assert.match(notice.line, /^Cursor.* ran out .*This Thread moved to /)
  const rows = (await snapshot()).requests
  await note("every request", rows.map((request) => ({ text: request.text.slice(0, 80), status: request.status })))
  assert.equal(rows.filter((request) => request.text.includes(word)).length, 1, "the person's message is one row")
  const history = (await mako("history", apex)).map((line) => HistoryLine.parse(line))
  assert.equal(history.filter((line) => line.kind === "user" && line.text?.includes(FROM_AGENTS) && line.text.includes('"proof"')).length, 1, "the report went once")
  await writeFile(join(out, "apex-history.jsonl"), history.map((line) => JSON.stringify(line)).join("\n"))
  console.log(`PROVED: an Apex on Cursor, refused for real, moved itself to ${landed.harness}, answered ${word} and heard its Fin once`)
} finally {
  await cp(join(dataRoot, "logs"), join(out, "logs"), { recursive: true }).catch(() => undefined)
  host?.kill("SIGTERM")
  await pause(1_000)
  scratch.dispose()
  await removeScratch(root).catch(() => undefined)
}
