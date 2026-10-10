import type { SessionSettings } from "@mako/sessions/settings"
import type { ForkInput } from "@mako/host/contracts/conversation-control"
import type { LiveRequest, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import type { LiveSessionState, PromptAttachment } from "@mako/host/contracts/providers-acp"
import type { Actor } from "@mako/host/contracts/thread-identity"

/**
 * Whether a conversation can go on in another folder under its own native
 * session: `now`; `wait`, for something in it that ends by itself or by the
 * person; or `never`, so moving it means a fork. `reason` reads after its title.
 */
export type Relocation = { kind: "now" } | { kind: "wait" | "never"; reason: string }

/** What worktrees, moves and app tools read and ask of the conversations live on this host. */
export interface WorkspaceConversations {
  session(id: string): LiveSessionState | undefined
  summaries(): LiveSummary[]
  /** Whether the conversation is read in, so asking it costs nothing. */
  loaded(id: string): boolean
  snapshot(id: string): LiveSnapshot | null
  relocation(id: string): Relocation
  relocationWithin(id: string, ms: number): Promise<Relocation>
  /** Moves it to `cwd` under its own session; undefined when it couldn't. */
  relocate(id: string, cwd: string): Promise<string | undefined>
  /** Resumes its native session in the folder it moved to; when it doesn't, why, with it back in `from`. */
  resumeMoved(id: string, from: string): Promise<string | undefined>
  fork(id: string, input: ForkInput, cwd?: string): LiveSnapshot
  submit(
    id: string,
    requestId: string,
    text: string,
    attachments?: PromptAttachment[],
    tuning?: SessionSettings,
    targetBindingId?: string,
    displayText?: string,
    actor?: Actor
  ): LiveRequest
}
