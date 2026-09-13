import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ThreadRef } from "@mako/sessions"
import { planContinuation } from "../electron/contracts/thread-continuation.js"
import { heldReason } from "../electron/contracts/session-hold.js"
import { LiveConversations } from "../electron/live-conversations.js"
import { LiveJournal } from "../electron/live-journal.js"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.js"
import {
  HOLD_STALE_MS,
  SessionHeldError,
  SessionMemory,
  rememberedSettings,
} from "../electron/session-memory.js"
import type { HostEvent, LiveSessionState } from "../electron/shared.js"
import type { ResumeVerdict, TransferInput } from "../electron/contracts/conversation-control.js"

const root = mkdtempSync(join(tmpdir(), "mako-session-memory-"))
const ledger = join(root, "session-memory.sqlite")
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
async function until(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2_000; attempt += 1) {
    if (condition()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

function fixtureDriver(nativeId: string, starts: string[]): ProviderLiveDriver {
  return {
    canResume: true,
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
    await until(() => after.snapshot(id)?.control?.transfers.some((transfer) => transfer.input.id === moved.id && transfer.state.kind !== "preparing" && transfer.state.kind !== "pending") === true, "the moved reconnect to settle")
    const accepted = after.snapshot(id)?.control?.transfers.find((transfer) => transfer.input.id === moved.id)
    assert.equal(accepted?.state.kind, "accepted", `a record that moved while the host was away still reconnects: ${JSON.stringify(accepted?.state)}`)
    assert.equal(starts.length, 2, "the provider was started once for the reconnect")
    assert.ok(notices.some((message) => message.includes("moved while Mako was away")), "the transcript gap is said out loud")
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
  const seen = dev.heldBy("cursor", "agent-1")
  assert.equal(seen?.hostLabel, "the installed Mako app")
  assert.equal(seen?.conversationId, "conv-a")
  assert.throws(() => dev.hold("cursor", "agent-1", "conv-b"), (error: Error) => error instanceof SessionHeldError && error.message === heldReason("the installed Mako app"))
  installed.hold("cursor", "agent-1", "conv-a")
  assert.equal(dev.heldBy("cursor", "agent-1")?.since, now, "re-holding keeps the original since")
  installed.release("cursor", "agent-1", "conv-other")
  assert.ok(dev.heldBy("cursor", "agent-1"), "a release scoped to another conversation drops nothing")
  installed.release("cursor", "agent-1", "conv-a")
  assert.equal(dev.heldBy("cursor", "agent-1"), null)
  dev.hold("cursor", "agent-1", "conv-b")
  assert.equal(installed.heldBy("cursor", "agent-1")?.hostLabel, "Mako's dev host")
  dev.release("cursor", "agent-1")
  installed.release("cursor", "agent-1")

  // A crashed host's hold is taken over; a stale heartbeat is treated the same.
  installed.hold("cursor", "agent-2", "conv-c")
  alive.delete(100)
  assert.equal(dev.heldBy("cursor", "agent-2"), null, "a dead host holds nothing")
  dev.hold("cursor", "agent-2", "conv-d")
  alive.add(100)
  assert.equal(installed.heldBy("cursor", "agent-2")?.hostLabel, "Mako's dev host", "the takeover is the live hold now")
  now += HOLD_STALE_MS + 1
  assert.equal(installed.heldBy("cursor", "agent-2"), null, "a hold without a heartbeat expires even while the pid lives")
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

  // --- Journal keeps the mode ladder -------------------------------------------
  const journalId = randomUUID()
  const journal = new LiveJournal(join(root, "journals"), journalId)
  const modes = [
    { id: "access:full", name: "Full access", access: "full" as const, enforcement: "host" as const, description: "Mako approves every request." },
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

  // --- Live conversations write and read the ledger ----------------------------
  await liveConversationsRoundTrip()
  await reconnectAfterRestart()
  await backfillFromJournals()
  console.log("Session memory: cross-host settings and mode recall, store-first merge, holds with takeover and expiry, catalog overlay, refused resume, journal mode ladder, live conversation round trip, reconnect past a moved record, journal backfill")
} finally {
  installed.close()
  dev.close()
  rmSync(root, { recursive: true, force: true })
}

async function liveConversationsRoundTrip() {
  const applied: string[] = []
  const starts: string[] = []
  const launched: (string | undefined)[] = []
  const state = (id: string, extra: Partial<LiveSessionState> = {}): LiveSessionState => ({
    id,
    nativeId: "agent-live",
    harness: "cursor",
    cwd: "/repo",
    status: "ready",
    connection: "connected",
    modes: [
      { id: "agent", name: "Agent", access: "ask", enforcement: "provider" },
      { id: "access:full", name: "Full access", access: "full", enforcement: "host" },
    ],
    currentMode: "agent",
    configOptions: [],
    settings: { model: "claude-fable-5-1", options: { effort: "high" } },
    ...extra,
  })
  let events: (event: import("../electron/shared.js").LiveDriverEvent) => void = () => {}
  const driver: ProviderLiveDriver = {
    canResume: true,
    provider: "cursor",
    available: () => true,
    start: async (_cwd, options) => {
      starts.push(options.conversationId)
      launched.push(options.modeId)
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
    installed.remember("cursor", "agent-live", { modeId: "access:full" })
    await first.start("cursor", "/repo", { conversationId: id, resume: "agent-live" })
    await tick()
    await tick()
    assert.deepEqual(launched, ["access:full"], "the remembered tier travels into the launch itself")
    assert.deepEqual(applied, ["access:full"], "a reopened session is put back in the tier it last ran under")
    assert.equal(first.snapshot(id)?.session.currentMode, "access:full")
    const recalled = dev.recall("cursor", "agent-live")
    assert.deepEqual(recalled?.settings, { model: "claude-fable-5-1", options: { effort: "high" } }, "the connected session's settings reach the ledger")
    assert.equal(recalled?.modeId, "access:full")
    assert.equal(dev.heldBy("cursor", "agent-live")?.hostLabel, "the installed Mako app", "the live session is held by the host running it")

    // A second host is refused before its driver starts anything.
    await assert.rejects(
      second.start("cursor", "/repo", { conversationId: randomUUID(), resume: "agent-live" }),
      (error: Error) => error.message === heldReason("the installed Mako app")
    )
    assert.equal(starts.length, 1, "the refused host spawned nothing")

    // Changes while connected are remembered as they happen.
    events({ type: "acp-session", session: state(id, { currentMode: "agent", settings: { model: "gpt-5.3-codex" } }) })
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
    assert.equal(installed.heldBy("cursor", "agent-live"), null, "stopping a host releases every hold it had")

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
