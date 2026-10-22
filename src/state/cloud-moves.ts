import { toast } from "sonner"
import type { ThreadMoveOutcome, ThreadMoveStep } from "@mako/host/contracts/cloud-threads"
import { getMako, hasBridge } from "@/lib/bridge"
import { updateAcpConversation } from "@/state/acp-state"
import { hydrateLive } from "@/state/live-recovery"
import { createHook, createStore } from "@/state/store"

/**
 * A Thread's move to the cloud, as the window shows it: the step the host is on, by the conversation it was asked
 * from (`thread-move-step`). The host does the move and owns its truth; this only mirrors it, so every window agrees
 * and a window opened mid-move shows the next step as it lands. Once moved, each of the Thread's conversations is
 * read again from its machine, its folder there.
 */
interface CloudMovesState {
  moving: Record<string, { move: string; step: ThreadMoveStep }>
}

export const cloudMovesStore = createStore<CloudMovesState>({ moving: {} })
export const useCloudMoves = createHook(cloudMovesStore)

/** Where a moved conversation's folder is, as the cloud router names a cloud Thread's (`CLOUD_FOLDER_WHERE`). */
const CLOUD_WHERE = "a cloud machine"

/** Asks the host to move the Thread of `conversationId` to the cloud; its steps arrive as events. */
export async function moveToCloud(conversationId: string): Promise<ThreadMoveOutcome | undefined> {
  if (!hasBridge() || cloudMovesStore.get().moving[conversationId]) return undefined
  const move = crypto.randomUUID()
  threadMoveStepped(conversationId, move, { kind: "packing" })
  try {
    return await getMako().threadMove(conversationId, move)
  } catch (error) {
    // The host said nothing it did: the window says what it heard, and shows the Thread as the host lists it.
    const reason = error instanceof Error ? error.message : String(error)
    threadMoveStepped(conversationId, move, { kind: "kept-here", reason })
    return { kind: "kept-here", reason }
  }
}

/** A step of a move, from the host. The last word (moved, kept here) is said once, then the strip goes. */
export function threadMoveStepped(conversationId: string, move: string, step: ThreadMoveStep): void {
  if (step.kind === "moved" || step.kind === "kept-here") {
    cloudMovesStore.set((state) => ({ moving: Object.fromEntries(Object.entries(state.moving).filter(([id]) => id !== conversationId)) }))
    if (step.kind === "moved") {
      toast.success("Moved to the cloud", { id: `move:${move}`, description: "It goes on in a cloud machine, at the same folder. Its changes show here as it works." })
      for (const id of step.conversations) {
        updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: CLOUD_WHERE } : conversation))
        void hydrateLive(id, true)
      }
    } else toast.message("It stayed on this Mac", { id: `move:${move}`, description: step.reason })
    return
  }
  cloudMovesStore.set((state) => ({ moving: { ...state.moving, [conversationId]: { move, step } } }))
}
