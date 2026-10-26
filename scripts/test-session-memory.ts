import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import type { ThreadRef } from "@mako/sessions"
import { planContinuation } from "@mako/host/contracts/thread-continuation"
import { heldReason } from "@mako/host/contracts/session-hold"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { createContinuationPlanner } from "@mako/host/conversations/continuation"
import { resumingUnder } from "@mako/host/conversations/live-ledger"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import {
  HOLD_STALE_MS,
  LEGACY_ROUTES_RETIRED,
  LEGACY_ROUTES_RETIRE_MS,
  SESSION_MEMORY_SCHEMA,
  SessionHeldError,
  SessionMemory,
  rememberedSettings,
} from "@mako/host/threads/session-memory"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { ResumeVerdict, TransferInput } from "@mako/host/contracts/conversation-control"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const root = mkdtempSync(join(tmpdir(), "mako-session-memory-"))
const ledger = join(root, "session-memory.sqlite")
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

function upgradeLegacyRoutes(): void {
  const path = join(root, "legacy.sqlite")
  const legacy = new DatabaseSync(path)
  legacy.exec(`CREATE TABLE conversation_routes (
    conversation_id TEXT PRIMARY KEY, provider TEXT NOT NULL, native_id TEXT NOT NULL, socket TEXT NOT NULL);
    INSERT INTO conversation_routes VALUES ('old-conversation', 'cursor', 'old-native', '/old.sock');`)
  legacy.close()
  const host = { pid: 300, startedAt: 3, label: "upgraded host", socket: "/new.sock" }
  const upgraded = new SessionMemory(path, host, { now: () => 100, alive: () => true })
  try {
    assert.equal(upgraded.routeForSession("cursor", "old-native")?.conversationId, "old-conversation", "upgrade preserves existing routes")
    upgraded.hold("cursor", "old-native", "new-conversation")
    upgraded.release("cursor", "old-native", "new-conversation")
    assert.equal(upgraded.routeForSession("cursor", "old-native")?.conversationId, "new-conversation", "the new local route takes precedence after release")
    const oldWriter = new DatabaseSync(path)
    try {
      assert.equal(oldWriter.prepare("SELECT count(*) AS n FROM conversation_routes WHERE conversation_id = 'new-conversation'").get()?.["n"], 0, "this build binds without the old routes table")
      assert.equal(oldWriter.prepare("SELECT socket FROM conversation_journals WHERE conversation_id = 'new-conversation'").get()?.["socket"], "/new.sock")
      oldWriter.prepare("INSERT INTO conversation_routes (conversation_id, provider, native_id, socket) VALUES (?, ?, ?, ?)")
        .run("legacy-writer", "cursor", "legacy-native", "/old.sock")
      oldWriter.prepare("UPDATE conversation_routes SET provider = ?, native_id = ? WHERE conversation_id = ?")
        .run("codex", "second-native", "legacy-writer")
      assert.equal(upgraded.routeForSession("cursor", "legacy-native")?.conversationId, "legacy-writer", "older writers cannot erase previous bindings")
      assert.equal(upgraded.routeForSession("codex", "second-native")?.conversationId, "legacy-writer")
      upgraded.rememberBindings("recovered-journal", [{ provider: "claude", nativeId: "metadata-native" }], 50)
      assert.equal(upgraded.routeForSession("claude", "metadata-native")?.conversationId, "recovered-journal")
      oldWriter.prepare("INSERT INTO conversation_routes (conversation_id, provider, native_id, socket) VALUES (?, ?, ?, ?)")
        .run("older-host-new-conversation", "cursor", "old-native", "/old.sock")
      assert.equal(upgraded.routeForSession("cursor", "old-native")?.conversationId, "older-host-new-conversation", "writes from old schemas get a real timestamp and outrank older bindings")
      const query = oldWriter.prepare("EXPLAIN QUERY PLAN SELECT conversation_id FROM conversation_bindings WHERE provider = ? AND native_id = ? ORDER BY updated_at DESC LIMIT 1").all("cursor", "legacy-native")
      assert.match(JSON.stringify(query), /conversation_bindings_lookup/, "native lookup uses its index")
    } finally {
      oldWriter.close()
    }
  } finally {
    upgraded.close()
  }
  const reopened = new SessionMemory(path, { ...host, socket: "/observer.sock" })
  try {
    assert.equal(reopened.routeForSession("cursor", "old-native")?.conversationId, "older-host-new-conversation", "reopening preserves route timestamps")
    assert.equal(reopened.routeForSession("cursor", "legacy-native")?.conversationId, "legacy-writer", "older hosts can still write routes")
  } finally {
    reopened.close()
  }
}

/** Every host's data root, this one's included, from the launches the ledger lists: where each records its agents. */
function hostDataRoots(): void {
  const path = join(root, "roots.sqlite")
  const launch = (dataRoot: string) => ({ dataRoot, executable: "/Applications/Mako.app", args: [], cwd: "/", profile: "default" })
  const installed = new SessionMemory(path, { pid: 400, startedAt: 4, label: "the installed Mako app", socket: "/installed.sock", launch: launch("/data/installed") })
  const dev = new SessionMemory(path, { pid: 401, startedAt: 5, label: "dev", socket: "/dev.sock", launch: launch("/data/dev") })
  try {
    assert.deepEqual(dev.hostDataRoots().sort(), ["/data/dev", "/data/installed"])
    assert.deepEqual(installed.hostDataRoots().sort(), ["/data/dev", "/data/installed"], "each host reads the others' roots and its own")
  } finally {
    installed.close()
    dev.close()
  }
}

function retireLegacyRoutes(): void {
  const path = join(root, "retiring.sqlite")
  const host = { pid: 301, startedAt: 3, label: "retiring host", socket: "/new.sock" }
  const open = (now: number) => new SessionMemory(path, host, { now: () => now, alive: () => true })
  const olderBuild = () => {
    const db = new DatabaseSync(path)
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_routes (
        conversation_id TEXT PRIMARY KEY, provider TEXT NOT NULL, native_id TEXT NOT NULL, socket TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS conversation_routes_native ON conversation_routes(provider, native_id);`)
    assert.ok(db.prepare("PRAGMA table_info(conversation_routes)").all().some((column) => column.name === "updated_at"))
    return db
  }
  const write = (db: DatabaseSync, conversation: string, native: string) =>
    db.prepare(`INSERT INTO conversation_routes (conversation_id, provider, native_id, socket, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET provider=excluded.provider, native_id=excluded.native_id, socket=excluded.socket, updated_at=excluded.updated_at`)
      .run(conversation, "cursor", native, "/old.sock", Date.now())
  const watch = () => {
    const db = new DatabaseSync(path)
    try {
      return db.prepare("SELECT last_write, retired_at FROM legacy_routes").get()
    } finally {
      db.close()
    }
  }

  open(0).close()
  const older = olderBuild()
  write(older, "older-conversation", "older-native")
  older.close()
  const lastWrite = Number(watch()?.["last_write"])
  assert.ok(lastWrite > 0, "an older build's write is noted")

  const early = open(lastWrite + LEGACY_ROUTES_RETIRE_MS - 1)
  early.close()
  assert.equal(watch()?.["retired_at"], null, "the table stays while an older build wrote within the window")

  const retiring = open(lastWrite + LEGACY_ROUTES_RETIRE_MS)
  try {
    assert.equal(watch()?.["retired_at"], lastWrite + LEGACY_ROUTES_RETIRE_MS, "a quiet window retires the table")
    assert.equal(retiring.routeForSession("cursor", "older-native")?.conversationId, "older-conversation", "retiring keeps what older builds bound")
    retiring.hold("cursor", "fresh-native", "fresh-conversation")
    retiring.release("cursor", "fresh-native", "fresh-conversation")
    assert.equal(retiring.routeForSession("cursor", "fresh-native")?.conversationId, "fresh-conversation")
  } finally {
    retiring.close()
  }

  const stale = olderBuild()
  try {
    assert.equal(stale.prepare("SELECT count(*) AS n FROM conversation_routes").get()?.["n"], 0, "the retired table holds nothing")
    assert.throws(() => write(stale, "stale-conversation", "stale-native"), (error: Error) => error.message.includes(LEGACY_ROUTES_RETIRED), "an older build's write fails and says to update")
  } finally {
    stale.close()
  }
  open(lastWrite + 2 * LEGACY_ROUTES_RETIRE_MS).close()
  assert.equal(watch()?.["retired_at"], lastWrite + LEGACY_ROUTES_RETIRE_MS, "retiring happens once")
}
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

const FIXTURE_CAPABILITIES: Pick<ProviderLiveDriver, "approvalEvidence" | "launchEnvironment" | "nativeIdentity" | "nativeExclusion" | "nativePromptIdentity" | "planning" | "backgroundStop" | "turnRecovery"> = {
  approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
  launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
  nativeExclusion: NO_NATIVE_EXCLUSION,
  nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
  planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
  backgroundStop: { kind: "ends-with-turn", evidence: "Injected driver fixture" },
  turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
}

function fixtureDriver(nativeId: string, starts: string[]): ProviderLiveDriver {
  return {
    ...FIXTURE_CAPABILITIES,
    ...noCapabilities,
    resume: fixtureResume(),
    provider: "cursor",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push(options.conversationId)
      return {
        id: options.conversationId,
        nativeId,
        harness: "cursor",
        cwd: "/repo",
        status: "ready",
        connection: "connected",
        modes: [{ id: "agent", name: "Agent", access: "ask", enforcement: "provider" }],
        currentMode: "agent",
        configOptions: [],
        settings: { model: "claude-fable-5-1" },
      }
    },
    prompt: async () => {},
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async () => {},
  }
}

/**
 * The host died mid-turn; cursor-agent wrote its last blocks on exit, so the
 * store's head moved past the binding's idle checkpoint. The reconnect goes
 * on from the session anyway: only something holding it refuses.
 */
async function reconnectAfterRestart() {
  const starts: string[] = []
  const notices: string[] = []
  let verdict: ResumeVerdict = { kind: "resumable", record: "moved" }
  const journals = join(root, "restart")
  const dependencies = {
    appPath: root,
    driver: () => fixtureDriver("agent-restart", starts),
    history: async () => null,
    emit: (event: HostEvent) => {
      if (event.type === "notice") notices.push(event.message)
    },
    resumeVerdict: async () => verdict,
    root: journals,
    memory: installed,
  }
  const id = randomUUID()
  const before = new LiveConversations(dependencies)
  await before.start("cursor", "/repo", { conversationId: id })
  await until(() => before.snapshot(id)?.session.status === "ready", "the first session")
  before.stop()
  await tick()
  assert.equal(dev.heldBy("cursor", "agent-restart"), null, "a stopped host holds nothing")

  const reconnect = (owner: LiveConversations, text: string) => {
    const input: TransferInput = { id: randomUUID(), provider: "cursor", text, attachments: [] }
    owner.transfer(id, input)
    return input
  }
  const after = new LiveConversations(dependencies)
  try {
    assert.equal(after.snapshot(id)?.session.connection, "disconnected", "the restarted host recovers the journal disconnected")
    const moved = reconnect(after, "Go ahead")
    await until(() => after.snapshot(id)?.control?.transfers.some((transfer) => transfer.input.id === moved.id && transfer.state.kind !== "preparing" && transfer.state.kind !== "queued") === true, "the moved reconnect to settle")
    const accepted = after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === moved.id)
    assert.equal(accepted?.state.kind, "accepted", `a record that moved while the host was away still reconnects: ${JSON.stringify(accepted?.state)}`)
    assert.equal(starts.length, 2, "the provider was started once for the reconnect")
    assert.ok(notices.some((message) => message.includes("continued outside Mako")), "a move no turn here explains is said out loud")
    await until(() => dev.heldBy("cursor", "agent-restart")?.hostLabel === "the installed Mako app", "the reconnect to hold the session")
    await after.close(id)
    assert.equal(dev.heldBy("cursor", "agent-restart"), null)

    // Something else has the store open: refused by name, nothing spawned.
    verdict = { kind: "held", by: "another cursor-agent process" }
    const held = reconnect(after, "Try again")
    await until(() => after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === held.id)?.state.kind === "failed", "the held reconnect to fail")
    const refused = after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === held.id)
    assert.ok(refused?.state.kind === "failed" && refused.state.error.includes(heldReason("another cursor-agent process")), `the refusal names what holds the session: ${JSON.stringify(refused?.state)}`)
    assert.equal(starts.length, 2, "a held session spawns nothing")

    // Another Mako host holds it in the ledger: the hold is checked before anything spawns.
    verdict = { kind: "resumable", record: "same" }
    dev.hold("cursor", "agent-restart", "elsewhere")
    const elsewhere = reconnect(after, "Once more")
    await until(() => after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === elsewhere.id)?.state.kind === "failed", "the cross-host reconnect to fail")
    const crossHost = after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === elsewhere.id)
    assert.ok(crossHost?.state.kind === "failed" && crossHost.state.error === heldReason("Mako's dev host"), `another host's hold refuses the reconnect: ${JSON.stringify(crossHost?.state)}`)
    assert.equal(starts.length, 2)
    assert.equal(dev.heldBy("cursor", "agent-restart"), null, "the other host's hold was not taken over")
    dev.release("cursor", "agent-restart")

    verdict = { kind: "unavailable", reason: "The session store is missing or unreadable." }
    const missing = reconnect(after, "And again")
    await until(() => after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === missing.id)?.state.kind === "failed", "the unavailable reconnect to fail")
    const unavailable = after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === missing.id)
    assert.ok(unavailable?.state.kind === "failed" && unavailable.state.error.includes("The session store is missing or unreadable."), "the refusal carries the provider's own reason")
  } finally {
    after.stop()
  }
}

/**
 * The host died during a turn it had sent; the provider wrote that turn's
 * progress before it was cut off. The move is Mako's own and the transcript
 * already holds what streamed, so the reconnect says nothing about it.
 */
async function reconnectAfterOwnTurn() {
  const starts: string[] = []
  const notices: string[] = []
  const dependencies = {
    appPath: root,
    driver: () => fixtureDriver("agent-own-turn", starts),
    history: async () => null,
    emit: (event: HostEvent) => {
      if (event.type === "notice") notices.push(event.message)
    },
    resumeVerdict: async (): Promise<ResumeVerdict> => ({ kind: "resumable", record: "moved" }),
    root: join(root, "own-turn"),
    memory: installed,
  }
  const id = randomUUID()
  const before = new LiveConversations(dependencies)
  await before.start("cursor", "/repo", { conversationId: id })
  await until(() => before.snapshot(id)?.session.status === "ready", "the first session")
  const sent = randomUUID()
  before.submit(id, sent, "Run the long task")
  await until(() => before.snapshot(id)?.requests.some((request) => request.id === sent && request.status === "dispatching") === true, "the turn to dispatch")
  before.stop()
  await tick()

  const after = new LiveConversations(dependencies)
  try {
    const input: TransferInput = { id: randomUUID(), provider: "cursor", text: "Go ahead", attachments: [] }
    after.transfer(id, input)
    await until(() => after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === input.id)?.state.kind === "accepted", "the reconnect to be accepted")
    assert.equal(starts.length, 2, "the provider was started once for the reconnect")
    assert.deepEqual(notices, [], "a move the interrupted turn explains raises no notice")
    await after.close(id)
  } finally {
    after.stop()
  }
}

/**
 * A newer Mako changed the ledger's format while this build's host was
 * away. The host starts on it read-only: a new conversation runs, what it
 * would remember stays in its journal, and a reconnect, which must hold the
 * session first, is declined with the line and spawns nothing. Once the
 * person updates, the updated build's host takes the journal's facts into
 * the ledger at its start, and the newer build's own rows are as it left them.
 */
async function newerLedger() {
  const path = join(root, "newer-ledger.sqlite")
  const journals = join(root, "newer-ledger-journals")
  const NEWER = { writableBy: SESSION_MEMORY_SCHEMA + 1, readableBy: SESSION_MEMORY_SCHEMA }
  const raised = new SessionMemory(path, { pid: 300, startedAt: 3, label: "Mako 0.163.0" }, { ...clock, format: NEWER, writer: "0.163.0" })
  raised.remember("codex", "kept-by-newer", { modeId: "access:full" }, 10)
  const older = new SessionMemory(path, { pid: 100, startedAt: 1, label: "the installed Mako app" }, clock)
  assert.equal(older.standing().access, "read", "this build reads a newer Mako's ledger")
  const starts: string[] = []
  const resumed: (string | undefined)[] = []
  const base = fixtureDriver("agent-newer", starts)
  const driver: ProviderLiveDriver = { ...base, start: async (cwd, options) => {
    resumed.push(options.resume)
    return base.start(cwd, options)
  } }
  // The host's own verdict: the ledger's rule over the harness's assessment.
  const resumeVerdict = resumingUnder(older, async (): Promise<ResumeVerdict> => ({ kind: "resumable", record: "same" }))
  const dependencies = { appPath: root, driver: () => driver, history: async () => null, emit: () => {}, resumeVerdict, root: journals, memory: older }
  const id = randomUUID()
  const first = new LiveConversations(dependencies)
  await first.start("cursor", "/repo", { conversationId: id })
  await until(() => first.snapshot(id)?.session.status === "ready", "a new conversation on a newer ledger")
  first.stop()
  await tick()
  assert.equal(older.recall("cursor", "agent-newer"), null, "what it ran under stays in its journal")
  const after = new LiveConversations(dependencies)
  try {
    // The plan says so before a reply, from the one rule the send asks too.
    const ref: ThreadRef = { harness: "cursor", nativeId: "agent-newer", path: "/sessions/agent-newer", title: "Newer", revision: "r" }
    const planner = (available: boolean) => createContinuationPlanner({
      ref: async () => ref, live: () => ({ available, canResume: true }), nativeInstalled: () => true, running: () => false, external: () => null,
      assessResume: async () => resumeVerdict(undefined), resumeRefusal: () => older.resumeRefusal()?.message ?? null,
    })
    const line = "A newer Mako (0.163.0) updated how Mako keeps track of sessions; this one can show this session but can't resume it."
    assert.deepEqual(await planner(true).plan(ref.path), { transport: "handoff", provider: "cursor", reason: `${line} A reply goes on from its transcript in a new session.`, makoUpdate: true, notice: { line, reply: "transcript", harness: "cursor" } }, "a reply goes on from its transcript")
    assert.deepEqual(await planner(false).plan(ref.path), { transport: "refused", reason: `${line} cursor can't start a new session here to go on from its transcript, so a reply waits for the update.`, makoUpdate: true, notice: { line, reply: "waits", harness: "cursor" } }, "and without a live driver says why it waits")
    assert.equal((await planner(true).plan(ref.path)).transport === "live", false, "never a resume")
    raised.hold("cursor", "agent-elsewhere", "theirs")
    const heldPlan = await createContinuationPlanner({ ref: async () => ({ ...ref, heldBy: "Mako 0.163.0" }), live: () => ({ available: true, canResume: true }), nativeInstalled: () => true, running: () => false, external: () => null, resumeRefusal: () => older.resumeRefusal()?.message ?? null }).plan(ref.path)
    assert.deepEqual(heldPlan, { transport: "refused", reason: heldReason("Mako 0.163.0") }, "another host's hold is still said first, by name")
    raised.release("cursor", "agent-elsewhere", "theirs")

    // The send does what the plan said: a new session from the transcript, nothing resumed, nothing held.
    const input: TransferInput = { id: randomUUID(), provider: "cursor", text: "Go on", attachments: [] }
    after.transfer(id, input)
    await until(() => after.snapshot(id)?.control?.transfers.some((transfer) => transfer.input.id === input.id && transfer.state.kind !== "preparing" && transfer.state.kind !== "queued") === true, "the reply to settle")
    const went = after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === input.id)
    assert.equal(went?.state.kind, "accepted", `a reply goes on from the transcript: ${JSON.stringify(went?.state)}`)
    assert.equal(starts.length, 2, "in one new session")
    assert.deepEqual(resumed, [undefined, undefined], "resuming nothing")
    assert.equal(raised.heldBy("cursor", "agent-newer"), null, "and holding nothing in the newer ledger")

    // A conversation of this host's that isn't running: its plan says the same before a reply, and a send to it doesn't wake it by resuming.
    const attachedPlan = (running: boolean) => createContinuationPlanner({
      ref: async () => ref, live: () => ({ available: true, canResume: true }), nativeInstalled: () => true, running: () => false, external: () => null,
      resolveOwner: async () => ({ kind: "attached", conversationId: id, provider: "cursor", snapshot: null, ended: false, running }),
      resumeRefusal: () => older.resumeRefusal()?.message ?? null,
    }).plan(ref.path)
    assert.deepEqual(await attachedPlan(false), { transport: "attached", provider: "cursor", conversationId: id, reason: `${line} A reply goes on from its transcript in a new session.`, makoUpdate: true, notice: { line, reply: "transcript", harness: "cursor" } }, "a resting conversation's plan says what a reply does")
    assert.deepEqual(await attachedPlan(true), { transport: "attached", provider: "cursor", conversationId: id }, "a running one resumes nothing and says nothing")
    after.stop()
    await tick()
    const rested = new LiveConversations(dependencies)
    try {
      assert.ok(["disconnected", "hibernated"].includes(rested.snapshot(id)?.session.connection ?? ""), "the conversation rests after a restart")
      rested.submit(id, randomUUID(), "Sent to a resting conversation")
      await until(() => starts.length === 3, "the send to start one new session")
      assert.deepEqual(resumed, [undefined, undefined, undefined], "from the transcript, never by resuming")
      await until(() => rested.snapshot(id)?.session.connection === "connected", "the conversation to go on")
    } finally {
      rested.stop()
    }
  } finally {
    after.stop()
  }
  older.close()
  // Updated: the host of the newer build starts on the same journals and takes what the older one couldn't write.
  const updated = new LiveConversations({ ...dependencies, memory: raised })
  updated.stop()
  assert.deepEqual(raised.recall("cursor", "agent-newer")?.settings, { model: "claude-fable-5-1" }, "the journal's facts reach the ledger once a build that can write it starts")
  assert.equal(raised.recall("codex", "kept-by-newer")?.modeId, "access:full", "and the newer build's own rows are as it left them")
  raised.close()
}

/** A host's journals from before the ledger fill it once, without rolling back a newer observation. */
async function backfillFromJournals() {
  const journals = join(root, "backfill")
  const conversation = randomUUID()
  const settings = { model: "claude-fable-5-1", options: { effort: "high" } }
  const journal = new LiveJournal(journals, conversation)
  journal.commit({
    session: { id: conversation, nativeId: "agent-old", harness: "cursor", cwd: "/repo", status: "ready", connection: "connected", modes: [], currentMode: "access:edits", configOptions: [], settings },
    revision: 0,
    createdAt: now,
    base: null,
    blocks: [],
    permissions: [],
    requests: [],
  })
  journal.close()
  assert.equal(dev.recall("cursor", "agent-old"), null)
  const host = new LiveConversations({ appPath: root, driver: () => undefined, history: async () => null, emit: () => {}, root: journals, memory: dev })
  host.stop()
  const recalled = installed.recall("cursor", "agent-old")
  assert.deepEqual(recalled?.settings, settings, "a pre-ledger journal's settings reach every host")
  assert.equal(recalled?.modeId, "access:edits", "and so does the tier it ran under")
  const written = Date.now()
  // mtime carries sub-millisecond precision, so it may sit a fraction past Date.now().
  assert.ok(recalled && recalled.updatedAt !== now && recalled.updatedAt <= written + 1_000 && recalled.updatedAt > written - 60_000, "stamped with the journal's write time, not the host's clock")
  installed.remember("cursor", "agent-old", { settings: { model: "gpt-5.3-codex" } }, written + 1_000)
  const again = new LiveConversations({ appPath: root, driver: () => undefined, history: async () => null, emit: () => {}, root: journals, memory: dev })
  again.stop()
  assert.equal(installed.recall("cursor", "agent-old")?.settings?.model, "gpt-5.3-codex", "a newer observation is never rolled back by a restart")
}

let now = 1_000_000
const alive = new Set<number>([100, 200])
const clock = { now: () => now, alive: (pid: number) => alive.has(pid) }
const installed = new SessionMemory(ledger, { pid: 100, startedAt: 1, label: "the installed Mako app" }, clock)
const dev = new SessionMemory(ledger, { pid: 200, startedAt: 2, label: "Mako's dev host" }, clock)

try {
  upgradeLegacyRoutes()
hostDataRoots()
  retireLegacyRoutes()
  installed.hold("codex", "route-race", "first-owner")
  const firstHold = dev.heldBy("codex", "route-race")!
  installed.release("codex", "route-race", "first-owner")
  installed.hold("codex", "route-race", "second-owner")
  assert.equal(dev.rememberRoute({ provider: "codex", nativeId: "route-race", conversationId: "first-owner", socket: "/stale.sock" }, firstHold), false, "a raced discovery returns stale instead of throwing or writing an obsolete route")
  assert.equal(dev.routeForConversation("first-owner"), null)
  installed.release("codex", "route-race", "second-owner")

  // --- Facts: settings and mode are remembered independently -----------------
  installed.remember("cursor", "agent-1", { settings: { model: "claude-fable-5-1", options: { effort: "high" } } })
  installed.remember("cursor", "agent-1", { modeId: "access:full" })
  assert.deepEqual(dev.recall("cursor", "agent-1"), {
    settings: { model: "claude-fable-5-1", options: { effort: "high" } },
    modeId: "access:full",
    updatedAt: now,
  }, "another host reads the settings and the mode the first host recorded")
  installed.remember("cursor", "agent-1", { settings: { model: "gpt-5.3-codex" } })
  assert.equal(dev.recall("cursor", "agent-1")?.modeId, "access:full", "a settings report leaves the mode alone")
  assert.equal(dev.recall("cursor", "agent-1")?.settings?.model, "gpt-5.3-codex")
  installed.remember("cursor", "agent-1", { modeId: "plan" })
  assert.equal(dev.recall("cursor", "agent-1")?.settings?.model, "gpt-5.3-codex", "a mode change leaves the settings alone")
  assert.equal(dev.recall("cursor", "none"), null)

  // --- Merge rules: the store wins when it records; memory fills the rest ----
  const remembered = { settings: { model: "m1", options: { effort: "high", tier: "fast" } }, updatedAt: Date.parse("2026-09-12T10:00:00Z") }
  assert.deepEqual(rememberedSettings({}, remembered), remembered.settings, "a store that records nothing (Cursor) takes everything remembered")
  assert.deepEqual(
    rememberedSettings({ model: "m1", settings: { model: "m1" } }, remembered),
    { model: "m1", options: { effort: "high", tier: "fast" } },
    "a model-only store row (Devin) gains the remembered options"
  )
  assert.deepEqual(
    rememberedSettings({ model: "m1", settings: { model: "m1", options: { effort: "low" } } }, remembered),
    { model: "m1", options: { effort: "low", tier: "fast" } },
    "the store's own option value wins over the remembered one"
  )
  assert.deepEqual(
    rememberedSettings({ model: "m2", settings: { model: "m2" }, updatedAt: "2026-09-12T12:00:00Z" }, remembered),
    { model: "m2" },
    "a store written after Mako's observation names the model that actually ran"
  )
  assert.deepEqual(
    rememberedSettings({ model: "m2", settings: { model: "m2" }, updatedAt: "2026-09-12T08:00:00Z" }, remembered),
    remembered.settings,
    "an observation newer than the store's last write overrides it"
  )
  assert.deepEqual(rememberedSettings({ model: "m2", settings: { model: "m2" } }, remembered), { model: "m2" }, "without a store timestamp the store keeps its word")

  // --- Holds: one live host per native session -------------------------------
  installed.hold("cursor", "agent-1", "conv-a")
  assert.equal(installed.heldBy("cursor", "agent-1"), null, "a host's own hold is not a refusal")
  assert.equal(installed.heldHere("cursor", "agent-1"), true, "the host that holds it runs it")
  assert.equal(dev.heldHere("cursor", "agent-1"), false, "another host's hold isn't this one's")
  const seen = dev.heldBy("cursor", "agent-1")
  assert.equal(seen?.hostLabel, "the installed Mako app")
  assert.equal(seen?.conversationId, "conv-a")
  assert.throws(() => dev.hold("cursor", "agent-1", "conv-b"), (error: Error) => error instanceof SessionHeldError && error.message === heldReason("the installed Mako app"))
  installed.hold("cursor", "agent-1", "conv-a")
  assert.throws(
    () => installed.hold("cursor", "agent-1", "conv-other"),
    (error: Error) =>
      error instanceof SessionHeldError &&
      error.message === heldReason("the installed Mako app"),
    "one host cannot silently move a live native session to another conversation"
  )
  assert.equal(dev.heldBy("cursor", "agent-1")?.since, now, "re-holding keeps the original since")
  installed.release("cursor", "agent-1", "conv-other")
  assert.ok(dev.heldBy("cursor", "agent-1"), "a release scoped to another conversation drops nothing")
  installed.release("cursor", "agent-1", "conv-a")
  assert.equal(dev.heldBy("cursor", "agent-1"), null)
  dev.hold("cursor", "agent-1", "conv-b")
  assert.equal(installed.heldBy("cursor", "agent-1")?.hostLabel, "Mako's dev host")
  dev.release("cursor", "agent-1")
  installed.release("cursor", "agent-1")

  // A crashed host is replaced; suspension alone never permits another writer.
  installed.hold("cursor", "agent-2", "conv-c")
  alive.delete(100)
  assert.equal(dev.heldBy("cursor", "agent-2"), null, "a dead host holds nothing")
  dev.hold("cursor", "agent-2", "conv-d")
  alive.add(100)
  assert.equal(installed.heldBy("cursor", "agent-2")?.hostLabel, "Mako's dev host", "the takeover is the live hold now")
  now += HOLD_STALE_MS + 1
  assert.ok(installed.heldBy("cursor", "agent-2"), "a suspended live host retains ownership despite a stale heartbeat")
  assert.throws(() => installed.hold("cursor", "agent-2", "another-writer"), SessionHeldError)
  dev.hold("cursor", "agent-3", "conv-e")
  now += HOLD_STALE_MS - 1
  dev.heartbeat()
  now += HOLD_STALE_MS - 1
  assert.ok(installed.heldBy("cursor", "agent-3"), "a heartbeat keeps a long-running session held")
  dev.releaseAll()
  assert.equal(installed.heldBy("cursor", "agent-3"), null)

  // --- Overlay onto catalogued refs -------------------------------------------
  const bare: ThreadRef = { harness: "cursor", nativeId: "agent-1", path: "/home/.cursor/acp-sessions/agent-1/store.db", cwd: "/repo", updatedAt: "2026-09-12T09:00:00Z" }
  const annotated = dev.annotate(bare)
  assert.equal(annotated.model, "gpt-5.3-codex", "a Cursor row shows the model its session last ran")
  assert.deepEqual(annotated.settings, { model: "gpt-5.3-codex" })
  assert.equal(annotated.accessMode, "plan", "the tier it last ran under travels with the row")
  assert.equal(annotated.heldBy, undefined)
  const unknown: ThreadRef = { harness: "codex", nativeId: "thread-9", path: "/x", cwd: "/repo" }
  assert.equal(dev.annotate(unknown), unknown, "nothing known leaves the ref identity alone")
  installed.hold("cursor", "agent-1", "conv-f")
  assert.equal(dev.annotate(bare).heldBy, undefined, "another host's answer is held briefly, so the catalog is not read per ref")
  now += 2_001
  assert.equal(dev.annotate(bare).heldBy, "the installed Mako app", "another host's hold is named on the row")
  assert.equal(
    planContinuation(dev.annotate(bare), { live: { available: true, canResume: true }, nativeInstalled: true, running: false, external: null }).transport,
    "refused",
    "a reply from the second host is refused while the first has the session live"
  )
  const plan = planContinuation(dev.annotate(bare), { live: { available: true, canResume: true }, nativeInstalled: true, running: false, external: null })
  assert.ok(plan.transport === "refused" && plan.reason === heldReason("the installed Mako app"))
  installed.release("cursor", "agent-1")
  installed.remember("cursor", "agent-1", { modeId: "access:edits" })
  assert.equal(installed.annotate(bare).accessMode, "access:edits", "a host's own write is read back at once")
  assert.equal(dev.annotate(bare).heldBy, "the installed Mako app", "the other host still sees the hold until its answer expires")
  now += 2_001
  assert.equal(dev.annotate(bare).heldBy, undefined)
  assert.equal(dev.annotate(bare).accessMode, "access:edits")

  // A row names a conversation on another running host, so it opens live.
  const listening = new Set(["/peer.sock"])
  const peer = new SessionMemory(ledger, { pid: 100, startedAt: 1, label: "the installed Mako app", socket: "/peer.sock" }, clock)
  const here = new SessionMemory(ledger, { pid: 200, startedAt: 2, label: "Mako's dev host", socket: "/here.sock" }, { ...clock, listening: (socket) => listening.has(socket) })
  try {
    peer.rememberBindings("peer-conversation", [{ provider: "codex", nativeId: "owned-there" }], now)
    here.rememberBindings("local-conversation", [{ provider: "codex", nativeId: "owned-here" }], now)
    const there: ThreadRef = { harness: "codex", nativeId: "owned-there", path: "/there.jsonl" }
    assert.equal(here.annotate(there).ownedElsewhere, true, "a conversation on another running host owns the row")
    assert.equal(here.annotate({ harness: "codex", nativeId: "owned-here", path: "/here.jsonl" }).ownedElsewhere, undefined, "this host's own conversations open through its live list")
    assert.equal(here.annotate(unknown).ownedElsewhere, undefined)
    listening.delete("/peer.sock")
    now += 2_001
    assert.equal(here.annotate(there).ownedElsewhere, undefined, "a route to a host that exited promises nothing")
  } finally {
    peer.close()
    here.close()
  }

  // --- Journal keeps the mode ladder -------------------------------------------
  const journalId = randomUUID()
  const journal = new LiveJournal(join(root, "journals"), journalId)
  const modes = [
    { id: "access:full", name: "Full access", access: "full" as const, enforcement: "launch" as const, description: "The provider reads this policy at launch." },
    { id: "plan", name: "Plan", access: "plan" as const, enforcement: "provider" as const },
  ]
  journal.commit({
    session: { id: journalId, harness: "cursor", cwd: "/repo", status: "ready", connection: "connected", modes, currentMode: "access:full", configOptions: [] },
    revision: 0,
    createdAt: now,
    base: null,
    blocks: [],
    permissions: [],
    requests: [],
  })
  assert.deepEqual(journal.summary()?.session.modes, modes, "a recovered session keeps each mode's tier, enforcement and description")
  assert.deepEqual(journal.read()?.session.modes, modes)
  journal.close()
  const legacyJournal = new DatabaseSync(join(root, "journals", `${journalId}.sqlite`))
  legacyJournal.prepare("UPDATE metadata SET value=json_set(value, '$.session.modes[0].enforcement', 'host') WHERE id=1").run()
  legacyJournal.close()
  const reopened = new LiveJournal(join(root, "journals"), journalId)
  assert.deepEqual(reopened.read()?.session.modes, [modes[1]], "legacy history stays readable without reviving host-enforced choices")
  reopened.close()

  // --- Live conversations write and read the ledger ----------------------------
  await liveConversationsRoundTrip()
  await reconnectAfterRestart()
  await reconnectAfterOwnTurn()
  await backfillFromJournals()
  await newerLedger()
  console.log("Session memory: legacy route retirement, cross-host settings and mode recall, store-first merge, holds with takeover and expiry, catalog overlay, refused resume, journal mode ladder, live conversation round trip, reconnect past a moved record, quiet reconnect after an interrupted turn, journal backfill, a newer Mako's ledger read and its facts taken after the update")
} finally {
  installed.close()
  dev.close()
  rmSync(root, { recursive: true, force: true })
}

async function liveConversationsRoundTrip() {
  const applied: string[] = []
  const starts: string[] = []
  const launched: (string | undefined)[] = []
  const launchedModels: Array<string | undefined> = []
  const state = (id: string, extra: Partial<LiveSessionState> = {}): LiveSessionState => ({
    id,
    nativeId: "agent-live",
    harness: "cursor",
    cwd: "/repo",
    status: "ready",
    connection: "connected",
    modes: [
      { id: "agent", name: "Agent", access: "ask", enforcement: "provider" },
      { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
    ],
    currentMode: "agent",
    configOptions: [],
    settings: { model: "claude-fable-5-1", options: { effort: "high" } },
    ...extra,
  })
  let events: (event: import("@mako/host/contracts/live-conversations").LiveDriverEvent) => void = () => {}
  const driver: ProviderLiveDriver = {
    ...FIXTURE_CAPABILITIES,
    ...noCapabilities,
    resume: fixtureResume(),
    provider: "cursor",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push(options.conversationId)
      launched.push(options.modeId)
      launchedModels.push(options.tuning?.model)
      assert.ok(options.emit, "the host listens to the provider it starts")
      events = options.emit
      return state(options.conversationId)
    },
    prompt: async () => {},
    permission: async () => {},
    cancel: async () => {},
    close: () => {},
    setMode: async (_id, modeId) => {
      applied.push(modeId)
    },
  }
  const common = { appPath: root, driver: () => driver, history: async () => null, emit: () => {} }
  const first = new LiveConversations({ ...common, root: join(root, "installed"), memory: installed })
  const second = new LiveConversations({ ...common, root: join(root, "dev"), memory: dev })
  const id = randomUUID()
  try {
    // The host applies the mode the ledger remembers when the renderer sends none.
    installed.remember("cursor", "agent-live", {
      modeId: "access:full",
      settings: {
        model: "remembered-model",
        options: { effort: "high" },
      },
    })
    await first.start("cursor", "/repo", { conversationId: id, resume: "agent-live" })
    await tick()
    await tick()
    assert.deepEqual(launched, ["access:full"], "the remembered tier travels into the launch itself")
    assert.deepEqual(
      launchedModels,
      ["remembered-model"],
      "remembered settings reach process launch when the caller sends none"
    )
    assert.deepEqual(applied, ["access:full"], "a reopened session is put back in the tier it last ran under")
    assert.equal(first.snapshot(id)?.session.currentMode, "access:full")
    const recalled = dev.recall("cursor", "agent-live")
    assert.deepEqual(recalled?.settings, { model: "claude-fable-5-1", options: { effort: "high" } }, "the connected session's settings reach the ledger")
    assert.equal(recalled?.modeId, "access:full")
    assert.equal(dev.heldBy("cursor", "agent-live")?.hostLabel, "the installed Mako app", "the live session is held by the host running it")
    installed.release("cursor", "agent-live", id)
    assert.equal(dev.heldBy("cursor", "agent-live"), null)
    assert.equal(first.connectedSession("cursor", "agent-live"), id, "local attachment finds the real driver without a ledger entry")
    assert.equal(dev.heldBy("cursor", "agent-live")?.conversationId, id, "lookup repairs the missing ownership record")
    installed.release("cursor", "agent-live", id)
    events({ type: "live-session", session: state(id) })
    first.snapshot(id)
    assert.equal(dev.heldBy("cursor", "agent-live")?.conversationId, id, "unchanged session observations retry a missing hold")

    // A second host is refused before its driver starts anything.
    await assert.rejects(
      second.start("cursor", "/repo", { conversationId: randomUUID(), resume: "agent-live" }),
      (error: Error) => error.message === heldReason("the installed Mako app")
    )
    assert.equal(starts.length, 1, "the refused host spawned nothing")

    // Changes while connected are remembered as they happen.
    events({ type: "live-session", session: state(id, { currentMode: "agent", settings: { model: "gpt-5.3-codex" } }) })
    first.snapshot(id)
    await tick()
    assert.equal(dev.recall("cursor", "agent-live")?.modeId, "agent")
    assert.equal(dev.recall("cursor", "agent-live")?.settings?.model, "gpt-5.3-codex")

    // Closing lets go; the facts stay.
    await first.close(id)
    assert.equal(dev.heldBy("cursor", "agent-live"), null, "a closed session releases its hold")
    assert.equal(dev.recall("cursor", "agent-live")?.settings?.model, "gpt-5.3-codex", "what it ran as is still known after it closes")
    const other = randomUUID()
    await second.start("cursor", "/repo", { conversationId: other, resume: "agent-live" })
    await tick()
    await tick()
    assert.equal(installed.heldBy("cursor", "agent-live")?.hostLabel, "Mako's dev host", "the other host may reopen it once released")
    assert.deepEqual(applied, ["access:full"], "the provider's own current mode needs no re-application")
    second.stop()
    await tick()
    assert.equal(installed.heldBy("cursor", "agent-live"), null, "stopping a host releases a hold after its provider exits")

    // A failed start releases the hold it took.
    const failing = new LiveConversations({
      ...common,
      root: join(root, "failing"),
      memory: dev,
      driver: () => ({ ...driver, start: async () => { throw new Error("no auth") } }),
    })
    const failed = randomUUID()
    await failing.start("cursor", "/repo", { conversationId: failed, resume: "agent-live" })
    await tick()
    await tick()
    assert.equal(failing.snapshot(failed)?.session.status, "failed")
    assert.equal(installed.heldBy("cursor", "agent-live"), null, "a start that failed is not still holding the session")
    failing.stop()

    // A launch-enforced tier (OpenCode's Ask, Grok's ladder) is read once from
    // the process environment; the driver refuses to change it on a running
    // session. The ledger's memory must therefore reach the launch, not setMode.
    const launchOnly = new LiveConversations({
      ...common,
      root: join(root, "launch-only"),
      memory: dev,
      driver: () => ({
        ...driver,
        provider: "opencode",
        start: async (_cwd, options) => ({
          ...state(options.conversationId, { harness: "opencode", nativeId: "ses_launch" }),
          modes: [{ id: "access:ask", name: "Ask before acting", access: "ask", enforcement: "launch" }],
          currentMode: options.modeId ?? null,
        }),
        setMode: async () => {
          throw new Error("opencode reads Ask before acting when its session starts.")
        },
      }),
    })
    dev.remember("opencode", "ses_launch", { modeId: "access:ask" })
    const reopened = randomUUID()
    await launchOnly.start("opencode", "/repo", { conversationId: reopened, resume: "ses_launch" })
    await tick()
    await tick()
    assert.equal(launchOnly.snapshot(reopened)?.session.status, "ready", `a launch-only tier is applied at launch, never refused afterwards: ${launchOnly.snapshot(reopened)?.session.error}`)
    assert.equal(launchOnly.snapshot(reopened)?.session.currentMode, "access:ask")
    launchOnly.stop()
  } finally {
    first.stop()
    second.stop()
  }
}
