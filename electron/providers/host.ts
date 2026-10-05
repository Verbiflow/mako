import type { ProviderAuthoringCapability, ProviderEditingCapability } from "./editing-capability.js"
import type { ProviderArtifactPreview } from "./artifact-preview.js"
import type { ProviderLiveDriver } from "./live-driver.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderConnectionCapability } from "./connection-capability.js"
import type { ProviderDecoderSource } from "./decoder-source.js"
import type { HarnessRecord } from "./harness-definition.js"
import type { ProviderMcpSource } from "./mcp-source.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProcessProbe } from "./process-probe.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderSessionEmitter } from "./session-emitter.js"
import type { ProviderSkillSource } from "./skill-source.js"
import type { ProviderUpdateSource } from "./update-source.js"
import type { ProviderUsageHistory } from "./usage-history.js"
import type { ProviderUtilityRunner } from "./utility-runner.js"
import { ProviderRegistry } from "./registry.js"
import { validateLiveDriver } from "./live-driver.js"
import { withNativeExclusion } from "./native-exclusion.js"
import { withExecutionAdmission } from "./execution-admission.js"

export interface ProviderHost {
  /** Every installed harness, with what it said it has no capability for. */
  harnesses: ProviderRegistry<HarnessRecord>
  hooks: ProviderRegistry<ProviderAuthoringCapability>
  commands: ProviderRegistry<ProviderAuthoringCapability>
  toolEditing: ProviderRegistry<ProviderAuthoringCapability>
  skillEditing: ProviderRegistry<ProviderEditingCapability>
  mcpEditing: ProviderRegistry<ProviderEditingCapability>
  artifactPreviews: ProviderRegistry<ProviderArtifactPreview>
  liveDrivers: ProviderRegistry<ProviderLiveDriver>
  /** Each harness's native-event decoder, for fixtures and the decode tool. */
  decoders: ProviderRegistry<ProviderDecoderSource>
  nativeRunners: ProviderRegistry<NativeRunner>
  utilityRunners: ProviderRegistry<ProviderUtilityRunner>
  acpSources: ProviderRegistry<ProviderAcpSource>
  profiles: ProviderRegistry<ProviderProfileLoader>
  processProbes: ProviderRegistry<ProviderProcessProbe>
  mcpSources: ProviderRegistry<ProviderMcpSource>
  skillSources: ProviderRegistry<ProviderSkillSource>
  sessionEmitters: ProviderRegistry<ProviderSessionEmitter>
  accountCapabilities: ProviderRegistry<ProviderAccountCapability>
  /** Transports with their own sign-in, shown and driven from Settings. */
  connections: ProviderRegistry<ProviderConnectionCapability>
  /** How each provider's runtime updates — and whether Mako can run it. */
  updateSources: ProviderRegistry<ProviderUpdateSource>
  /** Each harness's own spend records, read for Settings › Usage. */
  usageHistories: ProviderRegistry<ProviderUsageHistory>
}

export type ProviderModule = (host: ProviderHost) => void

export function createProviderHost(): ProviderHost {
  return {
    harnesses: new ProviderRegistry(),
    hooks: new ProviderRegistry(),
    commands: new ProviderRegistry(),
    toolEditing: new ProviderRegistry(),
    skillEditing: new ProviderRegistry(),
    mcpEditing: new ProviderRegistry(),
    artifactPreviews: new ProviderRegistry(),
    liveDrivers: new ProviderRegistry(validateLiveDriver, driver => withExecutionAdmission(withNativeExclusion(driver))),
    decoders: new ProviderRegistry(),
    nativeRunners: new ProviderRegistry(),
    utilityRunners: new ProviderRegistry(),
    acpSources: new ProviderRegistry(),
    profiles: new ProviderRegistry(),
    processProbes: new ProviderRegistry(),
    mcpSources: new ProviderRegistry(),
    skillSources: new ProviderRegistry(),
    sessionEmitters: new ProviderRegistry(),
    connections: new ProviderRegistry(),
    updateSources: new ProviderRegistry(),
    usageHistories: new ProviderRegistry(),
    accountCapabilities: new ProviderRegistry(),
  }
}
