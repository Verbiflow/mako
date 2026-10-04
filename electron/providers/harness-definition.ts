import type { HarnessPresentation } from "../contracts/harness-presentation.js"
import type { ProviderAuthoringCapability, ProviderEditingCapability } from "./editing-capability.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderArtifactPreview } from "./artifact-preview.js"
import type { ProviderConnectionCapability } from "./connection-capability.js"
import type { ProviderDecoderSource } from "./decoder-source.js"
import type { ProviderHost } from "./host.js"
import { validateLiveDriver, type ProviderLiveDriver } from "./live-driver.js"
import type { ProviderMcpSource } from "./mcp-source.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProcessProbe } from "./process-probe.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderRegistry, ProviderCapability } from "./registry.js"
import type { ProviderSessionEmitter } from "./session-emitter.js"
import type { ProviderSkillSource } from "./skill-source.js"
import type { ProviderUpdateSource } from "./update-source.js"
import type { ProviderUtilityRunner } from "./utility-runner.js"

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

/**
 * Everything one harness supplies to Mako. Every family is named: a harness
 * gives the capability or says why it has none, so a new harness cannot leave
 * one out without the type checker asking.
 */
export interface HarnessDefinition {
  provider: string
  presentation: HarnessPresentation
  hooks: ProviderAuthoringCapability | Absent
  commands: ProviderAuthoringCapability | Absent
  toolEditing: ProviderAuthoringCapability | Absent
  skillEditing: ProviderEditingCapability | Absent
  mcpEditing: ProviderEditingCapability | Absent
  /** Starts, streams, steers, answers and stops turns. */
  live: ProviderLiveDriver
  /**
   * Turns the harness's native messages into Mako's decoded events, outside
   * the driver, so recorded sessions replay as fixtures.
   */
  decoder: ProviderDecoderSource | Absent
  /** Models, modes, settings and sign-in state. */
  profile: ProviderProfileLoader
  accounts: ProviderAccountCapability | Absent
  /** The harness's ACP agent, when its live driver runs on one. */
  acp: ProviderAcpSource | Absent
  /** Headless runs outside a live conversation. */
  nativeRunner: NativeRunner | Absent
  /** Small requests on a light model that leave nothing in the app's history, such as commit messages. */
  utility: ProviderUtilityRunner | Absent
  /** Matches the harness's own processes to its sessions. */
  processProbe: ProviderProcessProbe | Absent
  mcp: ProviderMcpSource | Absent
  skills: ProviderSkillSource | Absent
  /** Writes a Mako conversation into the harness's store to continue there. */
  sessionEmitter: ProviderSessionEmitter | Absent
  /** A sign-in Mako drives from Settings. */
  connection: ProviderConnectionCapability | Absent
  updates: ProviderUpdateSource | Absent
  artifactPreview: ProviderArtifactPreview | Absent
}

export type HarnessFamily = Exclude<keyof HarnessDefinition, "provider" | "presentation">

/** What an installed harness said it has no capability for. */
export interface HarnessRecord {
  provider: string
  presentation: HarnessPresentation
  absent: Partial<Record<HarnessFamily, Absent>>
}

export function isAbsent<T extends ProviderCapability>(value: T | Absent): value is Absent {
  return "absent" in value && "reason" in value
}

export function installHarness(host: ProviderHost, harness: HarnessDefinition): void {
  if (!harness.presentation.icon.id || !harness.presentation.icon.tint)
    throw new Error(`${harness.provider} must declare its icon`)
  // Validate every family before registering anything: an incomplete adapter
  // must not leave half of its capabilities installed.
  const { provider, presentation, ...declarations } = harness
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
  install(host.utilityRunners, "utility", harness.utility)
  install(host.processProbes, "processProbe", harness.processProbe)
  install(host.mcpSources, "mcp", harness.mcp)
  install(host.skillSources, "skills", harness.skills)
  install(host.sessionEmitters, "sessionEmitter", harness.sessionEmitter)
  install(host.connections, "connection", harness.connection)
  install(host.updateSources, "updates", harness.updates)
  install(host.artifactPreviews, "artifactPreview", harness.artifactPreview)
  host.harnesses.register({ provider: harness.provider, presentation, absent })
}
