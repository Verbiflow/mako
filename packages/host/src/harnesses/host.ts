import type { ProviderAuthoringCapability, ProviderEditingCapability, ProviderMcpEditing, ProviderMcpSource, ProviderSkillSource } from "../tools/index.js"
import type { ProviderArtifactPreview } from "../workspaces/index.js"
import type { ProviderAccountCapability } from "./account-capability.js"
import type { ProviderAcpSource } from "./acp-source.js"
import type { ProviderConnectionCapability } from "./connection-capability.js"
import type { ProviderDecoderSource } from "./decoder-source.js"
import type { HarnessRecord } from "./harness-definition.js"
import type { NativeRunner } from "./native-runner.js"
import type { ProviderProcessProbe } from "../threads/index.js"
import type { ProviderProfileLoader } from "./profile-loader.js"
import type { ProviderUpdateSource } from "./update-source.js"
import type { ProviderUsageHistory } from "../usage/index.js"
import { ProviderRegistry } from "./registry.js"
import { DiscoveryProcesses } from "./discovery-process.js"
import { LiveDrivers } from "./live-drivers.js"
import { runtimeFloor } from "./runtime-floor.js"
import { accountAdmission } from "./execution-admission.js"
import { HarnessAccounts } from "./accounts.js"
import { join } from "node:path"
import type { NativeStores } from "@mako/sessions/read-only-sqlite"
import type { DomainSecrets } from "../base/host-secrets.js"
import { unwatchedWork, type HostWork } from "../base/event-loop.js"

export interface ProviderHost {
  /** Every installed harness, with what it said it has no capability for. */
  harnesses: ProviderRegistry<HarnessRecord>
  hooks: ProviderRegistry<ProviderAuthoringCapability>
  commands: ProviderRegistry<ProviderAuthoringCapability>
  toolEditing: ProviderRegistry<ProviderAuthoringCapability>
  skillEditing: ProviderRegistry<ProviderEditingCapability>
  mcpEditing: ProviderRegistry<ProviderMcpEditing>
  artifactPreviews: ProviderRegistry<ProviderArtifactPreview>
  liveDrivers: LiveDrivers
  /** Each harness's native-event decoder, for fixtures and the decode tool. */
  decoders: ProviderRegistry<ProviderDecoderSource>
  nativeRunners: ProviderRegistry<NativeRunner>
  acpSources: ProviderRegistry<ProviderAcpSource>
  profiles: ProviderRegistry<ProviderProfileLoader>
  processProbes: ProviderRegistry<ProviderProcessProbe>
  mcpSources: ProviderRegistry<ProviderMcpSource>
  skillSources: ProviderRegistry<ProviderSkillSource>
  accountCapabilities: ProviderRegistry<ProviderAccountCapability>
  /** The accounts each harness can run on, over `accountCapabilities`. */
  accounts: HarnessAccounts
  /** Transports with their own sign-in, shown and driven from Settings. */
  connections: ProviderRegistry<ProviderConnectionCapability>
  /** How each provider's runtime updates — and whether Mako can run it. */
  updateSources: ProviderRegistry<ProviderUpdateSource>
  /** Each harness's own spend records, read for Settings › Usage. */
  usageHistories: ProviderRegistry<ProviderUsageHistory>
  /** The CLIs run to discover settings, accounts and versions, bounded together. */
  discovery: DiscoveryProcesses
}

/** What the host a harness serves gives it: where its files go, its secrets and the person's screen. */
export interface HarnessContext {
  /** The host's data root; a launch keeps the native approvals it observed under `approval-evidence`. */
  readonly dataRoot: string
  /** The app's own files, where a harness's bundled adapter is found. */
  readonly appRoot: string
  /** The host's secrets, which a harness keeps its keys in. */
  readonly secrets: DomainSecrets
  /** How this host opens a harness's own databases: strict on the fixture desk, which writes none. */
  readonly stores: NativeStores
  /** Opens a page for the person, such as a sign-in. */
  openUrl(url: string): Promise<void>
  /** The host's named work, which launches report their phases to. */
  readonly work: HostWork
  /** Where each launch keeps the frames its harness sent (`native-stream.ts`), in the record store's `streams` folder; a host without one keeps none. */
  readonly streams?: string
}

/** Where a launch keeps the native approvals it observed. */
export function approvalRoot(context: Pick<HarnessContext, "dataRoot">): string {
  return join(context.dataRoot, "approval-evidence")
}

export type ProviderModule = (host: ProviderHost, context: HarnessContext) => void

export function createProviderHost(work: HostWork = unwatchedWork): ProviderHost {
  const accountCapabilities = new ProviderRegistry<ProviderAccountCapability>()
  const accounts = new HarnessAccounts(accountCapabilities)
  const harnesses = new ProviderRegistry<HarnessRecord>()
  const profiles = new ProviderRegistry<ProviderProfileLoader>()
  const updateSources = new ProviderRegistry<ProviderUpdateSource>()
  const floor = runtimeFloor(
    (provider) => updateSources.get(provider),
    (provider) => profiles.get(provider)?.label ?? provider
  )
  return {
    harnesses,
    hooks: new ProviderRegistry(),
    commands: new ProviderRegistry(),
    toolEditing: new ProviderRegistry(),
    skillEditing: new ProviderRegistry(),
    mcpEditing: new ProviderRegistry(),
    artifactPreviews: new ProviderRegistry(),
    liveDrivers: new LiveDrivers(accountAdmission(accounts), work, floor),
    decoders: new ProviderRegistry(),
    nativeRunners: new ProviderRegistry(),
    acpSources: new ProviderRegistry(),
    profiles,
    processProbes: new ProviderRegistry(),
    mcpSources: new ProviderRegistry(),
    skillSources: new ProviderRegistry(),
    connections: new ProviderRegistry(),
    updateSources,
    usageHistories: new ProviderRegistry(),
    accountCapabilities,
    accounts,
    discovery: new DiscoveryProcesses(),
  }
}
