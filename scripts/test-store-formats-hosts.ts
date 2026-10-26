import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { ResumeVerdict, TransferInput } from "@mako/host/contracts/conversation-control"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { HostJobs } from "@mako/host/base/host-jobs"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { resumingUnder } from "@mako/host/conversations/live-ledger"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { followOtherHosts } from "@mako/host/threads/groups-follow"
import { SessionMemory } from "@mako/host/threads/session-memory"
import { openThreadStore, ThreadStore, threadStorePath } from "@mako/host/threads/store"
import { formatsKey, storeFormats } from "@mako/host/threads/store-formats"
import { CodexProvider, KeptOutputs, SessionCatalog } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { RecordStore } from "@mako/sessions/record-store"
import { UNREAD_INDEX_FILE, UnreadIndex } from "@mako/sessions/unread-index"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * Two hosts of different builds on one fixture data root. This build's host
 * runs a conversation; a newer Mako's host, in a process of its own
 * (`fixtures/newer-mako-host.ts`), migrates the Thread store and the session
 * ledger to its next format while this one runs. The running host notices,
 * tells its windows once, and goes on: it lists every Thread and reads what
 * the newer one wrote, a new conversation runs, a rename and a reconnect are
 * declined with the line and spawn nothing, and it writes nothing. The newer
 * host then reads everything back, its own additions included.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-store-formats-hosts-")))
const dataRoot = join(root, "data")
const threadsPath = threadStorePath(dataRoot)
const ledgerPath = join(dataRoot, "session-memory.sqlite")
const journals = join(dataRoot, "conversations")
mkdirSync(journals, { recursive: true })

const FIXTURE: Pick<ProviderLiveDriver, "approvalEvidence" | "launchEnvironment" | "nativeIdentity" | "nativeExclusion" | "nativePromptIdentity" | "planning" | "backgroundStop" | "turnRecovery"> = {
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
}

const starts: string[] = []
function driver(): ProviderLiveDriver {
  return {
    ...FIXTURE,
    ...noCapabilities,
    resume: fixtureResume(),
    provider: "cursor",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push(options.conversationId)
      return {
        id: options.conversationId, nativeId: `agent-${starts.length === 1 ? "a" : starts.length}`, harness: "cursor", cwd: "/repo", status: "ready", connection: "connected",
        modes: [{ id: "agent", name: "Agent", access: "full", enforcement: "provider" }], currentMode: "agent", configOptions: [], settings: { model: "claude-fable-5-1" },
      }
    },
    prompt: async () => {},
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  // A deadline, not a count of tries: beside a whole suite a first capture can take seconds.
  const deadline = Date.now() + 30_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await delay(5)
  }
}

/** What the newer host prints after `read`. */
const ReadSchema = z.object({
  writable: z.boolean(),
  titles: z.array(z.object({ thread: z.string(), title: z.string().nullable(), source: z.string().optional() })),
  colors: z.array(z.string()),
  added: z.array(z.string()),
  ledger: z.string(),
  remembered: z.object({ settings: z.object({ model: z.string() }).optional() }).nullable(),
  sources: z.array(z.string()),
})

/** The newer Mako's host: one command in a process of its own, its JSON line back. */
async function newerHost(...args: string[]): Promise<string> {
  const child = spawn(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "newer-mako-host.ts"), ...args], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  let errors = ""
  child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on("data", (chunk: Buffer) => { errors += chunk.toString() })
  const code = await new Promise<number | null>((resolve) => child.on("exit", resolve))
  assert.equal(code, 0, `the newer host failed: ${errors}`)
  return output.trim().split("\n").at(-1) ?? ""
}

/** Every table's rows but `except`, as text: what "nothing was written" compares. */
function dump(file: string, except: readonly string[] = []): string {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all().map((row) => String(row.name)).filter((name) => !except.includes(name))
    return JSON.stringify(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}"`).all()]))
  } finally {
    db.close()
  }
}

/**
 * The stores the catalog worker writes: this build's catalog captures a
 * session, notes its unread records and keeps a command's output; a newer
 * Mako's worker raises all three in its own process. From then on nothing
 * is captured, noted or kept, the host's windows are told, and nothing is
 * written into the newer layout.
 */
async function sessionStoresRaisedWhileRunning(): Promise<void> {
  const home = join(root, "home")
  const mako = join(home, ".mako")
  const records = join(mako, "records")
  const views = join(mako, "views")
  const archive = join(mako, "archive")
  const id = "01a0e74f-b716-77a2-8b46-71174540cdaa"
  const dated = join(home, ".codex", "sessions", "2026", "10", "17")
  const live = join(dated, `rollout-2026-10-17T02-19-16-${id}.jsonl`)
  mkdirSync(dated, { recursive: true })
  const stamped = () => new Date().toISOString()
  const message = (text: string) => `${JSON.stringify({ timestamp: stamped(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })}\n`
  writeFileSync(live, `${JSON.stringify({ timestamp: stamped(), type: "session_meta", payload: { id, cwd: home } })}\n${message("Started.")}`)
  const state = new DatabaseSync(join(home, ".codex", "state_5.sqlite"))
  state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, name TEXT, title TEXT, cwd TEXT, updated_at_ms INTEGER, thread_source TEXT, rollout_path TEXT)")
  state.prepare("INSERT INTO threads VALUES (?, NULL, 'Raised under me', ?, ?, 'user', ?)").run(id, home, Date.now(), live)
  state.close()
  const catalog = new SessionCatalog([new CodexProvider(new NativeStores(false), home)], { recordsPath: records, recordsHome: home, viewsPath: views, writer: "0.161.2" })
  await catalog.scan()
  await delay(300)
  appendFileSync(live, message("Captured by this build."))
  await catalog.scan({ emitChanges: true })
  const look = new RecordStore(records, new NativeStores(false))
  await until(() => look.sessions().length === 1, "the first capture")
  const unread = new UnreadIndex(join(views, UNREAD_INDEX_FILE), { writer: "0.161.2" })
  unread.note({ path: live, harness: "codex", nativeId: id }, "build-1", [{ type: "unread", kind: "response_item new_kind", reason: "unknown", raw: {}, id: "@1" }])
  const outputs = new KeptOutputs(join(archive, "outputs.sqlite"))
  outputs.keep({ harness: "claude", session: "s", task: "t1" }, { output: "one\n", exitCode: 0 })
  const sources = { threads: null, threadsPath: join(root, "unused-threads.sqlite"), memory: null, memoryPath: join(root, "unused-memory.sqlite"), records, views, archive }
  assert.deepEqual(storeFormats(sources).stores.filter((row) => row.access !== "write"), [], "every store this build's own")

  const followed = new ThreadStore(join(root, "follower-threads.sqlite"), { realPath: (path) => path })
  const jobs = new HostJobs()
  const subscribed = jobs.demand("a window is open")
  subscribed.set(true)
  const told: string[] = []
  const stop = followOtherHosts(followed, () => {}, { jobs, subscribed, everyMs: 20, formats: { key: () => formatsKey(storeFormats(sources)), changed: () => told.push(formatsKey(storeFormats(sources))) } })

  assert.equal(await newerHost("migrate-records", join(records, "records.sqlite"), join(views, UNREAD_INDEX_FILE), join(archive, "outputs.sqlite")), JSON.stringify({ migrated: true }))
  const raised = { records: dump(join(records, "records.sqlite")), unread: dump(join(views, UNREAD_INDEX_FILE)), outputs: dump(join(archive, "outputs.sqlite")) }
  await until(() => told.some((key) => ["records", "unread", "outputs"].every((store) => key.includes(`"store":"${store}","access":"read"`))), "the host's windows to be told")
  assert.equal(look.access, "read", "the record store reads as read-only to this build now")
  const warned: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => void warned.push(args.join(" "))
  try {
    for (const text of ["Written after the raise.", "And again."]) {
      appendFileSync(live, message(text))
      await catalog.scan({ emitChanges: true })
      await delay(300)
    }
    unread.note({ path: live, harness: "codex", nativeId: id }, "build-1", [])
    outputs.keep({ harness: "claude", session: "s", task: "t2" }, { output: "two\n", exitCode: 0 })
  } finally {
    console.warn = warn
  }
  stop()
  jobs.stop()
  followed.close()
  await catalog.stop()
  await look.close()
  unread.close()
  outputs.close()
  assert.equal(warned.filter((said) => said.startsWith("Session records read only")).length, 1, `capture stopped, said once: ${JSON.stringify(warned)}`)
  assert.ok(!warned.some((said) => said.includes("failed")), "with no failed writes")
  assert.equal(dump(join(records, "records.sqlite")), raised.records, "nothing captured into the newer record store")
  assert.equal(dump(join(views, UNREAD_INDEX_FILE)), raised.unread, "nothing noted into the newer index")
  assert.equal(dump(join(archive, "outputs.sqlite")), raised.outputs, "nothing kept into the newer copies")
}

try {
  // This build's host, as `openThreads` opens its stores, with a conversation running.
  const { store: threads } = openThreadStore(threadsPath, { realPath: (path) => path, writer: "0.161.2" })
  assert.ok(threads)
  // Its clock is injected, so three minutes pass without waiting for them.
  let clock = Date.now()
  const memory = new SessionMemory(ledgerPath, { pid: process.pid, startedAt: Math.round(performance.timeOrigin), label: "Mako 0.161.2" }, { writer: "0.161.2", now: () => clock })
  const events: HostEvent[] = []
  const dependencies = {
    appPath: root, root: journals, threads, memory, driver, history: async () => null, emit: (event: HostEvent) => events.push(event),
    // The host's own verdict: the ledger's rule over the harness's assessment.
    resumeVerdict: resumingUnder(memory, async (): Promise<ResumeVerdict> => ({ kind: "resumable", record: "same" })),
  }
  const host = new LiveConversations(dependencies)
  const first = randomUUID()
  await host.start("cursor", "/repo", { conversationId: first })
  await until(() => host.snapshot(first)?.session.status === "ready", "the first conversation")
  const placed = threads.journalPlacement(first)
  assert.ok(placed, "this build registers its conversation")
  await until(() => memory.recall("cursor", "agent-a") !== null, "the ledger to remember what it runs under")
  const jobs = new HostJobs()
  const subscribed = jobs.demand("a window is open")
  subscribed.set(true)
  // What the windows were told, each a standing of both stores. The newer host raises them one after the other, so a tick between the two tells twice; what matters is that each change is told once and the last says both.
  const told: string[] = []
  const standings = () => JSON.stringify([threads.standing().access, memory.standing().access])
  const stopFollowing = followOtherHosts(threads, dependencies.emit, {
    jobs, subscribed, everyMs: 20,
    formats: { key: standings, changed: () => told.push(standings()) },
  })

  // A newer Mako starts beside it and migrates both stores.
  assert.equal(await newerHost("migrate", threadsPath, ledgerPath, placed.thread), JSON.stringify({ migrated: true }))
  const migrated = { threads: dump(threadsPath), ledger: dump(ledgerPath, ["holds"]) }
  await until(() => told.at(-1) === JSON.stringify(["read", "read"]), "the running host to notice both stores")
  assert.equal(threads.standing().access, "read", "the running host now only reads the Thread store")
  assert.equal(memory.standing().access, "read", "and the session ledger")
  assert.equal(threads.titleEntry(placed.thread)?.title, "Named by Mako 0.163.0", "it reads what the newer host wrote")
  assert.equal(threads.sessionPlacement(placed.session)?.thread, placed.thread, "and every Thread it had")
  // The session this host runs stays held through the raise: its heartbeat goes on, and the newer host, which can't confirm this one is alive, still sees the hold.
  assert.equal(JSON.parse(await newerHost("held", String(clock), ledgerPath, "cursor", "agent-a")).heldBy, "Mako 0.161.2", "held right after the raise")
  for (let minute = 0; minute < 8; minute++) {
    clock += 30_000
    memory.heartbeat()
  }
  assert.equal(JSON.parse(await newerHost("held", String(clock), ledgerPath, "cursor", "agent-a")).heldBy, "Mako 0.161.2", "and four minutes on, past the three a hold goes stale in, it's still held")
  assert.throws(() => threads.renameThread({ operationId: randomUUID(), thread: placed.thread, title: "Renamed here", actor: threads.person() }),
    { message: "A newer Mako (0.163.0) updated your Threads; this one can show them but not change them. Update Mako to edit." }, "a rename is declined with the line")

  // A new conversation still runs here; its journal waits for a build that can write the store.
  const second = randomUUID()
  await host.start("cursor", "/repo", { conversationId: second })
  await until(() => host.snapshot(second)?.session.status === "ready", "a new conversation beside a newer store")
  assert.equal(threads.journalPlacement(second), undefined, "its journal isn't registered")
  host.stop()
  await delay(10)

  // After a restart, a reply to the first conversation doesn't resume its session: it goes on from its transcript in a new one.
  const restarted = new LiveConversations(dependencies)
  const before = starts.length
  const input: TransferInput = { id: randomUUID(), provider: "cursor", text: "Go on", attachments: [] }
  restarted.transfer(first, input)
  await until(() => restarted.snapshot(first)?.control?.transfers.some((transfer) => transfer.input.id === input.id && transfer.state.kind !== "preparing" && transfer.state.kind !== "queued") === true, "the reply to settle")
  const went = restarted.snapshot(first)?.control?.transfers.find((transfer) => transfer.input.id === input.id)
  assert.equal(went?.state.kind, "accepted", JSON.stringify(went?.state))
  assert.equal(starts.length, before + 1, "in one new session")
  assert.throws(() => memory.hold("cursor", "agent-a", first), { message: "A newer Mako (0.163.0) updated how Mako keeps track of sessions; this one can show this session but can't resume it." }, "a resume that asks for the hold anyway is declined with the line")
  restarted.stop()
  stopFollowing()
  jobs.stop()
  threads.close()
  memory.close()
  assert.equal(new Set(told).size, told.length, `its windows were told each change once: ${JSON.stringify(told)}`)
  assert.equal(told.at(-1), JSON.stringify(["read", "read"]), "the last time, of both stores")
  assert.equal(dump(threadsPath), migrated.threads, "this build wrote nothing into the newer Thread store")
  assert.equal(dump(ledgerPath, ["holds"]), migrated.ledger, "or the newer ledger, beyond its own holds")
  const left = new DatabaseSync(ledgerPath, { readOnly: true })
  assert.equal(left.prepare("SELECT count(*) AS n FROM holds WHERE host_pid = ?").get(process.pid)?.n, 0, "which it released when it stopped")
  left.close()

  // The newer host reads it all back.
  const read = ReadSchema.parse(JSON.parse(await newerHost("read", threadsPath, ledgerPath)))
  assert.equal(read.writable, true)
  assert.deepEqual(read.titles, [{ thread: placed.thread, title: "Named by Mako 0.163.0", source: "user" }])
  assert.deepEqual(read.colors, ["newer"], "its column kept its values")
  assert.deepEqual(read.added, ["kept for the newer build"], "and its table its rows")
  assert.equal(read.ledger, "write")
  assert.deepEqual(read.remembered?.settings, { model: "claude-fable-5-1" }, "what this build remembered before the migration reads back")
  assert.deepEqual(read.sources, ["newer"])
  await sessionStoresRaisedWhileRunning()
  console.log("store formats across hosts: a newer Mako migrating the shared stores under a running host turns them read-only there (the Thread store, the ledger, the record store, the unread index and the kept outputs), the host keeps working, says so and writes nothing, and the newer host reads everything back")
} finally {
  rmSync(root, { recursive: true, force: true })
}
