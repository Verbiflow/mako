import type { HarnessPresentation } from "../contracts/harness-presentation.js"
import { capabilityText, implemented, LIVE_CAPABILITY_LABELS, type Capability } from "../contracts/harness-capabilities.js"
import { HARNESS_USAGE_KEYS, HARNESS_USAGE_LABELS, type HarnessUsage, type UsageDeclaration } from "../contracts/harness-usage.js"
import type { ProviderAuthoringCapability, ProviderEditingCapability, ProviderMcpEditing, ProviderMcpSource, ProviderSkillSource } from "../tools/index.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderArtifactPreview } from "../workspaces/index.js"
import { VOCABULARIES } from "@mako/sessions/harnesses"
import {
  HARNESS_FEATURE_KEYS,
  HARNESS_FEATURES,
  TOOL_ROWS_VIA,
  type ArtifactCapability,
  type FeatureDeclarations,
  type HarnessFeature,
  type HarnessFeatures,
  type UniqueCapability,
} from "../contracts/harness-features.js"
import type { ProviderConnectionCapability } from "./connection-capability.js"
import type { ProviderDecoderSource } from "./decoder-source.js"
import type { ProviderHost } from "./host.js"
import { validateLiveDriver, type ProviderLiveDriver } from "./live-driver.js"
import { liveCapabilities, type LiveCapabilities } from "./live-capabilities.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProcessProbe, ProviderSessionEmitter } from "../threads/index.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderRegistry, ProviderCapability } from "./registry.js"
import type { ProviderUpdateSource } from "./update-source.js"
import type { ProviderUsageHistory } from "../usage/index.js"
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
  /** What it calls each of Mako's shared features (`HARNESS_FEATURES`), and where Mako stands on each. */
  features: FeatureDeclarations
  /** What only this harness has, with its tool rows or why nothing shows it. */
  unique: readonly UniqueCapability[]
  hooks: ProviderAuthoringCapability | Absent
  commands: ProviderAuthoringCapability | Absent
  toolEditing: ProviderAuthoringCapability | Absent
  skillEditing: ProviderEditingCapability | Absent
  mcpEditing: ProviderMcpEditing | Absent
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

export type HarnessFamily = Exclude<keyof HarnessDefinition, "provider" | "presentation" | "diagnostics" | "usage" | "features" | "unique">

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
  hooks: "Its hooks in every file it reads them from, created, edited, turned off and removed from Settings, each change previewed as a diff.",
  commands: "Its custom commands in every folder it reads them from, created, edited and removed from Settings.",
  toolEditing: "Tool authoring from Settings.",
  skillEditing: "Importing and removing skills in the harness's own folders.",
  mcpEditing: "Its MCP servers in its own configuration: copied in from another harness, turned off and on, and removed.",
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
  artifacts: ArtifactCapability
  features: HarnessFeatures
  unique: readonly UniqueCapability[]
}

/** The artifact preview family as the window reads it: the files it covers, or why there are none. */
export function artifactCapability(preview: ProviderArtifactPreview | Absent): ArtifactCapability {
  return isAbsent(preview)
    ? { state: "absent", by: preview.absent, reason: preview.reason }
    : { state: "implemented", via: preview.via, name: preview.name, files: [...preview.files] }
}

type Tools = (typeof VOCABULARIES)[number]["tools"]

function vocabularyTools(provider: string): Tools {
  return VOCABULARIES.find((vocabulary) => vocabulary.harness === provider)?.tools ?? {}
}

/**
 * Each feature as the window reads it. A declaration that can't stand is
 * refused: one left unexplained, its own form unnamed, Mako's own declared
 * missing, or a lack its vocabulary contradicts. A tool the harness lists as
 * its own is no shared feature's tool row.
 */
function resolveFeatures(provider: string, features: FeatureDeclarations | undefined, unique: readonly UniqueCapability[]): HarnessFeatures {
  const refuse = (problem: string): never => { throw new Error(`${provider} ${problem}`) }
  if (!features) return refuse("doesn't say what it calls Mako's shared features")
  const own = new Set(unique.flatMap(({ mako }) => mako.state === "implemented" ? mako.tools : []))
  const tools = Object.entries(vocabularyTools(provider)).filter(([name]) => !own.has(name))
  const resolved: Partial<HarnessFeatures> = {}
  for (const key of HARNESS_FEATURE_KEYS) {
    const info: { name: string; mako?: string; tools?: string } = HARNESS_FEATURES[key]
    const declared = features[key]
    if (!declared) return refuse(`declares nothing for ${info.name}`)
    const { native, mako } = declared
    if (native && (!native.name.trim() || !native.where.trim())) return refuse(`must say what it calls ${info.name} and where it has it`)
    const ofKind = info.tools ? tools.filter(([, tool]) => tool.kind === info.tools) : []
    let feature: HarnessFeature
    if (mako.state !== "implemented") {
      if (!mako.reason.trim()) return refuse(`must explain where ${info.name} stands`)
      if (mako.state === "absent" && mako.by === "harness") {
        if (info.mako) return refuse(`says it lacks ${info.name}, but Mako's own serves every harness`)
        const offered = ofKind.find(([, tool]) => !tool.unlisted)
        if (offered) return refuse(`says it lacks ${info.name}, but its vocabulary offers \`${offered[0]}\``)
      }
      feature = { mako }
    } else if (mako.through === "harness") {
      if (!native) return refuse(`shows its own ${info.name} without naming it`)
      if (!mako.via.trim()) return refuse(`must say where ${info.name} shows`)
      feature = { mako: { state: "implemented", through: "harness", via: mako.via } }
    } else if (mako.through === "tools") {
      if (!info.tools) return refuse(`shows ${info.name} in tool rows, but no kind of tool carries it`)
      const names = ofKind.map(([name]) => name)
      if (!names.length && !native) return refuse(`shows ${info.name} in tool rows, but its vocabulary has no ${info.tools} tool`)
      feature = {
        native: native ?? { name: names.join(", "), where: `its ${names.map((name) => `\`${name}\``).join(", ")} ${names.length === 1 ? "tool" : "tools"}` },
        mako: { state: "implemented", through: "harness", via: TOOL_ROWS_VIA },
      }
    } else {
      if (!info.mako) return refuse(`says Mako's own ${info.name} serves it, but Mako has none`)
      feature = { mako: { state: "implemented", through: "mako", via: mako.note ? `${info.mako} ${mako.note}` : info.mako } }
    }
    resolved[key] = native && !feature.native ? { native, ...feature } : feature
  }
  // SAFETY: the loop above assigned every key in HARNESS_FEATURE_KEYS.
  return resolved as HarnessFeatures
}

/** Names that are shared, so no harness can list them as its own. */
const SHARED_NAMES = new Map<string, string>([
  ...HARNESS_FEATURE_KEYS.map((key) => [HARNESS_FEATURES[key].name, `Mako's shared ${HARNESS_FEATURES[key].name}; declare it in \`features\``] as const),
  ...Object.values(LIVE_CAPABILITY_LABELS).map((label) => [label, `the shared capability ${label}; declare it in its live driver`] as const),
  ...Object.values(HARNESS_USAGE_LABELS).map((label) => [label, `the shared usage field ${label}; declare it in \`usage\``] as const),
  ["Artifact previews", "the shared `artifactPreview` family"],
].map(([name, where]) => [name.toLowerCase(), where]))

/** Why a harness's own features can't be installed: one unexplained, one that is shared, or tool rows its vocabulary doesn't declare. */
function uniqueProblem(harness: HarnessDefinition): string | undefined {
  const names = new Set<string>()
  const tools = vocabularyTools(harness.provider)
  for (const { name, native, mako } of harness.unique) {
    if (!name.trim() || !native.trim()) return "must name each of its own features and say what carries it"
    if (names.has(name)) return `lists its own feature ${name} twice`
    names.add(name)
    const shared = SHARED_NAMES.get(name.trim().toLowerCase())
    if (shared) return `lists ${name} as its own, but it's ${shared}`
    if (!capabilityText(mako).trim()) return `must say where ${name} stands in Mako`
    if (mako.state === "absent" && mako.by === "harness") return `lists ${name} as its own feature and as one it lacks`
    if (mako.state !== "implemented") continue
    const unknown = mako.tools.find((tool) => !Object.hasOwn(tools, tool))
    if (!mako.tools.length || unknown) return `shows ${name} in tool rows for ${unknown ?? "no tool"}, which its vocabulary doesn't declare`
  }
  return undefined
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
  if (usage.limitSwitch.state === "implemented" && (isAbsent(accounts) || accounts.mode !== "selectable"))
    return "offers another account at a limit, but its accounts can't be switched"
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
  const { provider, presentation, diagnostics, usage, features: declaredFeatures, unique, ...declarations } = harness
  if (!usage) throw new Error(`${provider} has no usage declaration`)
  if (!unique) throw new Error(`${provider} doesn't list what only it has`)
  const features = resolveFeatures(provider, declaredFeatures, unique)
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
  const goals = features.goals.mako
  const declaredGoals = goals.state === "implemented" ? goals.through : "absent"
  if (declaredGoals !== (harness.live.goals.kind === "native" ? "harness" : "mako"))
    throw new Error(`${provider} declares its goals as ${declaredGoals}, but its live driver keeps them ${harness.live.goals.kind === "native" ? "natively" : "in Mako's loop"}`)
  const side = features.sideQuestions.mako
  const declaredSide = side.state === "implemented" ? side.through : "absent"
  const drivenSide = harness.live.sideQuestions.kind === "native" ? "harness" : harness.live.sideQuestions.kind === "fork" ? "mako" : "absent"
  if (declaredSide !== drivenSide)
    throw new Error(`${provider} declares its side questions as ${declaredSide}, but its live driver answers them ${drivenSide === "harness" ? "natively" : drivenSide === "mako" ? "from a copy of the session" : "not at all"}`)
  const review = features.review.mako
  const declaredReview = review.state === "implemented" ? review.through : "absent"
  if (declaredReview !== (harness.live.review.kind === "native" ? "harness" : "mako"))
    throw new Error(`${provider} declares its review as ${declaredReview}, but its live driver starts ${harness.live.review.kind === "native" ? "the harness's own review" : "Mako's review prompt"}`)
  if (harness.live.fork.kind === "import" && isAbsent(harness.sessionEmitter))
    throw new Error(`${provider} forks by importing the conversation into a new session, which needs its session emitter`)
  const usageRefusal = usageProblem(harness)
  if (usageRefusal) throw new Error(`${provider} ${usageRefusal}`)
  const preview = harness.artifactPreview
  if (!isAbsent(preview) && (!preview.name.trim() || !preview.via.trim() || !preview.files.length || preview.files.some((ending) => !ending.trim())))
    throw new Error(`${provider} must name its artifacts, the files they are and how it makes them`)
  const capabilities = liveCapabilities(harness.live)
  const declared = { capabilities, usage: harnessUsage(harness, capabilities), artifacts: artifactCapability(preview), features }
  const uniqueRefusal = uniqueProblem(harness)
  if (uniqueRefusal) throw new Error(`${provider} ${uniqueRefusal}`)
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
    registry: Pick<ProviderRegistry<T>, "register">,
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
  host.harnesses.register({ provider: harness.provider, presentation, diagnostics, absent, ...declared, unique })
}
