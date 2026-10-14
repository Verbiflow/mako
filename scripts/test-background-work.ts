import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeAgents } from "@mako/host/harnesses/claude/sdk-agents"
import { ClaudeDecoder } from "@mako/host/harnesses/claude/decoder"
import {
  disconnectNativeAgents,
  observeNativeAgent,
  NativeAgentRosterSchema,
  type NativeAgentObservation,
  type NativeAgentRoster,
} from "@mako/host/contracts/native-agents"
import { backgroundWork, backgroundWorkText } from "@mako/host/contracts/background-work"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { reconcileRoster } from "../src/lib/native-roster.ts"
import { presenceThreadStatus, foldedThreadState, sessionStateText, type FoldRow } from "../src/lib/thread-fold.ts"
import { boardBucketOf } from "../src/lib/thread-board.ts"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"
import { grokBackground } from "@mako/host/harnesses/grok/background"
import { devinBackground } from "@mako/host/harnesses/devin/background"

// What a session runs after its turn ended, from the provider's own
// messages to the state the window shows: the roster each driver keeps,
// the derived "waiting on background work" state, and how the host
// conflates a roster's progress.

interface Captured { source: string; messages: { at: number; message: SDKMessage }[] }
function fixture(name: string): Captured {
  // SAFETY: the fixtures are SDK messages recorded from the Agent SDK's own stream and only trimmed, so each is an `SDKMessage`.
  return JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/background-work", name), "utf8")) as Captured
}

/** Replays a capture through the driver's projection, as the host stamps it, and the decoder's count. */
function replay(capture: Captured, stopAt?: (message: SDKMessage, index: number) => boolean) {
  const agents = new ClaudeAgents()
  const decoder = new ClaudeDecoder({ get state() { return state } })
  let state: Pick<LiveSessionState, "currentMode" | "usage" | "settings" | "commands" | "backgroundTasks"> = { currentMode: null }
  let roster: NativeAgentRoster | undefined
  let status: LiveSessionState["status"] = "running"
  for (const [index, { at, message }] of capture.messages.entries()) {
    for (const observed of agents.project(message))
      roster = observeNativeAgent(roster, { ...observed, bindingId: "binding", provider: "claude", observedAt: 1_000_000 + at })
    // The capture keeps only what the roster reads; the decoder's count comes from the level.
    if (message.type === "system" && message.subtype === "background_tasks_changed")
      for (const decoded of decoder.decode(message))
        if (decoded.kind === "state") state = { ...state, ...decoded.patch }
    if (message.type === "result") status = "ready"
    if (message.type === "system" && message.subtype === "init") status = "running"
    if (stopAt?.(message, index)) break
  }
  const session = { status, connection: "connected" as const, backgroundTasks: state.backgroundTasks }
  return { agents, roster, session, work: backgroundWork(session, roster) }
}

{
  // Claude Code 2.1.29x, captured: a background Bash, a background Agent and
  // a Monitor, then the first turn ends with all three still running.
  const capture = fixture("claude-shell-agent-monitor.json")
  const firstResult = capture.messages.findIndex(({ message }) => message.type === "result")
  const ended = replay(capture, (_, index) => index === firstResult)
  assert.equal(ended.session.status, "ready", "the turn ended")
  assert.ok(ended.work, "the session waits on background work: not done, not running")
  assert.equal(ended.work.count, 3)
  assert.equal(ended.work.unnamed, 0, "every task the level counts is named in the roster")
  assert.deepEqual(ended.work.named.map((agent) => [agent.work, agent.title]), [
    ["command", "25-second sleep"],
    ["agent", "Sleep check"],
    ["monitor", "Tick watch"],
  ], "the Monitor reports as local_bash and is read as a monitor from the tool that started it")
  assert.equal(backgroundWorkText(ended.work), "3 background tasks")
  const command = ended.work.named[0]
  assert.equal(command?.detail, "sleep 25; echo bash-done", "a command carries its command line")
  assert.equal(command?.stoppable, true)
  assert.equal(command?.background, true)
  assert.match(command?.source ?? "", /^claude task_started local_bash/)

  // The subagent's own Bash is the subagent's: progress counts it, the roster doesn't list it.
  const progressed = replay(capture, (message) => message.type === "system" && message.subtype === "task_progress")
  const agent = progressed.roster?.agents.find((entry) => entry.work === "agent")
  assert.equal(agent?.title, "Sleep check", "progress never renames the agent")
  assert.equal(agent?.usage?.toolUses, 1)
  assert.equal(agent?.state.kind === "working" && agent.state.activity, "Running Sleep for 12 seconds then echo agent-sleep")
  const all = replay(capture)
  assert.equal(all.roster?.agents.length, 3, "the subagent's foreground Bash is not a roster entry")
  assert.equal(all.work, null, "everything settled: nothing to wait on")
  assert.deepEqual(all.roster?.agents.map((entry) => entry.state), [
    { kind: "completed", summary: "Exited with code 0" },
    { kind: "completed", summary: "agent-sleep" },
    { kind: "completed" },
  ], "a command says how it exited, an agent gives its report, a monitor's events were its news")
  assert.ok(all.roster?.agents.every((entry) => entry.settledAt !== undefined && entry.stoppable === false))
  assert.deepEqual(all.roster?.agents.find((entry) => entry.work === "agent")?.state, { kind: "completed", summary: "agent-sleep" },
    "an agent's report is its result")
}

{
  // With partial messages on (as Mako launches Claude), a Monitor's task can
  // start before the assistant message holding its call arrives whole; the
  // call, once it does, names the entry a monitor.
  const capture = fixture("claude-shell-agent-monitor.json")
  const monitorCall = capture.messages.find(({ message }) => message.type === "assistant" && message.message.content.some((block) => block.type === "tool_use" && block.name === "Monitor"))
  const reordered = capture.messages.filter((entry) => entry !== monitorCall)
  const started = reordered.findIndex(({ message }) => message.type === "system" && message.subtype === "task_started" && message.description === "Tick watch")
  assert.ok(monitorCall && started > 0)
  reordered.splice(started + 1, 0, monitorCall)
  const early = replay({ ...capture, messages: reordered }, (_, index) => index === started)
  assert.equal(early.roster?.agents.find((agent) => agent.title === "Tick watch")?.work, "command", "before its call arrives it reads as the local_bash it reports")
  const named = replay({ ...capture, messages: reordered }, (_, index) => index === started + 1)
  const monitor = named.roster?.agents.find((agent) => agent.title === "Tick watch")
  assert.equal(monitor?.work, "monitor")
  assert.equal(monitor?.detail, "for i in 1 2; do sleep 9; echo tick $i; done")
}

{
  // A background command stopped with `stopTask`: canceled, no longer stoppable, nothing to wait on.
  const stopped = replay(fixture("claude-stop-task.json"))
  assert.equal(stopped.roster?.agents[0]?.state.kind, "canceled")
  assert.equal(stopped.roster?.agents[0]?.stoppable, false)
  assert.equal(stopped.work, null)
}

{
  // A missed end cannot wedge the roster: a background entry the level
  // drops with no notification settles as unknown at the next turn end.
  const agents = new ClaudeAgents()
  const base = { uuid: "00000000-0000-4000-8000-000000000001" as const, session_id: "s" }
  agents.project({ ...base, type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "t1", task_type: "local_bash", description: "sleep 9" }] })
  const listed = agents.get("t1")
  assert.equal(listed?.state.kind, "working", "a task the level names is listed even before its start arrives")
  assert.equal(listed?.source, "claude background_tasks_changed local_bash")
  assert.deepEqual(agents.project({ ...base, type: "system", subtype: "background_tasks_changed", tasks: [] }), [], "a drop alone settles nothing: the notification follows it")
  const result = fixture("claude-stop-task.json").messages.find(({ message }) => message.type === "result")?.message
  assert.ok(result)
  const settled = agents.project(result)
  assert.equal(settled[0]?.state.kind, "unknown")
  // An ambient watcher is listed, flagged, and never counted.
  const ambient = agents.project({ ...base, type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w", task_type: "monitor", description: "live update watcher", ambient: true }] })
  assert.equal(ambient[0]?.ambient, true)
  const roster = observeNativeAgent(undefined, { ...ambient[0]!, bindingId: "b", provider: "claude", observedAt: 1 })
  assert.equal(backgroundWork({ status: "ready", connection: "connected", backgroundTasks: 0 }, roster), null,
    "a watcher the provider calls ambient never makes a session look busy")
  // The level flips a task's ambient flag.
  const flipped = agents.project({ ...base, type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "w", task_type: "monitor", description: "live update watcher", ambient: false }] })
  assert.equal(flipped[0]?.ambient, false)
}

{
  // The derived state, for every harness alike.
  const entry = (nativeId: string, work: NativeAgentObservation["work"], state: NativeAgentObservation["state"] = { kind: "working" }) =>
    ({ nativeId, title: nativeId, work, state, bindingId: "b", provider: "p", observedAt: 1 })
  let roster: NativeAgentRoster | undefined
  for (const agent of [entry("a", "command"), entry("b", "command"), entry("c", "agent"), entry("d", "agent", { kind: "completed" })])
    roster = observeNativeAgent(roster, agent)
  const ready = { status: "ready" as const, connection: "connected" as const }
  assert.equal(backgroundWorkText(backgroundWork(ready, roster)!), "2 commands and an agent")
  assert.equal(backgroundWork({ ...ready, status: "running" }, roster), null, "a running turn is working, whatever else runs")
  assert.equal(backgroundWork({ ...ready, connection: "disconnected" }, roster), null, "a gone process waits on nothing")
  assert.equal(backgroundWork({ ...ready, connection: "hibernated" }, roster), null)
  const counted = backgroundWork({ ...ready, backgroundTasks: 5 }, roster)
  assert.equal(counted?.count, 5, "the provider's own count wins when it names fewer")
  assert.equal(counted?.unnamed, 2)
  assert.equal(backgroundWorkText(counted!), "5 background tasks")
  assert.equal(backgroundWorkText(backgroundWork({ ...ready, backgroundTasks: 1 }, undefined)!), "1 background task")
  assert.equal(roster?.agents.find((agent) => agent.nativeId === "d")?.settledAt, 1, "a settled entry is stamped when it settles")
}

{
  // The window's status: a distinct, calm state between running and done.
  const presence = { key: "k", harness: "claude", cwd: "/", createdAt: 1, status: "background" as const, background: 2 }
  const status = presenceThreadStatus(presence)
  assert.deepEqual(status, { kind: "background", count: 2 })
  assert.equal(sessionStateText(status), "waiting on 2 background tasks")
  assert.equal(boardBucketOf(status).bucket, "working", "the Status board keeps it with work under way")
  const folded = foldedThreadState(
    [{ kind: "live", key: "a", presence: { ...presence, key: "a" } }, { kind: "live", key: "b", presence: { ...presence, key: "b", status: "running" } }] satisfies FoldRow[],
    () => ({ kind: "idle" })
  )
  assert.equal(folded.status.kind, "working", "a running turn outranks waiting work in a folded row")
  const waiting = foldedThreadState(
    [{ kind: "live", key: "a", presence: { ...presence, key: "a" } }, { kind: "live", key: "b", presence: { ...presence, key: "b", status: "ready" } }] satisfies FoldRow[],
    () => ({ kind: "idle" })
  )
  assert.equal(waiting.status.kind, "background", "waiting work outranks an idle session")
}

{
  // The renderer keeps an unchanged entry's identity, so one subagent's
  // progress wakes one row of the Agents panel, not all of them.
  let roster: NativeAgentRoster | undefined
  for (let index = 0; index < 50; index++)
    roster = observeNativeAgent(roster, { nativeId: `t${index}`, title: `t${index}`, state: { kind: "working" }, bindingId: "b", provider: "p", observedAt: index })
  const wire = (value: NativeAgentRoster) => NativeAgentRosterSchema.parse(JSON.parse(JSON.stringify(value)))
  const held = wire(roster!)
  const moved = observeNativeAgent(roster, { nativeId: "t7", title: "t7", state: { kind: "working", activity: "Reading" }, bindingId: "b", provider: "p", observedAt: 999 })
  const next = reconcileRoster(held, wire(moved))
  assert.ok(next)
  const kept = next.agents.filter((agent, index) => agent === held.agents[index]).length
  assert.equal(kept, 49, "only the moved entry is a new object")
  assert.equal(reconcileRoster(held, wire(roster!)), held, "an unchanged roster keeps its identity whole")
  const lost = reconcileRoster(held, wire(disconnectNativeAgents(roster, "b")!))
  assert.ok(lost?.agents.every((agent) => agent.state.kind === "unknown"), "a lost connection reaches every row, though it observes nothing")
}

{
  // Grok names each task in its level list; only what moved is observed again.
  // Field names as grok 1.0.46 keeps them in its own `updates.jsonl`.
  const grok = grokBackground()
  const tasks = (statuses: [string, number | null][]) => ({
    sessionId: "g",
    update: {
      sessionUpdate: "background_tasks",
      tasks: statuses.map(([status, exit], index) => ({
        task_id: `task-${index}`, command: index ? "tail -f build.log" : "sleep 25", description: index ? "Watch the build" : "Sleep briefly",
        kind: index ? "monitor" : "bash", status, started_at: "2026-10-12T05:00:00Z", output_file: "/tmp/out", exit_code: exit,
      })),
    },
  })
  const first = grok.extension?.("_x.ai/session_notification", tasks([["running", null], ["running", null]]))
  assert.equal(first?.running, 2)
  assert.deepEqual(first?.items?.map((item) => [item.work, item.title, item.state.kind, item.stoppable]), [
    ["command", "Sleep briefly", "working", false],
    ["monitor", "Watch the build", "working", false],
  ], "Grok's own kill queues a turn, so no entry offers to stop alone")
  const second = grok.extension?.("_x.ai/session_notification", tasks([["completed", 0], ["running", null]]))
  assert.deepEqual(second?.items?.map((item) => [item.nativeId, item.state]), [["task-0", { kind: "completed", summary: "Exited with code 0" }]])
  assert.equal(second?.running, 1)
}

{
  // Devin: the opening tool_call names the shell; the update that backgrounds it does not.
  const devin = devinBackground()
  const id = "call_1#shell"
  devin.sessionUpdate?.({ sessionId: "d", update: { sessionUpdate: "tool_call", toolCallId: id, title: "Ran sleep", kind: "execute", rawInput: { command: "sleep 30" } } })
  const started = devin.sessionUpdate?.({ sessionId: "d", update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "in_progress", _meta: { "cognition.ai/inferenceToolName": "exec", "cognition.ai/background": true, "cognition.ai/backgroundShellId": "e58de2" } } })
  assert.equal(started?.running, 1)
  assert.deepEqual(started?.items?.map((item) => [item.title, item.detail, item.stoppable]), [["Ran sleep", "sleep 30", true]])
  const calls: unknown[] = []
  await devin.stopOne?.({ sessionId: "d", running: 1, request: async (method, params) => { calls.push([method, params]) }, reopen: async () => {} }, id)
  assert.deepEqual(calls, [["_cognition.ai/terminal/killBackgroundShell", { sessionId: "d", shellId: "e58de2" }]], "one shell stops through Devin's own kill")
  const ended = devin.sessionUpdate?.({ sessionId: "d", update: { sessionUpdate: "tool_call_update", toolCallId: id, status: "completed", _meta: { terminal_exit: { terminal_id: "e58de2", exit_code: -1, signal: null } } } })
  assert.deepEqual(ended?.items?.[0]?.state, { kind: "completed", summary: "Exited with code -1" })
  assert.equal(ended?.running, 0)
}

// The host: a roster entry's progress shares the frame; its start and end flush at once.
{
  const root = mkdtempSync(join(tmpdir(), "mako-background-work-"))
  const id = randomUUID()
  const session: LiveSessionState = {
    id, nativeId: "parent", harness: "fixture", cwd: root, status: "ready", connection: "connected",
    modes: [], currentMode: null, configOptions: [],
  }
  const stops: string[] = []
  const events: HostEvent[] = []
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    resume: fixtureResume(),
    approvalEvidence: { kind: "submission-only", reason: "Injected driver fixture" },
    launchEnvironment: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeIdentity: { kind: "unavailable", reason: "Injected driver fixture" },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: "Injected driver fixture", feedback: { kind: "next-message", reason: "Injected driver fixture" } },
    backgroundStop: { kind: "ends-on-stop", how: "Injected driver fixture" },
    stopNativeAgent: async (_binding, nativeId) => { stops.push(nativeId) },
    turnRecovery: { kind: "manual", reason: "Injected driver fixture" },
    provider: "fixture",
    available: () => true,
    start: async () => session,
    prompt: async () => {},
    permission: async () => {},
    // Claude's Stop closes the process, which reports only its disconnect.
    cancel: async () => { owner.observe({ type: "live-session", session: { ...session, connection: "disconnected" } }) },
    setMode: async () => {},
    close() {},
  }
  const owner: LiveConversations = new LiveConversations({ root, appPath: root, driver: () => driver, history: async () => null, emit: (event: HostEvent) => events.push(event) })
  try {
    await owner.start("fixture", root, { conversationId: id })
    const batches = () => events.filter((event) => event.type === "live-batch" && event.batch.nativeAgents).length
    const agent: NativeAgentObservation = { nativeId: "sub", title: "Explore", work: "agent", background: true, stoppable: true, state: { kind: "working" } }
    owner.observe({ type: "live-agent", id, agent })
    assert.equal(batches(), 1, "a start flushes at once")
    const started = performance.now()
    const PROGRESS = 500
    for (let index = 0; index < PROGRESS; index++)
      owner.observe({ type: "live-agent", id, agent: { ...agent, state: { kind: "working", activity: `step ${index}` }, usage: { toolUses: index } } })
    const observeMs = performance.now() - started
    assert.equal(batches(), 1, "progress waits for the frame")
    await new Promise((resolve) => setTimeout(resolve, 40))
    assert.equal(batches(), 2, `${PROGRESS} progress messages leave as one batch`)
    const last = events.findLast((event) => event.type === "live-batch" && event.batch.nativeAgents)
    assert.ok(last?.type === "live-batch")
    assert.equal(last.batch.nativeAgents?.agents[0]?.usage?.toolUses, PROGRESS - 1)
    const settled = owner.snapshot(id)
    assert.ok(settled && backgroundWork(settled.session, settled.nativeAgents)?.count === 1, "the host's snapshot waits on the agent")
    assert.equal(await owner.stopNativeAgent(id, "sub"), true, "one task stops through its driver")
    assert.deepEqual(stops, ["sub"])
    owner.observe({ type: "live-agent", id, agent: { ...agent, stoppable: false, state: { kind: "canceled" } } })
    assert.equal(batches(), 3, "an end flushes at once")
    assert.equal(await owner.stopNativeAgent(id, "sub"), false, "a task that ended stops nothing")
    assert.equal(await owner.stopNativeAgent(id, "missing"), false)
    owner.observe({ type: "live-agent", id, agent: { ...agent, nativeId: "server", title: "npm run dev", work: "command" } })
    await owner.cancel(id)
    const stopped = owner.snapshot(id)?.nativeAgents?.agents.find((entry) => entry.nativeId === "server")
    assert.equal(stopped?.state.kind, "canceled", "Stop ends background work its driver says it ends: stopped, not \"status unavailable\"")
    assert.ok(stopped?.settledAt)
    console.log(`Roster progress: ${PROGRESS} observations in ${observeMs.toFixed(1)} ms, ${2} batches, ${(observeMs / PROGRESS * 1000).toFixed(0)} µs each`)
  } finally {
    owner.stop()
    rmSync(root, { recursive: true, force: true })
  }
}

console.log("Background work: Claude's captured shell, agent and monitor; stop; level self-heal; ambient; the derived state; status ranking; roster identity; host conflation and per-task stop passed")
