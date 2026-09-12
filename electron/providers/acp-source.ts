import type { McpServer, ClientCapabilities } from "@agentclientprotocol/sdk"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderCapability } from "./registry.js"
import type { ProviderLiveDriver } from "./live-driver.js"
import type { RequestPermissionRequest, NewSessionRequest } from "@agentclientprotocol/sdk"
import type { AccessTier } from "../contracts/access.js"
import type { AcpAccessPolicy } from "../acp-access.js"

export type AcpTuning = SessionSettings

export interface AcpNativeMode {
  id: string
  name: string
  description?: string
}

export interface AcpLaunchOptions {
  appPath: string
  execPath: string
  resume?: string
  tuning?: AcpTuning
  /** The access tier selected before launch, for providers that read it from flags or environment. */
  access?: AccessTier
}

export interface AcpLaunch {
  command: string
  args: string[]
  configureEnvironment(env: NodeJS.ProcessEnv): void
  prepareMcp?(servers: readonly McpServer[], env: NodeJS.ProcessEnv): Promise<() => Promise<void>>
  permissionTitle?(request: RequestPermissionRequest): string | undefined
}

/** Provider-owned process launch and environment for an interactive ACP agent. */
export interface ProviderAcpSource extends ProviderCapability, Pick<ProviderLiveDriver, "checkpoint" | "canResumeBinding"> {
  clientCapabilities?: Pick<ClientCapabilities, "_meta">
  canResume: boolean
  /**
   * How a second `session/prompt` during a running turn behaves, verified
   * against the real agent. `concurrent-prompt` folds it into the running
   * turn; `interrupting-prompt` cancels the current step and continues with
   * the message. An agent that queues it behind the turn declares nothing.
   */
  steering?: "concurrent-prompt" | "interrupting-prompt"
  access?: AcpAccessPolicy
  /**
   * The session modes the installed agent advertises, recorded from a real
   * `session/new` so the ladder can be offered before a session exists. The
   * ids must match what the agent sends; a saved choice is validated against
   * the live list when the session starts.
   */
  nativeModes?: readonly AcpNativeMode[]
  launchOptionIds?: readonly string[]
  sessionMetadata?(tuning: SessionSettings): NewSessionRequest["_meta"]
  available(appPath: string): boolean
  launch(options: AcpLaunchOptions): Promise<AcpLaunch | null>
}
