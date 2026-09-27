import { createContext, useContext } from "react"
import type { ThreadRef } from "@/lib/types"
import { activeAcp, type AcpConversation, type AcpState, type LiveAcpConversation } from "@/state/acp-state"
import type { ViewedThread } from "@/state/thread-state"

/**
 * The Session a workbench pane shows while another pane has focus. Its
 * transcript reads this instead of the window's active conversation, so both
 * panes stream at once and moving focus remounts nothing.
 */
export type ConversationScope =
  | { kind: "live"; key: string }
  | { kind: "history"; ref: ThreadRef; thread: ViewedThread | null }
  | { kind: "draft"; title?: string }
  | { kind: "missing" }

export const ConversationScopeContext = createContext<ConversationScope | null>(null)

/** Null in the focused pane: it shows the active conversation. */
export function useConversationScope(): ConversationScope | null {
  return useContext(ConversationScopeContext)
}

export function scopedAcp(state: AcpState, scope: ConversationScope | null): AcpConversation | null {
  if (!scope) return activeAcp(state)
  return scope.kind === "live" ? (state.conversations[scope.key] ?? null) : null
}

export function scopedLiveAcp(state: AcpState, scope: ConversationScope | null): LiveAcpConversation | null {
  const conversation = scopedAcp(state, scope)
  return conversation?.kind === "live" ? conversation : null
}
