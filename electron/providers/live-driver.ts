import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderBinding } from "../contracts/conversation-control.js"
import type {
  LivePermissionResponse,
  PromptAttachment,
  LiveSessionState,
  LiveSessionMode,
  LiveDriverEvent,
  LiveSteering,
  McpRegistrySnapshot,
} from "../shared.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { ProviderCapability } from "./registry.js"
import type { ControlCredentials } from "../control-service.js"

export interface ConversationTools {
  url: string
  token: string
  control?: ControlCredentials
}

/** Host-only launch credentials. Never included in the renderer wire contract or journals. */
export interface ProviderStartOptions extends LiveStartOptions {
  emit?: (event: LiveDriverEvent) => void
  mcpSnapshot?: () => Promise<McpRegistrySnapshot>
  fork?: { nativeId: string; runId: string }
  conversationTools?: ConversationTools
}

export interface ProviderLiveDriver extends ProviderCapability {
  observesNativeAgents?: true
  steer?(id: string, input: ProviderSteerInput): Promise<ProviderSteerResult>
  /** Required with `steer`; says what the provider does with the message. */
  steering?: LiveSteering
  /** The modes a fresh session will offer, declared without starting one. */
  modes?: readonly LiveSessionMode[]
  compact?(id: string): Promise<void>
  forkPoint?: "run" | "checkpoint"
  canResume: boolean
  checkpoint?(path: string): Promise<string | undefined>
  canResumeBinding?(binding: ProviderBinding): Promise<boolean>
  available(appPath: string): boolean
  start(cwd: string, options: ProviderStartOptions): Promise<LiveSessionState>
  prompt(
    id: string,
    text: string,
    attachments: PromptAttachment[],
    settings?: SessionSettings
  ): Promise<void>
  permission(
    id: string,
    requestId: string,
    response: LivePermissionResponse
  ): Promise<void>
  cancel(id: string): Promise<void>
  close(id: string): void | Promise<void>
  setMode(id: string, modeId: string): Promise<void>
}

export interface ProviderSteerInput {
  id: string
  expectedRunId: string
  text: string
  attachments: PromptAttachment[]
}

/** A thrown transport error means delivery is unknown, never permission to resend. */
export type ProviderSteerResult =
  { kind: "accepted" } | { kind: "not-accepted"; reason: string }
