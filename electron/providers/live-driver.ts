import type { PromptDispatch } from "./prompt-dispatch.js"
import type { NativeAgentObservation } from "../contracts/native-agents.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ProviderBinding, ResumeVerdict } from "../contracts/conversation-control.js"
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
import { UNAVAILABLE_RECOVERY, type RecoveryCapabilities } from "../contracts/recovery.js"

/** Admission resolves separately from the correlated live-action-result event.
 * A provider must confirm completion, failure, or cancellation; idle is not proof.
 * An exception means delivery is unknown and must never cause an automatic replay.
 */
export type ProviderCompaction =
  | { kind: "supported"; start(id: string, actionId: string): Promise<void> }
  | { kind: "unavailable"; reason: string }

export function recoveryCapabilities(driver: ProviderLiveDriver | undefined): RecoveryCapabilities {
  const compaction = driver?.compaction
  return compaction?.kind === "supported"
    ? { compaction: { kind: "supported" } }
    : compaction ? { compaction } : UNAVAILABLE_RECOVERY
}

export interface ConversationTools {
  url: string
  token: string
  control?: ControlCredentials
}

/** Host-only launch credentials. Never included in the renderer wire contract or journals. */
export interface ProviderStartOptions extends LiveStartOptions {
  /** Prior child identities for this exact resumed binding; states require fresh evidence. */
  observedAgents?: NativeAgentObservation[]
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
  /** The mode a fresh session runs under when nothing was chosen — the level the chip reports before launch. */
  defaultMode?: string
  compaction?: ProviderCompaction
  forkPoint?: "run" | "checkpoint"
  canResume: boolean
  checkpoint?(path: string): Promise<string | undefined>
  /** Ownership and record state of a saved binding; absent, the host's generic probe-and-hash check answers. */
  resumeVerdict?(binding: ProviderBinding): Promise<ResumeVerdict>
  available(appPath: string): boolean
  start(cwd: string, options: ProviderStartOptions): Promise<LiveSessionState>
  /** Resolving this call is not a receipt. Report native evidence through the attempt-scoped dispatch. */
  prompt(
    id: string,
    text: string,
    attachments: PromptAttachment[],
    settings: SessionSettings | undefined,
    dispatch: PromptDispatch
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

/**
 * What the interface cannot type: the invariants a driver must keep. The
 * registry runs this at install, so a driver that contradicts itself fails
 * at startup rather than at a call site months later.
 */
export function validateLiveDriver(driver: ProviderLiveDriver): void {
  if (Boolean(driver.steer) !== Boolean(driver.steering))
    throw new Error(`${driver.provider}: steer and steering are declared together or not at all`)
  for (const mode of driver.modes ?? [])
    if (mode.access && !mode.enforcement)
      throw new Error(`${driver.provider}: mode ${mode.id} names a tier with no enforcer`)
  if (driver.defaultMode && !driver.modes?.some((mode) => mode.id === driver.defaultMode))
    throw new Error(`${driver.provider}: defaultMode ${driver.defaultMode} is not one of its declared modes`)
}
