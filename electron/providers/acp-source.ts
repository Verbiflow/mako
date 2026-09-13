import type { McpServer, ClientCapabilities, SessionConfigOption } from "@agentclientprotocol/sdk"
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

/**
 * A session the agent opened without the options it would normally offer,
 * and the one config change that makes it build them again.
 */
export interface AcpOptionsRepair {
  /** What the session is missing, worded for the failure the user reads if it stays missing. */
  reason: string
  /** The config change that makes the agent rebuild its option set; absent when none can be named, which fails the start at once. */
  request?: { configId: string; value: string }
}

export interface AcpLaunch {
  command: string
  args: string[]
  configureEnvironment(env: NodeJS.ProcessEnv): void
  prepareMcp?(servers: readonly McpServer[], env: NodeJS.ProcessEnv): Promise<() => Promise<void>>
  permissionTitle?(request: RequestPermissionRequest): string | undefined
}

/** Provider-owned process launch and environment for an interactive ACP agent. */
export interface ProviderAcpSource extends ProviderCapability, Pick<ProviderLiveDriver, "checkpoint" | "resumeVerdict"> {
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
  /**
   * An error the agent wrote into the transcript instead of failing the
   * turn. Some agents catch their own backend errors, append them as the
   * final message chunk and still answer `end_turn`; the provider knows its
   * own wire syntax for that text and lifts it into the request's error so
   * the turn is recorded as what it was. `finalText` is the text streamed
   * after the last tool call or thought of the turn.
   */
  reportedFailure?(finalText: string): string | undefined
  /**
   * An option set the agent reported incomplete, with the change that makes
   * it build the set again. cursor-agent answers `session/new` from a model
   * list it fetches from its backend; when that fetch fails it swallows the
   * error and reports a model select with no choices and no parameter
   * options, so applying the selected effort or context would be refused as
   * "cannot change" although the session is merely unfinished. The host
   * sends the repair a bounded number of times before it fails the start
   * with `reason`. `model` is the selection about to be applied, when any.
   * Returns `undefined` for a complete option set.
   */
  degradedOptions?(options: SessionConfigOption[], model: string | undefined): AcpOptionsRepair | undefined
  available(appPath: string): boolean
  launch(options: AcpLaunchOptions): Promise<AcpLaunch | null>
}
