import type { HarnessPresentation } from "../contracts/harness-presentation.js"
import { capabilityText, implemented, type Capability } from "../contracts/harness-capabilities.js"
import { HARNESS_USAGE_KEYS, type HarnessUsage, type UsageDeclaration } from "../contracts/harness-usage.js"
import type { ProviderAuthoringCapability, ProviderEditingCapability } from "./editing-capability.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderArtifactPreview } from "./artifact-preview.js"
import type { ProviderConnectionCapability } from "./connection-capability.js"
import type { ProviderDecoderSource } from "./decoder-source.js"
import type { ProviderHost } from "./host.js"
import { validateLiveDriver, type ProviderLiveDriver } from "./live-driver.js"
import { liveCapabilities, type LiveCapabilities } from "./live-capabilities.js"
import type { ProviderMcpSource } from "./mcp-source.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProcessProbe } from "./process-probe.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderRegistry, ProviderCapability } from "./registry.js"
import type { ProviderSessionEmitter } from "./session-emitter.js"
import type { ProviderSkillSource } from "./skill-source.js"
import type { ProviderUpdateSource } from "./update-source.js"
import type { ProviderUsageHistory } from "./usage-history.js"
/**
 * Why a harness has no capability for a family: the harness itself has no
 * such thing, or it has one Mako does not drive yet. The second is a gap.
 */
export interface Absent {
  absent: "harness" | "mako"
  reason: string
}

/** The harness has no such thing. */
export const lacks = (reason: string): Absent => ({ absent: "harness", reason })
/** The harness has one; Mako does not drive it yet. */
export const notBuilt = (reason: string): Absent => ({ absent: "mako", reason })

/** What `npm run harness:doctor` reads about a harness beyond its capabilities. */
export interface HarnessDiagnostics {
  /** The npm package Mako drives the harness through; the doctor compares its version with the fixtures'. */
  sdk?: string
  /** Sessions run inside `sdk`, so its version is the runtime's; otherwise the doctor asks the updates family's binary. */
  runsInSdk?: true
  /** The host-log scope the harness's sign-in writes to; the doctor shows its latest line. */
  signInLog?: string
}

/**
 * Everything one harness supplies to Mako. Every family is named: a harness
 * gives the capability or says why it has none, so a new harness cannot leave
 * one out without the type checker asking. What each family is:
 * `HARNESS_FAMILIES`.
 */
export interface HarnessDefinition {
  provider: string
  presentation: HarnessPresentation
  diagnostics: HarnessDiagnostics
  /** What it reports about usage, which the meter, Settings › Usage and the account rows read. */
  usage: UsageDeclaration
  hooks: ProviderAuthoringCapability | Absent
  commands: ProviderAuthoringCapability | Absent
  toolEditing: ProviderAuthoringCapability | Absent
  skillEditing: ProviderEditingCapability | Absent
  mcpEditing: ProviderEditingCapability | Absent
  live: ProviderLiveDriver
  decoder: ProviderDecoderSource | Absent
  profile: ProviderProfileLoader
  accounts: ProviderAccountCapability | Absent
  acp: ProviderAcpSource | Absent
  nativeRunner: NativeRunner | Absent
  processProbe: ProviderProcessProbe | Absent
  mcp: ProviderMcpSource | Absent
  skills: ProviderSkillSource | Absent
  sessionEmitter: ProviderSessionEmitter | Absent
  connection: ProviderConnectionCapability | Absent
  updates: ProviderUpdateSource | Absent
  usageHistory: ProviderUsageHistory | Absent
  artifactPreview: ProviderArtifactPreview | Absent
}

export type HarnessFamily = Exclude<keyof HarnessDefinition, "provider" | "presentation" | "diagnostics" | "usage">

/** What each family is, in the words the new-harness checklist (`npm run harness:checklist`) shows. */
export const HARNESS_FAMILIES = {
  live: "Starts, streams, steers, answers and stops turns, and declares where it stands on each live capability.",
  profile: "Its name, models, modes, settings and sign-in state, and the models Mako picks for it until the person does.",
  decoder: "Turns the harness's native messages into Mako's decoded events, outside the driver, so recorded sessions replay as fixtures.",
  acp: "The harness's ACP agent, when its live driver runs on one.",
  accounts: "Which of the person's accounts a session runs as, and whether the harness reports it.",
  connection: "A sign-in Mako drives from Settings.",
  processProbe: "Matches the harness's own processes to its sessions, so Mako never reopens a session another process holds.",
  sessionEmitter: "Writes a Mako conversation into the harness's store, to continue there or to fork by import.",
  nativeRunner: "Headless runs outside a live conversation.",
  mcp: "The MCP servers the harness reads, for the MCP registry.",
  skills: "The skills the harness reads, for the skill registry and for handing skills over.",
  hooks: "Hook discovery and editing from Settings.",
  commands: "Custom command authoring from Settings.",
  toolEditing: "Tool authoring from Settings.",
  skillEditing: "Importing and removing skills in the harness's own folders.",
  mcpEditing: "Importing and editing MCP servers in the harness's own configuration.",
  updates: "Finding, versioning and updating the harness's binary.",
  usageHistory: "Spend the harness's own store records; without it, Settings › Usage shows what Mako measured.",
  artifactPreview: "Previews of files the harness writes as artifacts.",
} as const satisfies { readonly [Family in HarnessFamily]: string }

/** What an installed harness said it has no capability for, and where it stands on each live one. */
export interface HarnessRecord {
  provider: string
  presentation: HarnessPresentation
  diagnostics: HarnessDiagnostics
  absent: Partial<Record<HarnessFamily, Absent>>
  capabilities: LiveCapabilities
  usage: HarnessUsage
}

/**
 * The usage declaration with what other families already say: the context
 * breakdown is the live driver's, and spend outside Mako is the usage
 * history's, each in its own words.
 */
export function harnessUsage(harness: Pick<HarnessDefinition, "usage" | "usageHistory">, capabilities: LiveCapabilities): HarnessUsage {
  const history = harness.usageHistory
  return {
    ...harness.usage,
    contextBreakdown: capabilities.contextBreakdown,
    outsideMako: isAbsent(history)
      ? { state: "absent", by: history.absent, reason: `${history.reason}, so only its sessions in Mako are counted.` }
      : implemented("Its own store is read, so sessions run outside Mako are counted too."),
  }
}

/** Why a usage declaration can't be installed: a field left unexplained, or one another declaration contradicts. */
function usageProblem(harness: HarnessDefinition): string | undefined {
  const { usage, live, accounts } = harness
  for (const key of HARNESS_USAGE_KEYS) {
    if (key === "contextBreakdown" || key === "outsideMako") continue
    const field: Capability | undefined = usage[key]
    if (!field) return `declares no usage ${key}`
    if (!capabilityText(field).trim()) return `must explain its usage ${key}`
    if (field.state === "no-op" || (field.state === "default" && key !== "compaction"))
      return `declares its usage ${key} ${field.state}; only after compaction can a reading wait for the next reply`
  }
  if ((usage.context.state === "absent") !== (usage.window.state === "absent"))
    return "declares a context fill without its window, or a window with no fill to measure"
  if (usage.context.state === "absent" && usage.compaction.state !== "absent")
    return "says what its meter reads after compaction, but has no context meter"
  if (live.compaction.kind === "unavailable" && usage.compaction.state !== "absent")
    return "says what its meter reads after compaction, but never compacts"
  const spends = !isAbsent(accounts) && accounts.useResetCredit !== undefined
  if (spends !== (usage.resetCredits.state === "implemented"))
    return spends ? "spends reset credits but declares none" : "declares reset credits its accounts can't spend"
  return undefined
}

export function isAbsent<T extends ProviderCapability>(value: T | Absent): value is Absent {
  return "absent" in value && "reason" in value
}

export function installHarness(host: ProviderHost, harness: HarnessDefinition): void {
  const { mark } = harness.presentation
  if (!/^-?[\d.]+ -?[\d.]+ [\d.]+ [\d.]+$/.test(mark.viewBox) || !mark.paths.length || mark.paths.some((path) => !path.d.trim()) || !mark.tint.trim())
    throw new Error(`${harness.provider} must declare its mark: a viewBox, its paths and a tint`)
  // Validate every family before registering anything: an incomplete adapter
  // must not leave half of its capabilities installed.
  if (harness.diagnostics.runsInSdk && !harness.diagnostics.sdk) throw new Error(`${harness.provider} runs in an SDK it does not name`)
  const { provider, presentation, diagnostics, usage, ...declarations } = harness
  if (!usage) throw new Error(`${provider} has no usage declaration`)
  for (const [family, value] of Object.entries(declarations)) {
    if (!value) throw new Error(`${provider} has no ${family} declaration`)
    if (isAbsent(value)) {
      if (!value.reason.trim())
        throw new Error(`${harness.provider} must explain its absent ${family}`)
    } else if (!("provider" in value) || value.provider !== harness.provider) {
      throw new Error(`${harness.provider}'s ${family} capability is filed under ${"provider" in value ? value.provider : "no provider"}`)
    }
  }
  // Native recovery preconditions must fail before installing any contribution.
  validateLiveDriver(harness.live)
  if (harness.live.fork.kind === "import" && isAbsent(harness.sessionEmitter))
    throw new Error(`${provider} forks by importing the conversation into a new session, which needs its session emitter`)
  const usageRefusal = usageProblem(harness)
  if (usageRefusal) throw new Error(`${provider} ${usageRefusal}`)
  if (!harness.profile.defaults.work.length && !harness.profile.defaults.none?.trim())
    throw new Error(`${provider} picks no model for new conversations and doesn't say why`)
  if (!isAbsent(harness.nativeRunner) && !harness.nativeRunner.transport?.trim())
    throw new Error(`${provider} must declare its headless transport`)
  if (!isAbsent(harness.nativeRunner)) {
    const credentials = harness.nativeRunner.launchCredentials
    if (!credentials || (credentials.kind === "resolved" ? !credentials.resolve : credentials.kind !== "unavailable" || !credentials.reason.trim()))
      throw new Error(`${provider} must declare headless credential resolution or explain why it is unavailable`)
  }
  const absent: HarnessRecord["absent"] = {}
  const install = <T extends ProviderCapability>(
    registry: ProviderRegistry<T>,
    family: HarnessFamily,
    value: T | Absent
  ) => {
    if (isAbsent(value)) {
      absent[family] = value
      return
    }
    if (value.provider !== harness.provider) {
      throw new Error(`${harness.provider}'s ${family} capability is filed under ${value.provider}`)
    }
    registry.register(value)
  }
  install(host.hooks, "hooks", harness.hooks)
  install(host.commands, "commands", harness.commands)
  install(host.toolEditing, "toolEditing", harness.toolEditing)
  install(host.skillEditing, "skillEditing", harness.skillEditing)
  install(host.mcpEditing, "mcpEditing", harness.mcpEditing)
  install(host.liveDrivers, "live", harness.live)
  install(host.decoders, "decoder", harness.decoder)
  install(host.profiles, "profile", harness.profile)
  install(host.accountCapabilities, "accounts", harness.accounts)
  install(host.acpSources, "acp", harness.acp)
  install(host.nativeRunners, "nativeRunner", harness.nativeRunner)
  install(host.processProbes, "processProbe", harness.processProbe)
  install(host.mcpSources, "mcp", harness.mcp)
  install(host.skillSources, "skills", harness.skills)
  install(host.sessionEmitters, "sessionEmitter", harness.sessionEmitter)
  install(host.connections, "connection", harness.connection)
  install(host.updateSources, "updates", harness.updates)
  install(host.usageHistories, "usageHistory", harness.usageHistory)
  install(host.artifactPreviews, "artifactPreview", harness.artifactPreview)
  const capabilities = liveCapabilities(harness.live)
  host.harnesses.register({ provider: harness.provider, presentation, diagnostics, absent, capabilities, usage: harnessUsage(harness, capabilities) })
}
