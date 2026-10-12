// Goals end to end through LiveConversations with injected drivers: Mako's
// loop for a harness without a goal (continue, complete, blocked, quiet, Stop,
// a user message first), and a harness's own goal driven by messages (Claude
// Code and Grok) or by calls (Codex). Then each native report as its decoder
// reads it, from the shapes each harness was recorded sending.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import { goalContinuePrompt, goalStartPrompt, observeGoal, readGoalReport, type ConversationGoal, type GoalObservation } from "@mako/host/contracts/live-goals"
import { NO_NATIVE_EXCLUSION } from "@mako/host/contracts/execution-context"
import { NO_NATIVE_PROMPT_IDENTITY } from "@mako/host/contracts/native-prompt-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import type { GoalsCapability, ProviderLiveDriver } from "@mako/host/harnesses/live-driver"
import { codexGoalObservation } from "@mako/host/harnesses/codex/goals"
import { readClaudeGoal } from "@mako/host/harnesses/claude/goals"
import { grokGoal } from "@mako/host/harnesses/grok/goals"
import { fixtureResume, noCapabilities } from "./fixtures/driver-capabilities.ts"

const FIXTURE = "Injected driver fixture"
const OBJECTIVE = "Make the failing parser tests pass"

const waitFor = async (predicate: () => boolean, message: string) => {
  const timeout = Date.now() + 3_000
  while (!predicate()) {
    if (Date.now() >= timeout) throw new Error(message)
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60))

/** What the agent does with one message: reply with words, report a goal, or leave the turn running for Stop. */
type Turn = { text?: string; goal?: GoalObservation | null; hold?: true }

function goalHost(goals: GoalsCapability, turns: (text: string, index: number) => Turn, options: { delayMs?: number; order?: string[] } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mako-live-goals-"))
  const id = randomUUID()
  const sent: string[] = []
  const order = options.order ?? []
  let owner: LiveConversations
  let running: LiveSessionState | undefined
  const state = (status: LiveSessionState["status"], extra: Partial<LiveSessionState> = {}): LiveSessionState => ({
    id, nativeId: id, harness: "test-provider", cwd: root, status, connection: "connected", modes: [], currentMode: null, configOptions: [], ...extra,
  })
  const driver: ProviderLiveDriver = {
    ...noCapabilities,
    approvalEvidence: { kind: "submission-only", reason: FIXTURE },
    launchEnvironment: { kind: "unavailable", reason: FIXTURE },
    nativeIdentity: { kind: "unavailable", reason: FIXTURE },
    nativeExclusion: NO_NATIVE_EXCLUSION,
    nativePromptIdentity: NO_NATIVE_PROMPT_IDENTITY,
    planning: { via: "setting", option: "plan", proposal: FIXTURE, feedback: { kind: "next-message", reason: FIXTURE } },
    backgroundStop: { kind: "ends-with-turn", evidence: FIXTURE },
    turnRecovery: { kind: "manual", reason: FIXTURE },
    resume: fixtureResume(),
    goals,
    provider: "test-provider",
    available: () => true,
    start: async () => state("ready"),
    prompt: async (_id, text) => {
      sent.push(text)
      order.push(`prompt ${text}`)
      const turn = turns(text, sent.length - 1)
      owner.observe({ type: "live-session", session: state("running") })
      if (turn.text) owner.observe({ type: "live-update", id, update: { kind: "text", text: turn.text } })
      if (turn.goal !== undefined) owner.observe({ type: "live-goal", id, goal: turn.goal })
      if (turn.hold) running = state("running")
      else owner.observe({ type: "live-session", session: state("ready") })
    },
    permission: async () => {},
    cancel: async () => {
      order.push("cancel")
      if (!running) return
      running = undefined
      owner.observe({ type: "live-session", session: state("ready", { lastStop: "canceled" }) })
    },
    close: () => {},
    setMode: async () => {},
  }
  owner = new LiveConversations({
    appPath: root,
    root: join(root, "journals"),
    driver: () => driver,
    history: async () => null,
    emit: () => {},
    goalContinueDelayMs: options.delayMs ?? 0,
  })
  return {
    id,
    sent,
    order,
    owner,
    goal: () => owner.snapshot(id)?.goal,
    requests: () => owner.snapshot(id)?.requests ?? [],
    start: (goal?: string) => owner.start("test-provider", root, { conversationId: id, goal }),
    cleanup: () => {
      owner.stop()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

const MAKO: GoalsCapability = { kind: "mako", reason: FIXTURE }

async function makosLoopRunsToCompletion() {
  const host = goalHost(MAKO, (_text, index) => index === 0
    ? { text: "Fixed the tokenizer; two tests still fail.\nGoal: working" }
    : { text: "All parser tests pass.\n**Goal: complete — `npm test` passes, 48 of 48**" })
  try {
    await host.start()
    await host.owner.goal(host.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => host.goal()?.status === "complete", "Mako's loop never reached the goal")
    assert.deepEqual(host.sent, [goalStartPrompt(OBJECTIVE), goalContinuePrompt(OBJECTIVE)], "the goal starts, then Mako continues it once")
    const goal = host.goal()!
    assert.equal(goal.by, "mako")
    assert.equal(goal.turns, 2)
    assert.equal(goal.note, "`npm test` passes, 48 of 48", "the evidence is the note, without the reply's emphasis")
    const [set, next] = host.requests()
    assert.equal(set?.displayText, `/goal ${OBJECTIVE}`, "the transcript shows what the person typed, not Mako's instructions")
    assert.deepEqual(set?.goal, { step: "set" })
    assert.deepEqual(next?.goal, { step: "continue", turn: 2 })
    assert.deepEqual(next?.actor, { kind: "service", name: "goal" }, "continuations are Mako's, not the person's")
    await settle()
    assert.equal(host.sent.length, 2, "a completed goal sends nothing more")
  } finally {
    host.cleanup()
  }
}

async function makosLoopStopsWhenBlockedOrQuiet() {
  const blocked = goalHost(MAKO, () => ({ text: "The fixture server needs credentials.\nGoal: blocked — the staging API key" }))
  try {
    await blocked.start()
    await blocked.owner.goal(blocked.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => blocked.goal()?.status === "blocked", "a blocked report did not block the goal")
    assert.equal(blocked.goal()?.note, "the staging API key")
    await settle()
    assert.equal(blocked.sent.length, 1, "a blocked goal waits for the person")
  } finally {
    blocked.cleanup()
  }
  const quiet = goalHost(MAKO, () => ({}))
  try {
    await quiet.start()
    await quiet.owner.goal(quiet.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => quiet.goal()?.status === "blocked", "turns that do nothing did not stop the loop")
    assert.equal(quiet.sent.length, 2, "the loop gives up after the second empty turn")
    assert.match(quiet.goal()?.note ?? "", /2 turns in a row without replying or doing anything/)
  } finally {
    quiet.cleanup()
  }
}

async function stopPausesMakosLoop() {
  const host = goalHost(MAKO, () => ({ text: "Still working", hold: true }))
  try {
    await host.start()
    await host.owner.goal(host.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => host.owner.snapshot(host.id)?.session.status === "running", "the goal's first turn never ran")
    await host.owner.cancel(host.id)
    await waitFor(() => host.goal()?.status === "paused", "Stop did not pause the goal")
    await settle()
    assert.equal(host.sent.length, 1, "nothing continues a goal the person stopped")
    await assert.rejects(host.owner.goal(host.id, { kind: "pause" }), /There's no running goal to pause\./)
    await host.owner.goal(host.id, { kind: "resume" })
    await waitFor(() => host.sent.length === 2, "resuming an idle goal did not continue it")
    assert.equal(host.sent[1], goalContinuePrompt(OBJECTIVE))
  } finally {
    host.cleanup()
  }
}

async function aUserMessageGoesFirst() {
  const host = goalHost(MAKO, (text) => text === "Use the new fixture" ? { text: "Switched to it." } : { text: "Progress.\nGoal: working" }, { delayMs: 200 })
  try {
    await host.start()
    await host.owner.goal(host.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => host.goal()?.turns === 1, "the goal's first turn did not settle")
    host.owner.submit(host.id, randomUUID(), "Use the new fixture")
    await waitFor(() => host.sent.length === 3, "the loop did not continue after the person's message")
    assert.deepEqual(host.sent.slice(0, 2), [goalStartPrompt(OBJECTIVE), "Use the new fixture"], "the person's message replaced the pending continuation")
    assert.equal(host.sent[2], goalContinuePrompt(OBJECTIVE))
    await host.owner.goal(host.id, { kind: "clear" })
    assert.equal(host.goal(), undefined)
  } finally {
    host.cleanup()
  }
}

/** Grok's message vocabulary (`grok/acp.ts`), with its replies as goal reports. */
const GROK_LIKE: GoalsCapability = {
  kind: "native",
  via: FIXTURE,
  send: (command) => {
    switch (command.kind) {
      case "set": return { via: "message", texts: command.replacing ? ["/goal clear", `/goal ${command.objective}`] : [`/goal ${command.objective}`] }
      case "resume": return { via: "message", texts: command.from === "paused" ? ["/goal resume"] : ["/goal clear", `/goal ${command.objective}`] }
      case "pause": return { via: "message", texts: ["/goal pause"] }
      case "clear": return { via: "message", texts: ["/goal clear"] }
    }
  },
}

async function aHarnessGoalByMessages() {
  let current: string | undefined
  const host = goalHost(GROK_LIKE, (text) => {
    if (text === "/goal clear") {
      current = undefined
      return { text: "Goal cleared.", goal: null }
    }
    if (text === "/goal pause") return { text: "Goal paused.", goal: { objective: current!, status: "paused", note: "Paused by you." } }
    const objective = text.replace(/^\/goal /, "")
    if (objective === "ignored") return { text: "Unknown command." }
    current = objective
    return { text: "Working on the goal.", goal: { objective, status: "active", turns: 1, tokensUsed: 1200 } }
  })
  try {
    await host.start()
    await host.owner.goal(host.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => host.goal()?.pending === undefined, "the harness never confirmed its goal")
    assert.deepEqual(host.sent, [`/goal ${OBJECTIVE}`])
    assert.equal(host.goal()?.by, "harness")
    assert.equal(host.goal()?.tokensUsed, 1200)

    await host.owner.goal(host.id, { kind: "set", objective: "Ship the parser" })
    await waitFor(() => host.goal()?.objective === "Ship the parser" && !host.goal()?.pending, "the replacement goal never settled")
    assert.deepEqual(host.sent.slice(1), ["/goal clear", "/goal Ship the parser"], "Grok clears an unfinished goal before taking a new one")
    assert.equal(host.goal()?.status, "active", "the clear before the new goal didn't drop it")

    await host.owner.goal(host.id, { kind: "pause" })
    await waitFor(() => host.goal()?.status === "paused" && !host.goal()?.pending, "the pause never settled")
    assert.equal(host.goal()?.note, "Paused by you.")

    await host.owner.goal(host.id, { kind: "set", objective: "ignored" })
    await waitFor(() => host.goal()?.status === "blocked", "a goal the harness never took stayed pending")
    assert.equal(host.goal()?.note, "The agent didn't confirm the goal.")

    await host.owner.goal(host.id, { kind: "clear" })
    await waitFor(() => host.goal() === undefined, "the clear never settled")
  } finally {
    host.cleanup()
  }
}

async function stopPausesAHarnessGoalAfterTheTurn() {
  let paused = false
  const host = goalHost(GROK_LIKE, (text) => {
    if (text === "/goal pause") {
      paused = true
      return { goal: { objective: OBJECTIVE, status: "paused" } }
    }
    return { goal: { objective: OBJECTIVE, status: "active" }, hold: true }
  })
  try {
    await host.start()
    await host.owner.goal(host.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => host.goal()?.pending === undefined && host.owner.snapshot(host.id)?.session.status === "running", "the goal never started")
    await host.owner.cancel(host.id)
    await waitFor(() => paused && host.goal()?.status === "paused", "Stop did not pause the harness's goal")
    assert.deepEqual(host.order, [`prompt /goal ${OBJECTIVE}`, "cancel", "prompt /goal pause"], "a pause sent as a message goes once the stopped turn has ended")
  } finally {
    host.cleanup()
  }
}

async function stopPausesACallGoalFirst() {
  const order: string[] = []
  let observe: ((goal: GoalObservation) => void) | undefined
  const codexLike: GoalsCapability = {
    kind: "native",
    via: FIXTURE,
    send: (command) => ({
      via: "call",
      run: async () => {
        order.push(`call ${command.kind}`)
        observe?.(command.kind === "set"
          ? { objective: command.objective, status: "active", tokensUsed: 0, seconds: 0 }
          : { objective: OBJECTIVE, status: command.kind === "pause" ? "paused" : "active" })
      },
    }),
  }
  const host = goalHost(codexLike, () => ({ text: "Working", hold: true }), { order })
  observe = (goal) => host.owner.observe({ type: "live-goal", id: host.id, goal })
  try {
    await host.start()
    await host.owner.goal(host.id, { kind: "set", objective: OBJECTIVE })
    await waitFor(() => host.goal()?.pending === undefined, "Codex's answer did not confirm the goal")
    assert.equal(host.goal()?.status, "active")
    assert.deepEqual(host.sent, [], "Codex starts the goal's turns itself")
    host.owner.submit(host.id, randomUUID(), "Also update the changelog")
    await waitFor(() => host.owner.snapshot(host.id)?.session.status === "running", "the turn never ran")
    await host.owner.cancel(host.id)
    assert.deepEqual(order, ["call set", "prompt Also update the changelog", "call pause", "cancel"], "Codex pauses before the interrupt, so no continuation starts after it")
    assert.equal(host.goal()?.status, "paused")
  } finally {
    host.cleanup()
  }
}

async function aConversationStartsWithAGoal() {
  const host = goalHost(MAKO, () => ({ text: "Done.\nGoal: complete — the parser tests pass" }))
  try {
    await host.start(OBJECTIVE)
    await waitFor(() => host.goal()?.status === "complete", "the goal a conversation started with never ran")
    assert.deepEqual(host.sent, [goalStartPrompt(OBJECTIVE)], "the goal is the conversation's first message")
    assert.equal(host.requests()[0]?.displayText, `/goal ${OBJECTIVE}`)
  } finally {
    host.cleanup()
  }
  const empty = goalHost(MAKO, () => ({}))
  try {
    await assert.rejects(empty.start(" "), /too_small|at least 1/i, "an empty objective refuses the start")
  } finally {
    empty.cleanup()
  }

  const calls: string[] = []
  const codexLike: GoalsCapability = {
    kind: "native",
    via: FIXTURE,
    send: (command) => ({
      via: "call",
      run: async () => {
        calls.push(`${command.kind} while ${native.owner.snapshot(native.id)?.session.status}`)
        if (command.kind === "set") native.owner.observe({ type: "live-goal", id: native.id, goal: { objective: command.objective, status: "active" } })
      },
    }),
  }
  const native = goalHost(codexLike, () => ({}))
  try {
    await native.start(OBJECTIVE)
    await waitFor(() => native.goal()?.status === "active" && !native.goal()?.pending, "Codex's goal was never set on the new conversation")
    assert.deepEqual(calls, ["set while ready"], "a goal set by a call waits for the session to open")
  } finally {
    native.cleanup()
  }
}

function contract() {
  const now = 1_000
  const harness = (goal: Partial<ConversationGoal>): ConversationGoal => ({ objective: OBJECTIVE, status: "active", by: "harness", setAt: 1, updatedAt: 1, ...goal })
  assert.equal(observeGoal(undefined, null, now), undefined)
  assert.equal(observeGoal(harness({ pending: "set" }), null, now)?.pending, "set", "a clear reported before a replacement keeps the pending goal")
  assert.equal(observeGoal(harness({ status: "paused", pending: "pause" }), null, now)?.pending, undefined, "a goal paused by clearing it stays, confirmed")
  assert.equal(observeGoal(harness({ status: "complete" }), null, now)?.status, "complete", "a met goal stays until the person clears it")
  assert.equal(observeGoal(harness({}), null, now), undefined)
  const clearing = harness({ status: "complete", pending: "clear" })
  assert.equal(observeGoal(clearing, { objective: OBJECTIVE, status: "complete" }, now), clearing, "a report from before the clear doesn't settle it")
  const pausing = harness({ status: "paused", pending: "pause" })
  assert.equal(observeGoal(pausing, { objective: OBJECTIVE, status: "active" }, now), pausing, "nor does a report from before the pause")
  assert.equal(observeGoal(harness({ pending: "set" }), { objective: "An older goal", status: "active" }, now)?.objective, OBJECTIVE, "nor one about the goal being replaced")
  assert.equal(observeGoal(harness({ pending: "resume" }), { objective: OBJECTIVE, status: "complete" }, now)?.status, "complete", "a resumed goal can finish at once")
  assert.equal(observeGoal(undefined, { objective: OBJECTIVE, status: "complete" }, now), undefined, "a finished goal Mako has no record of stays gone")
  const kept = harness({ tokensUsed: 5 })
  assert.equal(observeGoal(kept, { objective: OBJECTIVE, status: "active", tokensUsed: 5 }, now), kept, "an unchanged report changes nothing")
  assert.equal(observeGoal(kept, { objective: OBJECTIVE, status: "active", tokensUsed: 9 }, now)?.setAt, 1, "the same objective keeps when it was set")

  assert.deepEqual(readGoalReport("Done.\nGoal: complete — all 12 tests pass"), { kind: "complete", note: "all 12 tests pass" })
  assert.deepEqual(readGoalReport("> **Goal:** done"), { kind: "complete" })
  assert.deepEqual(readGoalReport("Goal: blocked - need the token\n"), { kind: "blocked", note: "need the token" })
  assert.deepEqual(readGoalReport("Goal: working"), { kind: "working" })
  assert.deepEqual(readGoalReport("Goal: complete — x\nThen I'll keep going."), { kind: "working" }, "only the last line reports")
}

function decoders() {
  assert.deepEqual(
    codexGoalObservation({ threadId: "t", objective: OBJECTIVE, status: "budgetLimited", tokenBudget: 50_000, tokensUsed: 50_312, timeUsedSeconds: 640 }),
    { objective: OBJECTIVE, status: "budget-limited", tokensUsed: 50_312, tokenBudget: 50_000, seconds: 640 })

  // Recorded from grok 1.0.46 by scripts/test-grok-goal-live.ts.
  const grok = { sessionUpdate: "goal_updated", goal_id: "g", objective: OBJECTIVE, status: "infra_paused", phase: "executing", tokens_used: 12, elapsed_ms: 374, total_deliverables: 0, completed_deliverables: 0, total_worker_rounds: 0, total_verify_rounds: 0, token_baseline: 1358, finished_subagent_tokens: 12, last_event: "goal_paused", pause_message: "No plan was produced. Retry with /goal resume." }
  assert.deepEqual(grokGoal(grok), { objective: OBJECTIVE, status: "paused", turns: undefined, tokensUsed: 12, tokenBudget: undefined, seconds: 0, note: "No plan was produced. Retry with /goal resume." })
  assert.equal(grokGoal({ ...grok, goal_id: "", objective: "", status: "cleared", phase: "idle" }), null)
  assert.equal(grokGoal({ ...grok, status: "reticulating" }), undefined, "an unknown status is logged, not guessed")
  assert.equal(grokGoal({ ...grok, status: "active", last_event: "worker_completed", last_event_detail: "done.txt does not exist yet" })?.note, "done.txt does not exist yet", "while active, the note is what Grok's evaluator found")
  assert.equal(grokGoal({ ...grok, status: "complete", phase: "idle", last_event: "goal_completed" })?.status, "complete")
}

interface GoalStatusFields {
  met: boolean
  sentinel?: boolean
  failed?: boolean
  condition: string
  reason?: string
  iterations?: number
  durationMs?: number
  tokens?: number
}

async function claudeTranscript() {
  const root = mkdtempSync(join(tmpdir(), "mako-claude-goal-"))
  try {
    const path = join(root, "session.jsonl")
    const record = (attachment: GoalStatusFields) => JSON.stringify({ type: "attachment", attachment: { type: "goal_status", ...attachment } })
    const lines = (...entries: string[]) => writeFileSync(path, `${entries.join("\n")}\n`)
    lines(JSON.stringify({ type: "user", message: { content: "hi" } }))
    assert.equal(await readClaudeGoal(path), null, "a transcript without a goal has none")
    lines(record({ met: false, sentinel: true, condition: OBJECTIVE }))
    assert.deepEqual(await readClaudeGoal(path), { objective: OBJECTIVE, status: "active", note: undefined, turns: undefined, tokensUsed: undefined, seconds: undefined })
    lines(record({ met: false, sentinel: true, condition: OBJECTIVE }), record({ met: false, condition: OBJECTIVE, reason: "Two tests still fail." }))
    assert.equal((await readClaudeGoal(path))?.note, "Two tests still fail.")
    lines(record({ met: true, condition: OBJECTIVE, reason: "All pass.", iterations: 3, durationMs: 61_400, tokens: 9_000 }))
    assert.deepEqual(await readClaudeGoal(path), { objective: OBJECTIVE, status: "complete", note: "All pass.", turns: 3, tokensUsed: 9_000, seconds: 61 })
    lines(record({ met: false, failed: true, condition: OBJECTIVE, reason: "The API doesn't exist." }))
    assert.equal((await readClaudeGoal(path))?.status, "blocked")
    lines(record({ met: false, sentinel: true, condition: OBJECTIVE }), record({ met: true, sentinel: true, condition: OBJECTIVE }))
    assert.equal(await readClaudeGoal(path), null, "`/goal clear` writes a met sentinel")
    assert.equal(await readClaudeGoal(join(root, "missing.jsonl")), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

contract()
decoders()
await claudeTranscript()
await makosLoopRunsToCompletion()
await makosLoopStopsWhenBlockedOrQuiet()
await stopPausesMakosLoop()
await aUserMessageGoesFirst()
await aHarnessGoalByMessages()
await stopPausesAHarnessGoalAfterTheTurn()
await stopPausesACallGoalFirst()
await aConversationStartsWithAGoal()
console.log("live goals: Mako's loop continues, completes, blocks and pauses; harness goals take messages and calls; each native report decodes")
