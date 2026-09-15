import type { ProviderArtifactPreview } from "./artifact-preview.js"
import type { ProviderLiveDriver } from "./live-driver.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderConnectionCapability } from "./connection-capability.js"
import type { ProviderMcpSource } from "./mcp-source.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProcessProbe } from "./process-probe.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderSessionEmitter } from "./session-emitter.js"
import type { ProviderSkillSource } from "./skill-source.js"
import type { ProviderUpdateSource } from "./update-source.js"
import { ProviderRegistry } from "./registry.js"
import { validateLiveDriver } from "./live-driver.js"

export interface ProviderHost {
  artifactPreviews: ProviderRegistry<ProviderArtifactPreview>
  liveDrivers: ProviderRegistry<ProviderLiveDriver>
  nativeRunners: ProviderRegistry<NativeRunner>
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
}

export type ProviderModule = (host: ProviderHost) => void

export function createProviderHost(): ProviderHost {
  return {
    artifactPreviews: new ProviderRegistry(),
    liveDrivers: new ProviderRegistry(validateLiveDriver),
    nativeRunners: new ProviderRegistry(),
    acpSources: new ProviderRegistry(),
    profiles: new ProviderRegistry(),
    processProbes: new ProviderRegistry(),
    mcpSources: new ProviderRegistry(),
    skillSources: new ProviderRegistry(),
    sessionEmitters: new ProviderRegistry(),
    connections: new ProviderRegistry(),
    updateSources: new ProviderRegistry(),
    accountCapabilities: new ProviderRegistry(),
  }
}
