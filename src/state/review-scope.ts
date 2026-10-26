import { createHook, createStore } from "@/state/store"
import { stage } from "@/state/stage"

/** One finished turn of a live conversation, as the Changes surface reviews it. */
export interface TurnScope {
  kind: "turn"
  conversation: string
  requestId: string
  /** The words the turn answered, for the scope menu. */
  prompt: string
}

/**
 * A turn the transcript asked Changes to review, with the repository its
 * checkpoints saved. It stands until the person picks another scope there,
 * so the review stays on that turn whatever the panel's layout or a clean
 * working tree would otherwise show.
 */
export interface TurnReviewRequest {
  workspace: string
  turn: TurnScope
}

const reviewScopeStore = createStore<{ requested: TurnReviewRequest | null }>({ requested: null })
export const useReviewScope = createHook(reviewScopeStore)

/** The turn requested for `workspace`, or null: a request for another repository waits for its own. */
export function requestedTurn(requested: TurnReviewRequest | null, workspace: string): TurnScope | null {
  return requested && requested.workspace === workspace ? requested.turn : null
}

/** Opens Changes on what one turn changed. */
export function reviewTurn(workspace: string, turn: Omit<TurnScope, "kind">): void {
  reviewScopeStore.set({ requested: { workspace, turn: { kind: "turn", ...turn } } })
  stage.open("changes")
}

/** The person chose another scope: the transcript's request has been answered. */
export function releaseReviewTurn(): void {
  if (reviewScopeStore.get().requested) reviewScopeStore.set({ requested: null })
}
