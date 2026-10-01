import assert from "node:assert/strict"
import type { LiveSessionMode } from "../src/lib/types.ts"
import type { ModelOption } from "@mako/sessions/settings"
import type { ProposedPlan } from "@mako/sessions/content"

// The renderer state layer is React-free, but modules read `window` at load.
const bridge: Array<[string, unknown[]]> = []
Object.assign(globalThis, {
  window: {
    mako: new Proxy({}, {
      get: (_target, name) => (...args: unknown[]) => {
        bridge.push([String(name), args])
        return Promise.resolve(null)
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

const { planControl, leavePlanMode, setPlanMode, planContextFor, buildPlan } = await import("../src/state/plan-mode.ts")
const { planChoiceStore, pendingPlan, restorePendingPlan, setPendingPlan, takePendingPlan, withNativePlan } =
  await import("../src/state/plan-choice.ts")
const { CODEX_PLAN_OPTION } = await import("@mako/sessions/model-catalog")
const { prefsStore } = await import("../src/state/prefs.ts")
const { acpStore } = await import("../src/state/acp-state.ts")
const { settingsTargetKey } = await import("../src/state/composer-settings.ts")
const { providerStore, providerProfileKey } = await import("../src/state/providers.ts")
const { acp } = await import("../src/state/acp.ts")
const { draftText, rememberDraft } = await import("../src/state/drafts.ts")
const { parsePlanContext } = await import("../src/lib/proposed-plan.ts")

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
assert.equal(planControl({ ...base, phase: "live", options: codexOptions }).kind === "setting" &&
  planControl({ ...base, phase: "live", options: codexOptions }).active, false)
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
assert.deepEqual(withNativePlan({ kind: "mode", mode: "plan" }, { modeId: "default", tuning: {} }), { modeId: "plan", tuning: {} })
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
const permission = {
  id: "request", sessionId: "s", title: "Start implementing the proposed plan?", kind: "ExitPlanMode",
  options: [{ optionId: "allow_once", name: "Approve plan" }, { optionId: "reject_once", name: "Keep planning" }],
  implementsPlan: { plan: "tool-2", approve: "allow_once" },
}
// SAFETY: a partial conversation; plan mode reads only the fields set here.
acpStore.set({
  conversations: {
    live: {
      kind: "live", key: "live", draftKey: "live", harness: "claude", cwd: "/work", blocks: [older, plan], queued: [],
      createdAt: 0, updatedAt: 0, permission, sending: false, canceling: false,
      session: { id: "live", status: "waiting", modes: claudeModes, currentMode: "plan" },
    },
  } as never,
  activeKey: "live",
})
bridge.length = 0
await buildPlan({ liveId: "live" }, plan)
assert.deepEqual(bridge[0], ["livePermission", ["live", "request", { kind: "choice", optionId: "allow_once" }]],
  "approving the waiting plan builds it; no second prompt is sent")
bridge.length = 0
await assert.rejects(buildPlan({ liveId: "live" }, older), /waiting on its newest plan/)
assert.deepEqual(bridge, [], "an earlier plan neither answers the current approval nor sends beside it")
await assert.rejects(buildPlan({ liveId: "live" }, { ...plan, status: "drafting" }), /complete plan/)

// Without a native approval, Build leaves plan mode and sends the implementation with the whole plan.
// SAFETY: a partial conversation; plan mode reads only the fields set here.
acpStore.set({
  conversations: {
    codex: {
      kind: "live", key: "codex", draftKey: "codex", harness: "codex", cwd: "/work", blocks: [plan], queued: [],
      createdAt: 0, updatedAt: 0, permission: null, sending: false, canceling: false,
      session: { id: "codex", status: "idle", modes: [], currentMode: null, settings: { model: "m", options: { plan: true } } },
    },
  } as never,
  activeKey: "codex",
})
providerStore.set({
  contexts: {
    [providerProfileKey("codex", "/work")]: {
      id: "codex", label: "Codex", available: true, transport: "app-server", capabilities: [],
      models: [{ id: "m", label: "M", options: [CODEX_PLAN_OPTION] }], settings: { model: "m" },
    },
  },
})
const sent: string[] = []
acp.send = (text) => {
  sent.push(text)
  return Promise.resolve(true)
}
rememberDraft("codex", "an unrelated thought")
await buildPlan({ liveId: "codex" }, plan)
assert.equal(prefsStore.get().settingsOverrides[settingsTargetKey({ kind: "live", id: "codex", harness: "codex", cwd: "/work" })]?.options?.plan, false,
  "Build leaves plan mode for the turn it sends")
assert.equal(sent.length, 1)
const { body, plans } = parsePlanContext(sent[0]!)
assert.equal(body, "Implement the proposed plan: Ship it.")
assert.deepEqual(plans, [plan], "the whole plan travels with the request")
assert.equal(draftText("codex"), "an unrelated thought", "the composer's draft is untouched")

console.log("Plan mode: per-harness mapping, launch locks, return modes, pending plans, no saved defaults, approval-backed builds")
