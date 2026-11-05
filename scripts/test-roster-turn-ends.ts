import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { backgroundWork } from "@mako/host/contracts/background-work"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { isActiveNativeAgent, type NativeAgent } from "@mako/host/contracts/native-agents"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import { RETRIES_EXHAUSTED_STOP, type LiveSessionState } from "@mako/host/contracts/providers-acp"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { endedTurnsOnRead } from "@mako/host/conversations/live-records"
import type { BackgroundStop, ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

/**
 * A Cursor conversation of 2026-10-31, replayed: a turn starts five `task`
 * subagents and the person stops it; the next starts five more and fails
 * with SDK 1.2.0's no-progress error; a later turn finishes; the host
 * restarts. A build before `ends-with-turn` was enforced kept all ten
 * "working" in memory and in the journal, so the transcript said "Waiting
 * on 10 agents" for a day with nothing running. This build ends them with
 * their turns as the turns end, and heals what an older build saved when it
 * reads the journal, whether that build left them working or, on its way
 * out, as lost.
 */

const GAVE_UP = "Agent turn stopped after repeated resume attempts made no progress"
const SUBAGENTS = ["Offline Mac threads", "Compact live sync", "Same project order", "Machine items", "Client items"]

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}

function harness(root: string, backgroundStop: BackgroundStop) {
  const emitters: Array<(event: LiveDriverEvent) => void> = []
  const emit = (event: LiveDriverEvent) => emitters.at(-1)?.(event)
  const session = (bindingId: string, patch: Partial<LiveSessionState> = {}): LiveSessionState => ({
    id: bindingId, nativeId: "cursor-agent", harness: "cursor", cwd: root,
    status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], ...patch,
  })
  let turn = 0
  let running: string | undefined
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    nativeAgents: { kind: "observed", via: "Injected driver fixture" },
    backgroundStop,
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "cursor",
    available: () => true,
    start: async (_cwd, options) => {
      if (options.emit) emitters.push(options.emit)
      return session(options.conversationId)
    },
    prompt: async (bindingId, _text, _attachments, _settings, dispatch) => {
      dispatch.report({ kind: "submitted", source: "transport-call" })
      dispatch.report({ kind: "accepted", source: "native-response", referenceId: `run-${turn}` })
      running = bindingId
      emit({ type: "live-session", session: session(bindingId, { status: "running", nativeRunId: `run-${turn}` }) })
      const at = turn++
      if (at < 2)
        for (const [index, title] of SUBAGENTS.entries())
          emit({ type: "live-agent", id: bindingId, agent: { nativeId: `child-${at}-${index}`, nativeRunId: `task-${at}-${index}`, toolId: `task-${at}-${index}`, title, state: { kind: "working", activity: "Reading the code" } } })
      // The second turn's stream was cut and its resumes made no progress.
      if (at === 1) emit({ type: "live-session", session: session(bindingId, { status: "failed", lastStop: RETRIES_EXHAUSTED_STOP, error: GAVE_UP }) })
      if (at === 2) emit({ type: "live-session", session: session(bindingId) })
    },
    // Stop ends the run; Cursor doesn't say how its subagents ended.
    cancel: async () => {
      if (running) emit({ type: "live-session", session: session(running, { lastStop: "cancelled" }) })
    },
    permission: async () => {},
    setMode: async () => {},
    close: async () => {},
  }
  return driver
}

function owner(root: string, driver: ProviderLiveDriver) {
  return new LiveConversations({ appPath: root, root: join(root, "journals"), driver: () => driver, history: async () => null, emit: () => {}, providerIdleMs: 60_000 })
}

/** The sequence: five subagents, Stop; five more, the no-progress failure; a turn that finishes. */
async function replay(live: LiveConversations, root: string, id: string): Promise<void> {
  await live.start("cursor", root, { conversationId: id })
  live.submit(id, randomUUID(), "Five workers on the plan")
  await waitFor(() => (live.snapshot(id)?.nativeAgents?.agents.length ?? 0) === 5, "the first turn's five subagents")
  await live.cancel(id)
  await waitFor(() => live.snapshot(id)?.requests[0]?.status === "interrupted", "the first turn stopped")
  live.submit(id, randomUUID(), "Five more")
  await waitFor(() => live.snapshot(id)?.requests[1]?.status === "failed", "the second turn failed")
  // By its own id: a failed turn may leave a continuation waiting, which this message takes the place of.
  const third = randomUUID()
  live.submit(id, third, "Is anything still running?")
  await waitFor(() => live.snapshot(id)?.requests.find((request) => request.id === third)?.status === "completed", "the third turn finished")
}

function working(agents: readonly NativeAgent[] | undefined): number {
  return (agents ?? []).filter(isActiveNativeAgent).length
}

/** First turn's five stopped, second turn's five failed with the turn's error. */
function endedWithTheirTurns(agents: readonly NativeAgent[] | undefined, what: string): void {
  assert.equal(agents?.length, 10, what)
  assert.equal(working(agents), 0, `${what}: no agent is working`)
  for (const agent of agents ?? []) {
    if (agent.nativeId.startsWith("child-0-")) assert.deepEqual(agent.state, { kind: "canceled" }, `${what}: the stopped turn's subagents stopped with it`)
    else assert.deepEqual(agent.state, { kind: "failed", error: `Its turn ended with an error: ${GAVE_UP}` }, `${what}: the failed turn's subagents failed with it`)
    assert.ok(agent.settledAt !== undefined && agent.settledAt <= Date.now(), `${what}: each says when it ended`)
  }
}

const endsWithTurn: BackgroundStop = { kind: "ends-with-turn", evidence: "A run stays running while a subagent it started works." }
const endsOnStop: BackgroundStop = { kind: "ends-on-stop", how: "A build that never ended them: the fixture's children outlive their turn." }

{
  // This build, live: each turn's end ends what it left at work, then a restart changes nothing.
  const root = mkdtempSync(join(tmpdir(), "mako-roster-turns-"))
  const id = randomUUID()
  const driver = harness(root, endsWithTurn)
  const live = owner(root, driver)
  try {
    await replay(live, root, id)
    const snapshot = live.snapshot(id)
    endedWithTheirTurns(snapshot?.nativeAgents?.agents, "as the turns ended")
    assert.equal(backgroundWork(snapshot?.session, snapshot?.nativeAgents), null, "the transcript waits on nothing")
    assert.deepEqual(live.lifecycleWork(), [], "an update or quit waits on nothing")
  } finally {
    live.stop()
  }
  const restarted = owner(root, driver)
  try {
    endedWithTheirTurns(restarted.snapshot(id)?.nativeAgents?.agents, "after a restart")
  } finally {
    restarted.stop()
    rmSync(root, { recursive: true, force: true })
  }
  console.log("PASS: ten Cursor subagents end with the stopped and the failed turn that started them, and stay ended across a restart")
}

for (const exit of ["killed", "quit for the update"] as const) {
  // A build before this one: nothing ended them, so all ten stayed working through a later turn. Its host was then
  // killed, or quit for the update (which closes every conversation, losing track of them). This build reads the journal.
  const root = mkdtempSync(join(tmpdir(), "mako-roster-upgrade-"))
  const id = randomUUID()
  const older = owner(root, harness(root, endsOnStop))
  try {
    await replay(older, root, id)
    const stale = older.snapshot(id)
    assert.equal(working(stale?.nativeAgents?.agents), 10, "the older build's roster: ten still working")
    assert.equal(backgroundWork(stale?.session, stale?.nativeAgents)?.count, 10, "its transcript said: Waiting on 10 agents")
    assert.equal(older.lifecycleWork()[0]?.status, "running", "and an update would have waited on them")
    if (exit === "quit for the update") await older.closeForExit()
  } finally {
    older.stop()
  }
  const upgraded = owner(root, harness(root, endsWithTurn))
  try {
    const snapshot = upgraded.snapshot(id)
    endedWithTheirTurns(snapshot?.nativeAgents?.agents, `read by this build after the older one was ${exit}`)
    assert.equal(backgroundWork(snapshot?.session, snapshot?.nativeAgents), null)
  } finally {
    upgraded.stop()
    rmSync(root, { recursive: true, force: true })
  }
  console.log(`PASS: ten subagents an older build saved as working are read as ended with their turns, after it was ${exit}`)
}

{
  // A harness whose children may outlive their turn keeps them as it said; the read heals only what can't run on.
  const agent = (requestId: string | undefined, state: NativeAgent["state"], provider = "cursor"): NativeAgent => ({
    nativeId: "child", title: "Child", bindingId: "binding", provider, requestId, observedAt: 5, startedAt: 1, state,
  })
  const requests = [
    { id: "stopped", text: "", attachments: [], status: "interrupted" as const },
    { id: "running", text: "", attachments: [], status: "dispatching" as const },
  ]
  const read = (agents: NativeAgent[], status: LiveSessionState["status"] = "ready") => endedTurnsOnRead({
    session: { id: "c", harness: "cursor", cwd: "/", status, connection: "connected", modes: [], currentMode: null, configOptions: [] },
    requests,
    nativeAgents: { agents, limited: false },
  }, (provider) => provider === "cursor")?.agents
  assert.equal(read([agent("stopped", { kind: "working" }, "codex")])?.[0]?.state.kind, "working", "a Codex child can outlive its turn: left to its own end")
  assert.equal(read([agent("running", { kind: "working" })], "running")?.[0]?.state.kind, "working", "a turn still running when its host stopped: left to the disconnect")
  assert.deepEqual(read([agent("stopped", { kind: "working" })])?.[0], { ...agent("stopped", { kind: "canceled" }), stoppable: false, settledAt: 5 },
    "ended when it was last heard of, not when the journal was read")
  assert.deepEqual(read([agent("stopped", { kind: "unknown", reason: "The provider's process ended, so how this ended is unknown." })])?.[0]?.state, { kind: "canceled" },
    "lost when its process went, after its turn was stopped: stopped")
  assert.equal(read([agent(undefined, { kind: "working" })])?.[0]?.state.kind, "unknown", "a turn of the harness's own that ended: unknown, not working")
  const completed = agent("stopped", { kind: "completed", summary: "Done" })
  assert.equal(read([completed])?.[0], completed, "an entry that ended by its own end keeps it")
  console.log("PASS: the read heals only entries on a harness where nothing outlives its turn, whose turn had ended")
}
