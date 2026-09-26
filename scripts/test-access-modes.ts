import assert from "node:assert/strict"
import { ApprovalEvidenceCapabilitySchema } from "../electron/providers/approval-capability.js"
import { acpDefaultMode, acpInitialSelection, acpModeChange, acpNativeModes, acpSessionModes } from "../electron/acp-access.ts"
import { accessModeId } from "../electron/contracts/access.ts"
import { acpLiveDriver } from "../electron/providers/acp-live-driver.ts"
import { CURSOR_SDK_MODES } from "../electron/providers/cursor/sdk/modes.ts"
import { CursorSdkAuth } from "../electron/providers/cursor/sdk/auth.ts"
import { CursorCredentialStore } from "../electron/providers/cursor/sdk/credentials.ts"
import { createCursorSdkDriver } from "../electron/providers/cursor/sdk/driver.ts"
import { devinAcpSource } from "../electron/providers/devin/acp.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { createOpenCodeDriver } from "../electron/providers/opencode/live-driver.ts"
import { openCodeAgentForMode, openCodeModeForAgent, openCodeModes, openCodeSessionModes } from "../electron/providers/opencode/access.ts"
import { codexAccessModes, codexAccessTier, codexObservedTier, codexTurnAccess } from "../electron/providers/codex/access.ts"
import { ClaudeModeSchema } from "../electron/providers/claude/input.ts"
import { claudeLiveDriver } from "../electron/providers/claude/live-driver.ts"
import { codexLiveDriver } from "../electron/providers/codex/live-driver.ts"
import { validateLiveDriver } from "../electron/providers/live-driver.ts"

// Cursor runs through its SDK, which has no permission prompt: the ladder is
// one provider-enforced mode, Agent on the full tier, and no tier that would
// need a host to answer an ask the SDK never sends or a classifier's refusal
// nobody at the desk can overrule.
const cursorDriver = createCursorSdkDriver({
  auth: new CursorSdkAuth({
    env: async () => ({}),
    openUrl: async () => undefined,
    credentials: new CursorCredentialStore("/nonexistent/credential.bin", {
      available: async () => false,
      encrypt: async () => Buffer.alloc(0),
      decrypt: async () => "",
    }),
    cliKey: async () => null,
  }),
  stateRoot: () => "/nonexistent",
})
const cursorModes = cursorDriver.modes ?? []
assert.deepEqual(
  cursorModes.map((mode) => [mode.id, mode.access, mode.enforcement]),
  [["full-access", "full", "provider"]],
  "Cursor is Agent on the full tier and nothing else"
)
assert.deepEqual(cursorModes, CURSOR_SDK_MODES)
assert.ok(!cursorModes.some((mode) => mode.id === "agent"), "Cursor ACP's asking mode id is not on the SDK ladder")
assert.ok(
  !cursorModes.some((mode) => mode.access === "auto"),
  "the SDK's Auto review refuses calls nobody at the desk can approve, so it is not a tier"
)
assert.equal(cursorDriver.steering, "interrupt")
assert.ok(cursorDriver.steer)

// Devin: every tier is native, nothing is synthesized.
const devinNative = {
  currentModeId: "accept-edits",
  availableModes: [
    { id: "accept-edits", name: "Code" },
    { id: "smart", name: "Smart" },
    { id: "ask", name: "Ask" },
    { id: "plan", name: "Plan" },
    { id: "bypass", name: "Bypass Permissions" },
  ],
}
const devinModes = acpSessionModes(devinAcpSource.access, devinNative)
assert.deepEqual(devinModes.map((mode) => [mode.id, mode.access]), [
  ["accept-edits", "edits"],
  ["smart", "auto"],
  ["ask", "chat"],
  ["plan", "plan"],
  ["bypass", "full"],
])
assert.ok(devinModes.every((mode) => mode.enforcement === "provider"))
assert.equal(acpLiveDriver(devinAcpSource).steering, "step")

// Grok: no native modes, no steering; tiers are fixed at launch through --permission-mode.
const grokModes = acpSessionModes(grokAcpSource.access, null)
assert.deepEqual(grokModes.map((mode) => [mode.id, mode.enforcement]), [
  [accessModeId("plan"), "launch"],
  [accessModeId("deny"), "launch"],
  [accessModeId("auto"), "launch"],
  [accessModeId("full"), "launch"],
])
assert.equal(acpLiveDriver(grokAcpSource).steer, undefined, "Grok queues a concurrent prompt behind the turn")
assert.equal(acpLiveDriver(grokAcpSource).steering, undefined)
const grokLaunch = { appPath: "/app", execPath: process.execPath }
const grokFull = await grokAcpSource.launch({ ...grokLaunch, access: "full" })
assert.deepEqual(grokFull?.args.slice(0, 3), ["--permission-mode", "bypassPermissions", "agent"])
const grokAuto = await grokAcpSource.launch({ ...grokLaunch, access: "auto" })
assert.deepEqual(grokAuto?.args.slice(0, 2), ["--permission-mode", "auto"])
const grokUnset = await grokAcpSource.launch(grokLaunch)
assert.equal(grokUnset?.args[0], "agent", "no selection leaves the user's Grok configuration alone")
const grokEdits = await grokAcpSource.launch({ ...grokLaunch, access: "edits" })
assert.equal(grokEdits?.args[0], "agent", "a tier Grok cannot enforce over ACP is not forwarded")
assert.deepEqual(acpInitialSelection(grokAcpSource.access, grokModes, null, accessModeId("full")), { currentMode: accessModeId("full") })
assert.deepEqual(acpModeChange(grokAcpSource.access, grokModes, accessModeId("full"), "full", "grok"), { kind: "unchanged", modeId: accessModeId("full") })
assert.throws(() => acpModeChange(grokAcpSource.access, grokModes, accessModeId("auto"), "full", "grok"), /when its session starts/)
// Grok reports no session modes over ACP, so the deny tier it launches with
// is the declared default: the desk always has a level to report.
assert.equal(acpDefaultMode(grokAcpSource.access), accessModeId("deny"))
assert.equal(acpLiveDriver(grokAcpSource).defaultMode, accessModeId("deny"))
assert.deepEqual(
  acpInitialSelection(grokAcpSource.access, grokModes, null, acpDefaultMode(grokAcpSource.access)),
  { currentMode: accessModeId("deny") },
  "an unchosen Grok session opens under its declared default, reported as such"
)

// OpenCode: Plan and custom primary agents are native; Build is hidden behind
// the ask/edits/full rulesets its session launches with.
const openCodeDriver = createOpenCodeDriver({ env: async () => ({}), approvalRoot: async () => "/nonexistent" })
const openCodeLadder = openCodeSessionModes([
  { id: "build", name: "build" },
  { id: "plan", name: "plan" },
  { id: "review", name: "Review", description: "Reads and comments only" },
])
assert.deepEqual(openCodeLadder.map((mode) => [mode.id, mode.access, mode.enforcement]), [
  ["plan", "plan", "provider"],
  ["review", undefined, undefined],
  [accessModeId("ask"), "ask", "launch"],
  [accessModeId("edits"), "edits", "launch"],
  [accessModeId("full"), "full", "launch"],
])
assert.deepEqual(openCodeSessionModes([{ id: "build", name: "build" }, { id: "plan", name: "plan" }]), [...openCodeModes],
  "a session with only the built-in agents shows the ladder declared before launch")
assert.equal(openCodeAgentForMode(accessModeId("full"), "full"), "build", "returning from Plan must switch the native agent back to Build")
assert.equal(openCodeAgentForMode("plan", "full"), "plan")
assert.equal(openCodeAgentForMode("review", "ask"), "review")
assert.throws(() => openCodeAgentForMode(accessModeId("ask"), "full"), /when its session starts/)
assert.equal(openCodeModeForAgent("build", "edits"), accessModeId("edits"))
assert.equal(openCodeModeForAgent("plan", "full"), "plan")
assert.equal(openCodeModeForAgent("review", "full"), "review")
// ACP agents may report modes as a `mode` config option instead of session.modes.
const modeOption = acpNativeModes([
  {
    id: "mode",
    name: "Session Mode",
    category: "mode",
    type: "select",
    currentValue: "accept-edits",
    options: [
      { value: "accept-edits", name: "Code", description: "Edits without asking." },
      { value: "plan", name: "Plan", description: "Plan mode." },
    ],
  },
])
assert.equal(modeOption?.currentModeId, "accept-edits")
assert.deepEqual(
  acpSessionModes(devinAcpSource.access, modeOption).map((mode) => [mode.id, mode.access]),
  [["accept-edits", "edits"], ["plan", "plan"]],
  "the mode config option builds the same ladder session.modes does"
)
assert.equal(acpNativeModes([]), null)
// Codex: four tiers become the per-turn approval policy, sandbox, and reviewer.
assert.deepEqual(codexAccessModes().map((mode) => mode.access), ["ask", "edits", "auto", "full"])
assert.deepEqual(codexTurnAccess("full"), { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" }, approvalsReviewer: "user" })
assert.equal(codexTurnAccess("auto").approvalsReviewer, "auto_review")
assert.equal(codexTurnAccess("ask").approvalPolicy, "untrusted")
assert.deepEqual(codexTurnAccess(null), {})
assert.equal(codexAccessTier(accessModeId("edits")), "edits")
assert.throws(() => codexAccessTier(accessModeId("plan")), /does not offer/)
assert.throws(() => codexAccessTier("agent"), /does not offer/)
// The thread response's own approval/sandbox pair is the level the session
// opened with; missing or custom policies must remain unclassified.
const workspaceWrite = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false } as const
assert.equal(codexObservedTier({ approvalPolicy: "on-request", sandbox: { type: "readOnly", networkAccess: false }, approvalsReviewer: "user" }), "ask")
assert.equal(codexObservedTier({ approvalPolicy: "on-request", sandbox: workspaceWrite, approvalsReviewer: "user" }), "edits")
assert.equal(codexObservedTier({ approvalPolicy: "on-request", sandbox: workspaceWrite, approvalsReviewer: "auto_review" }), "auto")
assert.equal(codexObservedTier({ approvalPolicy: "never", sandbox: { type: "dangerFullAccess" } }), "full")
assert.equal(codexObservedTier({}), null)
assert.equal(codexObservedTier({ approvalPolicy: "never", sandbox: { type: "readOnly", networkAccess: false } }), null)
assert.equal(codexObservedTier({ sandbox: { type: "externalSandbox", networkAccess: "enabled" } }), null)

// Claude: Full access is a real mode now.
assert.ok(ClaudeModeSchema.safeParse("bypassPermissions").success)

console.log(
  "Access modes: native policy ownership, Cursor SDK tiers, Devin native tiers, Grok launch tiers without steering, OpenCode native agents and rulesets, Codex per-turn policy, and Claude bypass verified"
)

// Before launch, every driver declares the same ladder its live session will show,
// so the composer can take the choice with the first prompt.
assert.deepEqual(acpLiveDriver(devinAcpSource).modes, devinModes, "Devin's ladder is known before launch")
assert.deepEqual(acpLiveDriver(grokAcpSource).modes, grokModes, "Grok's ladder is known before launch")
assert.deepEqual(openCodeDriver.modes, openCodeModes, "OpenCode's ladder is known before launch")
assert.deepEqual(codexLiveDriver.modes, codexAccessModes())
assert.ok(claudeLiveDriver.modes?.length, "Claude declares its modes before launch")
for (const mode of claudeLiveDriver.modes ?? []) ClaudeModeSchema.parse(mode.id)
const accessDrivers = [cursorDriver, acpLiveDriver(devinAcpSource), acpLiveDriver(grokAcpSource), openCodeDriver, codexLiveDriver, claudeLiveDriver]
for (const driver of accessDrivers) validateLiveDriver(driver)
assert.deepEqual(Object.fromEntries(accessDrivers.map(driver => [driver.provider, driver.approvalEvidence.kind])), {
  cursor: "no-interactive-requests", devin: "native-decisions", grok: "submission-only",
  opencode: "native-decisions", codex: "native-decisions", claude: "native-decisions",
}, "the actual six adapters declare their evidence, independently of shared host fixtures")
assert.deepEqual(Object.fromEntries(accessDrivers.map(driver => [driver.provider,
  driver.approvalEvidence.kind === "native-decisions" ? driver.approvalEvidence.nativeRequests : [],
])), {
  cursor: [], devin: ["structured-question"], grok: [], opencode: ["tool-permission", "structured-question"],
  codex: ["tool-permission"], claude: ["structured-question", "tool-permission"],
}, "native question evidence must not certify generic tool permissions")
assert.throws(() => ApprovalEvidenceCapabilitySchema.parse({
  kind: "native-decisions", recovery: "retained-observer", coverage: "Unscoped native evidence",
}), /Invalid/, "the registration schema requires native evidence to name its request families")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, approvalEvidence: undefined }), /Invalid/,
  "registration rejects a new adapter without an approval evidence declaration")
assert.throws(() => validateLiveDriver({ ...cursorDriver, modes: [{ id: "ask", name: "Ask", access: "ask", enforcement: "provider" }] }),
  /requires native interactive requests/, "an adapter without interactive requests cannot advertise Ask")
for (const driver of accessDrivers)
  assert.ok(driver.modes?.every((mode) => !mode.access || mode.enforcement), `${driver.provider}: no tier without an enforcer`)
// Every driver names the level a fresh session runs under, so the desk never
// reports an unchosen session as having no access.
for (const driver of accessDrivers)
  assert.ok(
    driver.defaultMode && driver.modes?.some((mode) => mode.id === driver.defaultMode),
    `${driver.provider}: the declared default is on the ladder`
  )
assert.equal(acpLiveDriver(devinAcpSource).defaultMode, "accept-edits", "Devin opens in its Code mode")
assert.equal(openCodeDriver.defaultMode, accessModeId("ask"))
assert.equal(codexLiveDriver.defaultMode, accessModeId("ask"))
assert.equal(claudeLiveDriver.defaultMode, "default")
assert.equal(cursorDriver.defaultMode, "full-access")

// Invariants the interface cannot type fail at install, not at a call site.
assert.throws(
  () => validateLiveDriver({ provider: "x", approvalEvidence: codexLiveDriver.approvalEvidence, canResume: false, steer: async () => ({ kind: "accepted" as const }) }),
  /steer and steering/
)
assert.throws(
  () => validateLiveDriver({ provider: "x", approvalEvidence: codexLiveDriver.approvalEvidence, canResume: false, steering: "interrupt" }),
  /steer and steering/
)
assert.throws(
  () => validateLiveDriver({ provider: "x", approvalEvidence: codexLiveDriver.approvalEvidence, canResume: false, modes: [{ id: "a", name: "A", access: "full" }] }),
  /no enforcer/
)
assert.throws(
  () => validateLiveDriver({ provider: "x", approvalEvidence: codexLiveDriver.approvalEvidence, canResume: false, modes: [{ id: "a", name: "A" }], defaultMode: "b" }),
  /not one of its declared modes/
)
