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
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { FROM_AGENTS } from "@mako/host/conversations/agent-wakes"
import { removeScratch } from "./lib/scratch-processes.mjs"
import { scratchHostHome } from "./scratch-harness-home.ts"

/**
 * `agents_move` for real, on a host of its own in a scratch home: real Codex, Cursor and Claude Code, signed in as the
 * person, on a scratch project. Spends a few model calls.
 *
 *   npx tsx scripts/prove-fin-move.ts --out <folder> [--app <Mako.app's executable>] [--direct]
 *
 * It needs Cursor's plan really out, and sends Cursor real prompts: with room on the plan, Cursor answers and it times
 * out waiting for the refusal. `--direct` leaves Cursor out of it, moving the Fin from Codex to Claude Code.
 *
 * A Fin does a turn on Codex and is told a code word. It moves to Cursor, whose plan is genuinely out, and a message to
 * it is refused there, as a second is, which is Cursor really running out: each is tried, fails, and leaves a turn to go on. `mako agents move` takes it to Claude Code: the same
 * Thread, name, edge, worktree and branch; what waited arrives once; Claude Code answers from the turn on Codex, which it
 * never saw; and its report reaches its Apex. Nothing runs on the Fin's first harness or on Cursor after the move, and everything each step
 * answered is written to `--out`, with the Fin's transcript.
 */
const { values } = parseArgs({ options: { out: { type: "string" }, app: { type: "string" }, direct: { type: "boolean" } } })
if (!values.out) throw new Error("--out <folder> says where the proof's files go")
const out = resolve(values.out)
const repo = resolve(import.meta.dirname, "..")
const cli = join(repo, "packages/client/dist/cli.js")
const root = await mkdtemp(join(tmpdir(), "mako-prove-fin-move-"))
const scratch = scratchHostHome(root)
const dataRoot = join(root, "data")
const project = join(root, "project")
const location = runtimeLocation(dataRoot)
const THREADS = join(dataRoot, "threads.sqlite")
const CLIENT = randomUUID()
const JOURNAL_SESSION = "SELECT session_id FROM journals WHERE conversation_id = ?"
const run = promisify(execFile)
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms))
const Json = z.json()
type Json = z.infer<typeof Json>
const Answer = z.looseObject({ child: z.string().optional(), conversation: z.string().optional(), name: z.string().optional(), children: z.array(z.looseObject({ child: z.string(), name: z.string(), harness: z.string(), state: z.looseObject({ kind: z.string() }), report: z.looseObject({ line: z.string() }).optional() })).optional(), moved: z.array(z.looseObject({ state: z.string() })).optional(), whole: z.string().optional(), truncated: z.boolean().optional() })
const SessionState = z.looseObject({ harness: z.string(), cwd: z.string(), status: z.string() })
const Row = z.looseObject({ text: z.string(), status: z.string(), retry: z.json().optional(), error: z.string().optional(), failure: z.string().optional(), context: z.array(z.json()).optional(), nativeDelivery: z.looseObject({ evidence: z.looseObject({ kind: z.string() }) }).optional() })
const Snapshot = z.looseObject({ session: z.looseObject({ status: z.string() }), requests: z.array(Row), control: z.looseObject({ bindings: z.array(z.looseObject({ provider: z.string(), nativeId: z.string().optional() })), transfers: z.array(z.looseObject({ actor: z.looseObject({ kind: z.string() }).optional(), input: z.looseObject({ provider: z.string() }), state: z.looseObject({ kind: z.string() }) })) }) })
const HistoryLine = z.looseObject({ kind: z.string(), text: z.string().optional() })
const Refusal = z.looseObject({ stdout: z.string().optional(), message: z.string() })
const steps: { step: string; at: string; answer: Json }[] = []
const note = async (step: string, answer: Json) => {
  steps.push({ step, at: new Date().toISOString(), answer })
  console.log(`${step}: ${JSON.stringify(answer).slice(0, 400)}`)
  await writeFile(join(out, "steps.json"), JSON.stringify(steps, null, 2))
}
let host: ChildProcess | undefined

/** A conversation's Session in the host's Thread store: what `MAKO_SESSION_ID` says in its shell. */
function storeRow(conversation: string): string | undefined {
  const store = new DatabaseSync(THREADS, { readOnly: true })
  try {
    return z.object({ session_id: z.string() }).safeParse(store.prepare(JOURNAL_SESSION).get(conversation)).data?.session_id
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
  await git("branch", "proof/fin")
  const command = values.app
    ? hostCommand({ executable: values.app, args: [], env })
    : { executable: process.execPath, args: [join(repo, "packages/host/dist/mako-host.js")], env }
  host = spawn(command.executable, command.args, { env: command.env, stdio: ["ignore", "ignore", "pipe"] })
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
  const opened = await mako("start", "claude", "You're the Apex of a short proof. Reply with the single word ready, and only that. When a Fin's report reaches you, reply with the single word heard.", "--cwd", project, "--detach")
  const apex = z.object({ conversationId: z.string() }).parse(opened[0]).conversationId
  const call = (channel: string, args: unknown[]) => invokeRuntime(location.socket, CLIENT, channel, args)
  const session = await until("the Apex's Session", async () => storeRow(apex))
  await until("the Apex's first turn", async () => {
    return SessionState.parse(await call("mako:live-state", [apex])).status === "ready"
  }, 90_000)
  await call("mako:live-mode", [apex, "bypassPermissions"])
  const agents = async (...args: string[]) => {
    const { stdout } = await run(process.execPath, [cli, "agents", ...args, "--socket", location.socket, "--cwd", project, "--json"], { env: { ...env, MAKO_SESSION_ID: session }, maxBuffer: 64 * 1024 * 1024 }).catch((failure: Error) => {
      const refused = Refusal.parse(failure)
      return { stdout: refused.stdout ?? JSON.stringify({ failed: refused.message }) }
    })
    return Answer.parse(JSON.parse(stdout))
  }
  const word = `amber-${randomUUID().slice(0, 8)}`
  const briefFile = join(root, "brief.txt")
  await writeFile(briefFile, `Your code word is ${word}. Don't write it to a file. Create notes.txt saying "first turn", then end your turn: reply in one line that you did.`)
  const started = await agents("start", "codex", "--brief-file", briefFile, "--name", "proof", "--worktree", "--branch", "proof/fin", "--access", "full", "--key", "start")
  await note("start on Codex", Json.parse(started))
  assert.ok(started.child, JSON.stringify(started))
  const child = started.child!
  const fin = async () => (await agents("list")).children?.find((strip) => strip.child === child)
  await until("its first turn's end", async () => {
    const strip = await fin()
    return strip?.state.kind === "ended" || strip?.state.kind === "idle" ? strip : undefined
  })
  const conversation = started.conversation!
  const state = async () => SessionState.parse(await call("mako:live-state", [conversation]))
  const before = await state()
  await note("after its turn on Codex", { harness: before.harness, cwd: before.cwd })
  assert.equal(before.harness, "codex")
  const branch = async () => (await run("git", ["-C", before.cwd, "branch", "--show-current"], { env })).stdout.trim()
  const onBranch = await branch()

  const asked = "What was your code word? Reply with it and nothing else, then call agents_report with status done and that word."
  const second = "Then write queued-once.txt saying done, with no reply of your own about it."
  if (!values.direct) {
    const toCursor = await agents("move", "proof", "cursor", "--key", "to-cursor")
    await note("move to Cursor", Json.parse(toCursor))
    assert.equal(toCursor.moved?.[0]?.state, "moved", JSON.stringify(toCursor))
    assert.equal((await state()).harness, "cursor")

    const sent = await agents("send", "proof", asked, "--key", "asked")
    await note("message to the Fin on Cursor", Json.parse(sent))
    const refusal = await until("Cursor to refuse it, which it does only while its plan is out", async () => {
      const held = Snapshot.parse(await call("mako:live-snapshot", [conversation]))
      const row = held.requests.find((request) => request.text.includes("code word") && (request.status === "failed" || (request.status === "held" && request.retry)))
      return row && { status: row.status, error: row.error ?? "", failure: row.failure ?? "", evidence: row.nativeDelivery?.evidence.kind ?? "", session: held.session.status }
    }, 120_000)
    await note("Cursor refused it, for real", refusal)
    assert.match(JSON.stringify(refusal), /usage limit/i)

    // Mako has no message to hold back: a harness out of usage says so only when it's asked.
    const queued = await agents("send", "proof", second, "--key", "queued")
    await note("a second message", Json.parse(queued))
    // A Fin at work doesn't move, so its turn on Cursor has to end first, which it does the moment Cursor refuses it.
    await until("Cursor to refuse the second", async () => {
      const held = Snapshot.parse(await call("mako:live-snapshot", [conversation]))
      return held.requests.some((request) => request.text.includes("queued-once.txt") && request.status === "failed") && held.session.status !== "running"
    }, 120_000)

  }

  const toClaude = await agents("move", "proof", "claude", "--key", "to-claude")
  await note("move to Claude Code", Json.parse(toClaude))
  assert.equal(toClaude.moved?.[0]?.state, "moved", JSON.stringify(toClaude))
  if (values.direct) {
    await note("message after the move", Json.parse(await agents("send", "proof", asked, "--key", "asked")))
    await note("a second message", Json.parse(await agents("send", "proof", second, "--key", "queued")))
  }
  const after = await state()
  await note("after the move", { harness: after.harness, cwd: after.cwd })
  assert.equal(after.harness, "claude")
  assert.equal(after.cwd, before.cwd, "the same worktree")
  assert.equal(await branch(), onBranch, "the same branch")

  const answered = await until("the Fin's report", async () => {
    const strip = await fin()
    return strip?.state.kind !== "working" && strip?.report?.line.includes(word) ? strip : undefined
  })
  await note("its report", Json.parse(answered))
  assert.equal(answered.child, child, "the same Thread")
  assert.equal(answered.name, "proof", "the same name")
  assert.equal(answered.harness, "claude")
  const snapshot = Snapshot.parse(await call("mako:live-snapshot", [conversation]))
  const turns = snapshot.requests.map((request) => ({ text: request.text.slice(0, 80), status: request.status, context: request.context?.length ?? 0 }))
  await note("every request", turns)
  assert.equal(snapshot.requests.filter((request) => request.status === "completed" && request.context?.length).length, 1, "the conversation carried over once")
  assert.equal(snapshot.requests.filter((request) => request.text.includes("queued-once.txt")).length, 1, "the second message is one row")
  await writeFile(join(out, "fin-history.jsonl"), (await mako("history", conversation)).map((line) => JSON.stringify(line)).join("\n"))
  // Each message was tried on Cursor and failed there. What goes on is the turn a limit cut, with both in the transcript.
  await until("the second message acted on, in the same worktree", async () => run("test", ["-f", join(before.cwd, "queued-once.txt")], { env }).then(() => true), 120_000)
  await note("the journal", { bindings: snapshot.control.bindings.map((binding) => binding.provider), transfers: snapshot.control.transfers.map((transfer) => ({ to: transfer.input.provider, by: transfer.actor?.kind ?? "", state: transfer.state.kind })) })
  const heard = await until("its Apex to hear it", async () => {
    const history = (await mako("history", apex)).map((line) => HistoryLine.parse(line))
    return history.find((line) => line.kind === "user" && line.text?.startsWith(FROM_AGENTS) && line.text.includes(word))
  })
  await note("its Apex heard", heard.text ?? "")
  await writeFile(join(out, "fin-history.jsonl"), (await mako("history", conversation)).map((line) => JSON.stringify(line)).join("\n"))
  const read = await agents("read", "proof", "--transcript")
  await note("agents_read", { whole: read.whole ?? "", truncated: read.truncated ?? false })
  console.log(`PROVED: ${child} went ${values.direct ? "Codex → Claude Code" : "Codex → Cursor (out) → Claude Code"}, answered ${word} and reported to its Apex`)
} finally {
  await cp(join(dataRoot, "logs"), join(out, "logs"), { recursive: true }).catch(() => undefined)
  host?.kill("SIGTERM")
  await pause(1_000)
  scratch.dispose()
  await removeScratch(root).catch(() => undefined)
}
