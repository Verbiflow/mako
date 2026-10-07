import assert from "node:assert/strict"
import { ApprovalEvidenceCapabilitySchema } from "../electron/providers/approval-capability.js"
import { acpDefaultMode, acpInitialSelection, acpModeChange, acpNativeModes, acpReportedMode, acpSessionModes } from "../electron/acp-access.ts"
import { accessModeId } from "../electron/contracts/access.ts"
import { acpLiveDriver } from "../electron/providers/acp-live-driver.ts"
import { CURSOR_SDK_MODES } from "../electron/providers/cursor/sdk/modes.ts"
import { CursorSdkAuth } from "../electron/providers/cursor/sdk/auth.ts"
import { CursorCredentialStore } from "../electron/providers/cursor/sdk/credentials.ts"
import { createCursorSdkDriver } from "../electron/providers/cursor/sdk/driver.ts"
import { devinAcpSource } from "../electron/providers/devin/acp.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { grokPermissionPolicy } from "../electron/providers/grok/permission-policy.ts"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createOpenCodeDriver } from "../electron/providers/opencode/live-driver.ts"
import { openCodeAgentForMode, openCodeLaunchAccess, openCodeModeForAgent, openCodeModes, openCodeSessionModes } from "../electron/providers/opencode/access.ts"
import { codexAccessModes, codexAccessTier, codexObservedTier, codexTurnAccess } from "../electron/providers/codex/access.ts"
import { ClaudeModeSchema } from "../electron/providers/claude/input.ts"
import { claudeLiveDriver } from "../electron/providers/claude/live-driver.ts"
import { codexLiveDriver } from "../electron/providers/codex/live-driver.ts"
import type { SandboxPolicy } from "../electron/providers/codex/generated/v2/SandboxPolicy.ts"
import { validateLiveDriver, type ProviderLiveDriver } from "../electron/providers/live-driver.ts"

const lands = (driver: ProviderLiveDriver) => driver.steering.kind === "supported" ? driver.steering.lands : driver.steering.kind

function codexWithout(declaration: keyof ProviderLiveDriver): ProviderLiveDriver {
  // SAFETY: deliberately malformed input: a declaration the type requires is removed, to prove registration rejects it at runtime.
  return { ...codexLiveDriver, [declaration]: undefined } as ProviderLiveDriver
}

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
assert.equal(lands(cursorDriver), "interrupt")

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
assert.equal(lands(acpLiveDriver(devinAcpSource)), "step")

// Grok: Plan is a native mode it takes live but does not list; permission
// tiers are fixed at launch through --permission-mode. It steers through
// `_x.ai/interject`, which the running turn reads at its next step.
const grokModes = acpSessionModes(grokAcpSource.access, null)
assert.deepEqual(grokModes.map((mode) => [mode.id, mode.access, mode.enforcement]), [
  ["plan", "plan", "provider"],
  [accessModeId("ask"), "ask", "launch"],
  [accessModeId("auto"), "auto", "launch"],
  [accessModeId("full"), "full", "launch"],
])
assert.equal(lands(acpLiveDriver(grokAcpSource)), "step")
const grokRoot = realpathSync(mkdtempSync(join(tmpdir(), "grok-access-")))
const grokHome = join(grokRoot, "home")
const grokRepo = join(grokRoot, "repo")
const grokProject = join(grokRepo, "app")
mkdirSync(join(grokRepo, ".git"), { recursive: true })
writeFileSync(join(grokRepo, ".git", "HEAD"), "ref: refs/heads/main\n")
mkdirSync(grokProject, { recursive: true })
mkdirSync(join(grokHome, ".grok"), { recursive: true })
const grokLaunch = { appPath: "/app", execPath: process.execPath, cwd: grokProject, env: { HOME: grokHome } }
const grokPaths = { cwd: grokProject, home: grokHome, grokHome: join(grokHome, ".grok") }
interface ClaudeSettings {
  permissions?: { defaultMode?: string; allow?: string[]; ask?: string[]; deny?: string[] }
  defaultMode?: string
}
const claudeSettings = (dir: string, name: string, settings: ClaudeSettings) => {
  mkdirSync(join(dir, ".claude"), { recursive: true })
  writeFileSync(join(dir, ".claude", name), JSON.stringify(settings))
}
const trustRepo = () => writeFileSync(join(grokHome, ".grok", "trusted_folders.toml"), `[folders."${grokRepo}"]\ntrusted = true\ndecided_at = 1789008263\n`)
const grokFull = await grokAcpSource.launch({ ...grokLaunch, access: "full" })
assert.deepEqual(grokFull?.args.slice(0, 3), ["--permission-mode", "bypassPermissions", "agent"])
const grokAuto = await grokAcpSource.launch({ ...grokLaunch, access: "auto" })
assert.deepEqual(grokAuto?.args.slice(0, 2), ["--permission-mode", "auto"])
const grokAsk = await grokAcpSource.launch({ ...grokLaunch, access: "ask" })
assert.deepEqual(grokAsk?.args.slice(0, 2), ["--permission-mode", "default"], "Grok's default mode asks over ACP")
assert.equal(grokAsk?.access, undefined, "with no Claude-compatible mode Grok runs at Ask")
assert.equal(grokAsk?.notices, undefined)
claudeSettings(grokHome, "settings.json", { permissions: { defaultMode: "dontAsk" } })
const grokDontAsk = await grokAcpSource.launch({ ...grokLaunch, access: "ask" })
assert.equal(grokDontAsk?.access, undefined, "dontAsk has no tier: Mako keeps Ask and says what Grok does instead")
assert.equal(grokDontAsk?.notices?.[0]?.tone, "warning")
assert.equal(grokDontAsk?.notices?.[0]?.setup, true)
assert.match(grokDontAsk?.notices?.[0]?.detail ?? "", /^~\/\.claude\/settings\.json sets permissions\.defaultMode to dontAsk, so it denies anything no rule allows/)
assert.equal((await grokAcpSource.launch({ ...grokLaunch, access: "auto" }))?.notices, undefined, "an explicit Auto flag beats the imported mode")
assert.equal((await grokAcpSource.launch({ ...grokLaunch, access: "full" }))?.notices, undefined, "an explicit Full flag beats the imported mode")
claudeSettings(grokHome, "settings.local.json", { defaultMode: "bypassPermissions" })
assert.deepEqual(grokPermissionPolicy(grokPaths).mode, { mode: "bypassPermissions", file: join(grokHome, ".claude", "settings.local.json") },
  "the user's local settings come before the shared ones, and a top-level defaultMode counts")
assert.equal((await grokAcpSource.launch({ ...grokLaunch, access: "ask" }))?.access, "full", "an imported bypassPermissions runs Grok at Full, so Mako reports Full")

claudeSettings(grokRepo, "settings.json", { permissions: { defaultMode: "auto", deny: ["Write"] } })
const untrusted = grokPermissionPolicy(grokPaths)
assert.equal(untrusted.mode?.mode, "bypassPermissions", "an untrusted project's mode is skipped, as Grok skips it")
assert.deepEqual(untrusted.rules, [], "and so are its rules")
assert.deepEqual(untrusted.untrusted, [join(grokRepo, ".claude", "settings.json")])
const untrustedLaunch = await grokAcpSource.launch({ ...grokLaunch, access: "ask" })
assert.equal(untrustedLaunch?.access, "full")
assert.deepEqual(untrustedLaunch?.notices?.map((notice) => [notice.label, notice.setup]), [["Grok overrides Ask", true], ["Grok skips project permissions", true]],
  "the conversation is told which project settings Grok skips")

trustRepo()
assert.deepEqual(grokPermissionPolicy(grokPaths).mode, { mode: "auto", file: join(grokRepo, ".claude", "settings.json") },
  "in a trusted repository, project settings up to its root come before the user's")
assert.equal((await grokAcpSource.launch({ ...grokLaunch, access: "ask" }))?.access, "auto")
claudeSettings(grokProject, "settings.local.json", { permissions: { defaultMode: "default" } })
const grokProjectDefault = await grokAcpSource.launch({ ...grokLaunch, access: "ask" })
assert.equal(grokProjectDefault?.access, undefined, "the nearest project setting wins, and default is Ask")
assert.deepEqual(grokProjectDefault?.notices?.map((notice) => notice.label), ["Grok permission rules"], "only the project's deny rule is left to say")

claudeSettings(grokHome, "settings.local.json", { permissions: { allow: ["Bash(git *)", "Edit(src/**)"] } })
writeFileSync(join(grokHome, ".grok", "config.toml"), `[ui]\npermission_mode = "always-approve"\n\n[permission]\ndeny = ["Bash(rm -rf *)"]\nrules = [{ action = "ask", tool = "read", pattern = "secrets/**" }]\n`)
const rules = grokPermissionPolicy(grokPaths).rules
assert.deepEqual(rules.map((rule) => [rule.action, rule.rule]), [
  ["deny", "Write"], ["allow", "Bash(git *)"], ["allow", "Edit(src/**)"], ["deny", "Bash(rm -rf *)"], ["ask", "read(secrets/**)"],
], "rules merge from the project's Claude files, the user's Claude files and Grok's own config, in both of its forms")
for (const access of ["ask", "auto", "full"] as const) {
  const notice = (await grokAcpSource.launch({ ...grokLaunch, access }))?.notices?.find((candidate) => candidate.label === "Grok permission rules")
  assert.equal(notice?.detail, "2 denied, 1 always ask, 2 allowed · 3 files", `the rules are said at ${access} too: deny holds at every tier`)
  assert.equal(notice?.setup, true)
  assert.match(notice?.body ?? "", /\*\*Denied, at every access level\*\*\n\n- `Write` · .*repo\/\.claude\/settings\.json\n- `Bash\(rm -rf \*\)` · ~\/\.grok\/config\.toml/)
}
rmSync(grokRoot, { recursive: true, force: true })
const grokUnset = await grokAcpSource.launch(grokLaunch)
assert.equal(grokUnset?.args[0], "agent", "no selection leaves the user's Grok configuration alone")
const grokEdits = await grokAcpSource.launch({ ...grokLaunch, access: "edits" })
assert.equal(grokEdits?.args[0], "agent", "a tier Grok cannot enforce over ACP is not forwarded")
const grokPlanFlag = await grokAcpSource.launch({ ...grokLaunch, access: "plan" })
assert.equal(grokPlanFlag?.args[0], "agent", "the weaker --permission-mode plan is never used; Plan is set live")
assert.deepEqual(acpInitialSelection(grokAcpSource.access, grokModes, null, accessModeId("full")), { currentMode: accessModeId("full") })
assert.deepEqual(acpInitialSelection(grokAcpSource.access, grokModes, null, "plan"), { currentMode: "plan" },
  "a session started in Plan reports it, though Grok lists no modes")
assert.deepEqual(acpModeChange(grokAcpSource.access, grokModes, accessModeId("full"), "full", "grok"), { kind: "unchanged", modeId: accessModeId("full") })
assert.throws(() => acpModeChange(grokAcpSource.access, grokModes, accessModeId("auto"), "full", "grok"), /when its session starts/)
assert.deepEqual(acpModeChange(grokAcpSource.access, grokModes, "plan", "full", "grok", accessModeId("full")),
  { kind: "native", modeId: "plan", nativeModeId: "plan" }, "Plan is entered live")
assert.throws(() => acpModeChange(grokAcpSource.access, grokModes, "invented-mode", "full", "grok"), /does not offer that mode/)
assert.deepEqual(acpModeChange(grokAcpSource.access, grokModes, accessModeId("full"), "full", "grok", "plan"),
  { kind: "native", modeId: accessModeId("full"), nativeModeId: "default" }, "leaving Plan returns to the launch tier through Grok's default mode")
assert.throws(() => acpModeChange(grokAcpSource.access, grokModes, accessModeId("ask"), "full", "grok", "plan"), /when its session starts/,
  "leaving Plan cannot reach another launch tier")
// Grok reports `default` on leaving plan, which means the tier it launched with.
assert.equal(acpReportedMode(grokAcpSource.access, "default", "auto"), accessModeId("auto"))
assert.equal(acpReportedMode(grokAcpSource.access, "plan", "auto"), "plan")
assert.equal(acpReportedMode(devinAcpSource.access, "plan", null), "plan")
// Grok reports no session modes over ACP, so the tier it launches with is
// the declared default: the desk always has a level to report.
assert.equal(acpDefaultMode(grokAcpSource.access), accessModeId("ask"))
assert.equal(acpLiveDriver(grokAcpSource).defaultMode, accessModeId("ask"))
assert.deepEqual(
  acpInitialSelection(grokAcpSource.access, grokModes, null, acpDefaultMode(grokAcpSource.access)),
  { currentMode: accessModeId("ask") },
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
assert.equal(openCodeLaunchAccess("plan", accessModeId("full")), "full", "a session opened in Plan launches at the level beside it, which building the plan uses")
assert.equal(openCodeLaunchAccess(accessModeId("edits"), accessModeId("full")), "edits", "a selected access mode wins over the launch level")
assert.equal(openCodeLaunchAccess("plan", undefined), "ask")
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
const workspaceWrite: SandboxPolicy = { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false }
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
  "Access modes: native policy ownership, Cursor SDK tiers, Devin native tiers, Grok launch tiers with a live Plan and no steering, OpenCode native agents and rulesets, Codex per-turn policy, and Claude bypass verified"
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
assert.throws(() => validateLiveDriver(codexWithout("approvalEvidence")), /Invalid/,
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
  () => validateLiveDriver({ ...codexLiveDriver, provider: "x", modes: [{ id: "a", name: "A", access: "full" }], modeSwitching: { kind: "single", reason: "x" } }),
  /no enforcer/
)
assert.throws(
  () => validateLiveDriver({ ...codexLiveDriver, provider: "x", modes: [{ id: "a", name: "A" }], modeSwitching: { kind: "single", reason: "x" }, defaultMode: "b" }),
  /not one of its declared modes/
)

// Every harness says how it plans and which native record carries the plan.
assert.deepEqual(Object.fromEntries(accessDrivers.map(driver => [driver.provider, driver.planning.via === "mode" ? `mode ${driver.planning.mode}` : `setting ${driver.planning.option}`])), {
  cursor: "setting plan", devin: "mode plan", grok: "mode plan", opencode: "mode plan", codex: "setting plan", claude: "mode plan",
})
assert.throws(() => validateLiveDriver({ ...claudeLiveDriver, planning: { via: "mode", mode: "acceptEdits", proposal: "x" } }), /doesn't offer as Plan/,
  "a harness can't plan through a mode its ladder doesn't offer as Plan")
assert.throws(() => validateLiveDriver({ ...claudeLiveDriver, defaultMode: "plan" }), /can't start in Plan unasked/)
assert.throws(() => validateLiveDriver(codexWithout("planning")), /how it plans/,
  "registration rejects a new adapter that doesn't say how it plans")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, planning: { via: "setting", option: "plan", proposal: " " } }), /how its plan reaches Mako/)

// Stop ends the turn and the background work it started on every harness.
assert.deepEqual(Object.fromEntries(accessDrivers.map(driver => [driver.provider, driver.backgroundStop.kind])), {
  cursor: "ends-with-turn", devin: "ends-on-stop", grok: "ends-on-stop", opencode: "ends-on-stop", codex: "ends-on-stop", claude: "ends-on-stop",
}, "every adapter says how Stop ends its background work, or why none outlives its turn")
assert.throws(() => validateLiveDriver(codexWithout("backgroundStop")), /how Stop ends its background work/,
  "registration rejects a new adapter that does not say how Stop ends its background work")
assert.throws(() => validateLiveDriver({ ...codexLiveDriver, backgroundStop: { kind: "ends-on-stop", how: " " } }), /how Stop ends its background work/)
assert.throws(() => acpLiveDriver({ ...devinAcpSource, observeBackground: undefined }), /background observer/,
  "an ACP adapter ends background work on Stop only through its background observer")
