import assert from "node:assert/strict"
import type { LivePermissionRequest, LiveSessionMode, LiveSessionState } from "../src/lib/types.ts"
import type { LiveAcpConversation } from "../src/state/acp-state.ts"
import type { ModelOption } from "@mako/sessions/settings"
import type { ProposedPlan } from "@mako/sessions/content"
import { PlanBuildTargetSchema, type PlanBuild, type PlanBuildClaim } from "../electron/contracts/plan-builds.ts"

// The renderer state layer is React-free, but modules read `window` at load.
const bridge: Array<[string, unknown[]]> = []
const replies: Record<string, (...args: unknown[]) => PlanBuildClaim> = {}
Object.assign(globalThis, {
  window: {
    mako: new Proxy({}, {
      get: (_target, name) => (...args: unknown[]) => {
        bridge.push([String(name), args])
        return Promise.resolve(replies[String(name)]?.(...args) ?? null)
      },
    }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true },
    setInterval() {},
    clearInterval() {},
    location: { search: "" },
  },
  CustomEvent: class { constructor(public type: string) {} },
})

const { planControl, leavePlanMode, setPlanMode, planContextFor, buildPlan, recordSentPlanBuilds } = await import("../src/state/plan-mode.ts")
const { planBuildsStore } = await import("../src/state/plan-builds.ts")
const { planChoiceStore, pendingPlan, restorePendingPlan, setPendingPlan, takePendingPlan, withNativePlan } =
  await import("../src/state/plan-choice.ts")
const { CODEX_PLAN_OPTION } = await import("@mako/sessions/model-catalog")
const { prefsStore } = await import("../src/state/prefs.ts")
const { acpStore } = await import("../src/state/acp-state.ts")
const { settingsTargetKey } = await import("../src/state/composer-settings.ts")
const { providerStore, providerProfileKey } = await import("../src/state/providers.ts")
const { acp } = await import("../src/state/acp.ts")
const { draftText, rememberDraft } = await import("../src/state/drafts.ts")
const { parsePlanContext, proposedPlanReply } = await import("../src/lib/proposed-plan.ts")

const claudeModes: LiveSessionMode[] = [
  { id: "default", name: "Default", access: "ask" },
  { id: "acceptEdits", name: "Accept edits", access: "edits" },
  { id: "plan", name: "Plan", access: "plan" },
]
const grokModes: LiveSessionMode[] = [
  { id: "default", name: "Default", access: "ask", enforcement: "launch" },
  { id: "plan", name: "Plan", access: "plan", enforcement: "launch" },
]
const agentOnlyModes: LiveSessionMode[] = [{ id: "agent", name: "Agent", access: "full" }]
const codexOptions: ModelOption[] = [CODEX_PLAN_OPTION]
const noOptions: ModelOption[] = []
const noModes: LiveSessionMode[] = []
const base = { options: noOptions, settings: {}, modes: noModes, currentMode: null }

// One control, two native shapes, or none.
assert.deepEqual(planControl({ ...base, phase: "live", options: codexOptions, settings: { options: { plan: true } } }),
  { kind: "setting", option: "plan", active: true, locked: undefined }, "Codex plans through a per-session setting")
const codexOff = planControl({ ...base, phase: "live", options: codexOptions })
assert.equal(codexOff.kind, "setting")
assert.equal(codexOff.active, false)
const claude = planControl({ ...base, phase: "live", modes: claudeModes, currentMode: "plan" })
assert.ok(claude.kind === "mode" && claude.active && claude.mode.id === "plan" && !claude.locked, "Claude plans in its plan mode")
assert.deepEqual(planControl({ ...base, phase: "live", modes: agentOnlyModes, currentMode: "agent" }), { kind: "none" },
  "a harness without a plan option or mode has no plan mode")
assert.equal(planControl({ ...base, phase: "live", options: codexOptions, modes: claudeModes }).kind, "setting",
  "a setting keeps access independent, so it wins over a plan access mode")
const fixed = planControl({ ...base, phase: "live", options: [{ ...CODEX_PLAN_OPTION, disabledReason: "Fixed here." }] })
assert.ok(fixed.kind === "setting" && fixed.locked === "Fixed here.")

// A session not started plans only when chosen for it; a starting one shows what it launched with.
const fresh = planControl({ ...base, phase: "new", modes: claudeModes, currentMode: "plan" })
assert.ok(fresh.kind === "mode" && !fresh.active, "a saved plan access level is not a plan choice for the next session")
const chosen = planControl({ ...base, phase: "new", options: codexOptions, chosen: { kind: "setting", option: "plan" } })
assert.ok(chosen.kind === "setting" && chosen.active && !chosen.locked)
const starting = planControl({ ...base, phase: "starting", modes: claudeModes, chosen: { kind: "mode", mode: "plan" } })
assert.ok(starting.kind === "mode" && starting.active && starting.locked, "a starting session cannot change plan mode yet")

// A launch-enforced plan mode is fixed once the process runs, but a resumed thread starts a new one.
const grok = planControl({ ...base, phase: "live", modes: grokModes, currentMode: "default" })
assert.ok(grok.kind === "mode" && grok.locked === "Plan mode is set when a session starts.")
const grokThread = planControl({ ...base, phase: "thread", modes: grokModes, currentMode: "default" })
assert.ok(grokThread.kind === "mode" && !grokThread.locked)

// Leaving a mode-backed plan returns to the level the session had.
const leave = (remembered: string | undefined, saved: string | null, defaulted: string | null) =>
  leavePlanMode({ modes: claudeModes, plan: "plan", remembered, saved, defaulted })
assert.equal(leave("acceptEdits", "default", "default"), "acceptEdits")
assert.equal(leave("plan", "plan", "default"), "default", "plan is never where plan mode returns to")
assert.equal(leave("gone", null, null), "default", "a level the harness no longer offers is skipped")
assert.equal(leavePlanMode({ modes: [claudeModes[2]!], plan: "plan", saved: null, defaulted: null }), undefined)

// A start carries its plan natively: the setting rides the tuning, the mode is the mode.
assert.deepEqual(withNativePlan({ kind: "setting", option: "plan" }, { modeId: "full", tuning: { model: "m", options: { effort: "high" } } }),
  { modeId: "full", tuning: { model: "m", options: { effort: "high", plan: true } } })
assert.deepEqual(withNativePlan({ kind: "mode", mode: "plan" }, { modeId: "access:full", tuning: {} }), { modeId: "plan", launchModeId: "access:full", tuning: {} },
  "the level Plan replaces is the one a launch-only harness starts at")
assert.deepEqual(withNativePlan({ kind: "mode", mode: "plan" }, { tuning: {} }), { modeId: "plan", tuning: {} })
assert.deepEqual(withNativePlan(undefined, { tuning: {} }), { tuning: {} })

// Plan for a new session is consumed by its first send and given back if the start fails.
const target = { kind: "new" as const, harness: "codex", cwd: "/work" }
setPendingPlan(target, { kind: "setting", option: "plan" })
assert.deepEqual(takePendingPlan(target, "conversation-1"), { kind: "setting", option: "plan" })
assert.equal(pendingPlan(target), undefined, "the next new session does not inherit plan mode")
assert.deepEqual(planChoiceStore.get().launched["conversation-1"], { kind: "setting", option: "plan" })
restorePendingPlan(target, "conversation-1")
assert.deepEqual(pendingPlan(target), { kind: "setting", option: "plan" })
assert.equal(planChoiceStore.get().launched["conversation-1"], undefined)
setPendingPlan(target, null)

// Toggling plan writes no saved default: a new session's choice is pending, a thread's is the thread's.
const before = { settings: prefsStore.get().providerSettings, modes: prefsStore.get().providerModes }
const newContext = { ...planContextFor(target), control: chosen.kind === "setting" ? { ...chosen, active: false } : chosen }
await setPlanMode(newContext, true)
assert.deepEqual(pendingPlan(target), { kind: "setting", option: "plan" })
assert.equal(prefsStore.get().settingsOverrides[settingsTargetKey(target)], undefined)
const thread = { kind: "thread" as const, harness: "codex", cwd: "/work", path: "/sessions/one.jsonl" }
await setPlanMode({ ...planContextFor(thread), phase: "thread", control: { kind: "setting", option: "plan", active: false } }, true)
assert.equal(prefsStore.get().settingsOverrides[settingsTargetKey(thread)]?.options?.plan, true)
const claudeThread = { kind: "thread" as const, harness: "claude", cwd: "/work", path: "/sessions/two.jsonl" }
await setPlanMode({
  ...planContextFor(claudeThread), phase: "thread", modes: claudeModes, currentMode: "acceptEdits",
  control: { kind: "mode", mode: claudeModes[2]!, active: false },
}, true)
assert.deepEqual(bridge.at(-1), ["rememberThreadMode", ["/sessions/two.jsonl", "plan"]])
await setPlanMode({
  ...planContextFor(claudeThread), phase: "thread", modes: claudeModes, currentMode: "plan",
  control: { kind: "mode", mode: claudeModes[2]!, active: true },
}, false)
assert.deepEqual(bridge.at(-1), ["rememberThreadMode", ["/sessions/two.jsonl", "acceptEdits"]], "leaving returns to the level it left")
assert.deepEqual(prefsStore.get().providerSettings, before.settings)
assert.deepEqual(prefsStore.get().providerModes, before.modes, "plan mode is the session's, never the harness's default")

// Build answers the native approval for this plan, and only for this plan.
const plan: ProposedPlan = { type: "proposed-plan", id: "tool-2", text: "# Ship it\n\n1. Do it", status: "proposed" }
const older: ProposedPlan = { ...plan, id: "tool-1", text: "# Older\n\n1. Earlier" }
const permission: LivePermissionRequest = {
  id: "request", sessionId: "s", title: "Start implementing the proposed plan?", kind: "ExitPlanMode",
  options: [{ optionId: "allow_once", name: "Approve plan" }, { optionId: "reject_once", name: "Keep planning" }],
  implementsPlan: { plan: "tool-2", approve: "allow_once" },
}
const liveConversation = (
  key: string,
  harness: string,
  blocks: ProposedPlan[],
  session: Pick<LiveSessionState, "status" | "modes" | "currentMode" | "settings">,
  waiting: LivePermissionRequest | null
): LiveAcpConversation => ({
  kind: "live", key, draftKey: key, harness, cwd: "/work", blocks, queued: [], hiddenUserPrompt: null,
  createdAt: 0, updatedAt: 0, permission: waiting, sending: false, canceling: false,
  session: { id: key, harness, cwd: "/work", connection: "connected", configOptions: [], ...session },
})
acpStore.set({
  conversations: { live: liveConversation("live", "claude", [older, plan], { status: "running", modes: claudeModes, currentMode: "plan" }, permission) },
  activeKey: "live",
})
bridge.length = 0
await buildPlan({ liveId: "live" }, plan)
assert.deepEqual(bridge[0], ["livePermission", ["live", "request", { kind: "choice", optionId: "allow_once" }]],
  "approving the waiting plan builds it; no second prompt is sent")
assert.equal(planBuildsStore.get().builds["tool-2"], undefined,
  "the host records the build once the agent takes the approval; a window whose answer lost records nothing")
bridge.length = 0
await assert.rejects(buildPlan({ liveId: "live" }, older), /earlier revision/)
assert.equal(bridge.length, 0, "an earlier plan neither answers the current approval nor sends beside it")
await assert.rejects(buildPlan({ liveId: "live" }, { ...plan, status: "drafting" }), /complete plan/)

// Without a native approval, Build leaves plan mode and sends the implementation with the whole plan.
acpStore.set({
  conversations: {
    codex: liveConversation("codex", "codex", [plan], { status: "ready", modes: [], currentMode: null, settings: { model: "m", options: { plan: true } } }, null),
  },
  activeKey: "codex",
})
providerStore.set({
  contexts: {
    [providerProfileKey("codex", "/work")]: {
      id: "codex", label: "Codex", available: true, transport: "app-server",
      models: [{ id: "m", label: "M", options: [CODEX_PLAN_OPTION] }], settings: { model: "m" },
    },
  },
})
const sent: string[] = []
let delivered = true
acp.send = (text) => {
  sent.push(text)
  return Promise.resolve(delivered)
}
let hostBuild: PlanBuild | undefined
replies.claimPlanBuild = (_claim, _plan, target, seen) =>
  (hostBuild?.at ?? null) === seen
    ? { claimed: true, build: (hostBuild = { ...PlanBuildTargetSchema.parse(target), at: (hostBuild?.at ?? 0) + 1 }) }
    : { claimed: false, current: hostBuild }
rememberDraft("codex", "an unrelated thought")
bridge.length = 0
await buildPlan({ liveId: "codex" }, plan)
assert.deepEqual(bridge.find(([name]) => name === "claimPlanBuild")?.[1].slice(1), ["tool-2", { conversation: "codex" }, null],
  "Build claims the plan, as last seen, before it sends")
assert.equal(prefsStore.get().settingsOverrides[settingsTargetKey({ kind: "live", id: "codex", harness: "codex", cwd: "/work" })]?.options?.plan, false,
  "Build leaves plan mode for the turn it sends")
assert.equal(sent.length, 1)
const { body, plans } = parsePlanContext(sent[0]!)
assert.equal(body, "Implement the proposed plan: Ship it.")
assert.deepEqual(plans, [plan], "the whole plan travels with the request")
assert.equal(draftText("codex"), "an unrelated thought", "the composer's draft is untouched")
assert.equal(planBuildsStore.get().builds["tool-2"]?.conversation, "codex", "a sent implementation request records where it went")

// Two Build clicks on one plan: the one that saw an older build sends nothing.
hostBuild = { at: 9, conversation: "elsewhere" }
await assert.rejects(buildPlan({ liveId: "codex" }, plan), (error: Error) => error.name === "PlanBuiltElsewhereError")
assert.equal(sent.length, 1, "a lost claim sends no second implementation")
assert.deepEqual(planBuildsStore.get().builds["tool-2"], hostBuild, "the window learns the build that won")
// A Build that wins but can't send gives its claim back.
delivered = false
bridge.length = 0
await assert.rejects(buildPlan({ liveId: "codex" }, plan), /not sent/)
const claimed = bridge.find(([name]) => name === "claimPlanBuild")?.[1][0]
assert.deepEqual(bridge.find(([name]) => name === "releasePlanBuild")?.[1], [claimed], "an unsent build is released by its claim id")
delivered = true

// A sent message builds the plans it asks to implement, wherever it went; a revision builds nothing.
const revised: ProposedPlan = { ...plan, id: "tool-3", text: "# Revise me" }
recordSentPlanBuilds(proposedPlanReply(revised, "revise"), [revised], { conversation: "codex" })
assert.equal(planBuildsStore.get().builds["tool-3"], undefined, "a revision request builds nothing")
recordSentPlanBuilds(`Use the staging database.\n\n${proposedPlanReply(revised, "implement")}`, [revised], { conversation: "new-session" })
assert.equal(planBuildsStore.get().builds["tool-3"]?.conversation, "new-session", "a new session's first send builds the plan it carries")
recordSentPlanBuilds("Never mind", [older], { thread: "/sessions/x.jsonl" })
assert.equal(planBuildsStore.get().builds["tool-1"], undefined, "a plan attached without its implementation request is not built")

console.log("Plan mode: per-harness mapping, launch locks, return modes, pending plans, no saved defaults, approval-backed builds, built plans")
