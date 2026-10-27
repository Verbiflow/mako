import { toast } from "sonner"
import type { ThreadMoveOutcome, ThreadMoveStep, ThreadReturnOutcome, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import type { OutdatedRestore } from "@mako/host/contracts/restore-plan"
import type { ThreadHarnessCheck } from "@mako/host/contracts/cloud-harnesses"
import { providers } from "@/state/providers"
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
  /** `handOff`: a move that pauses the Thread's running turn and continues it in the cloud (asked so, or seen pausing). */
  moving: Record<string, { move: string; step: ThreadMoveStep; handOff?: boolean }>
  /** A Thread coming back from the cloud, by the conversation it was asked from (`thread-return-step`). */
  returning: Record<string, { move: string; step: ThreadReturnStep }>
  /**
   * A way back that stayed because a harness here is older than the one that wrote its sessions in the cloud, by the
   * conversation it was asked from: shown above the composer until the update brings it back, or the person dismisses it.
   */
  outdated: Record<string, { outdated: OutdatedRestore }>
  /**
   * What each Thread's harnesses here and in the cloud mean for moving it either way, by the conversation it was
   * weighed for (`mako:thread-harness-check`): read as its Local or Cloud chip opens, and again after an update.
   */
  harnesses: Record<string, ThreadHarnessCheck>
  /** Harnesses Mako updates before a move or a way back, by the conversation it was asked from (`updateThen`). */
  updating: Record<string, HarnessUpdating>
}

/**
 * One choice that updates the harnesses Mako can update, one after another, then moves the Thread or brings it back:
 * `at`, the harness updating now; `failed`, the one that didn't, and why. The Thread stays where it is meanwhile.
 */
export type HarnessUpdating = { after: "move" | "back"; handOff?: boolean; harnesses: string[]; at: number; failed?: { harness: string; reason: string } }

export const cloudMovesStore = createStore<CloudMovesState>({ moving: {}, returning: {}, outdated: {}, harnesses: {}, updating: {} })
export const useCloudMoves = createHook(cloudMovesStore)

/** Where a moved conversation's folder is, as the cloud router names a cloud Thread's (`CLOUD_FOLDER_WHERE`). */
const CLOUD_WHERE = "a cloud machine"

/**
 * Asks the host to move the Thread of `conversationId` to the cloud; its steps arrive as events. `handOff`: its agents
 * are working, so their turns are paused and go along, continuing in the cloud.
 */
export async function moveToCloud(conversationId: string, handOff = false): Promise<ThreadMoveOutcome | undefined> {
  if (!hasBridge() || cloudMovesStore.get().moving[conversationId]) return undefined
  const move = crypto.randomUUID()
  if (handOff) cloudMovesStore.set((state) => ({ ...state, moving: { ...state.moving, [conversationId]: { move, step: { kind: "packing" }, handOff: true } } }))
  else threadMoveStepped(conversationId, move, { kind: "packing" })
  try {
    return await getMako().threadMove(conversationId, move, handOff ? { why: "asked" } : undefined)
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
    cloudMovesStore.set((state) => ({ ...state, moving: Object.fromEntries(Object.entries(state.moving).filter(([id]) => id !== conversationId)) }))
    if (step.kind === "moved") {
      if (step.continued) toast.success("Handed off to the cloud", { id: `move:${move}`, description: "Its turn goes on in a cloud machine, at the same folder, where it left off." })
      else toast.success("Moved to the cloud", { id: `move:${move}`, description: "It goes on in a cloud machine, at the same folder. Its changes show here as it works." })
      for (const id of step.conversations) {
        updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: CLOUD_WHERE } : conversation))
        void hydrateLive(id, true)
      }
    } else toast.message("It stayed on this Mac", { id: `move:${move}`, description: step.continued ? `${step.reason} Its turn goes on here.` : step.reason })
    return
  }
  cloudMovesStore.set((state) => {
    const handOff = step.kind === "pausing" || state.moving[conversationId]?.handOff
    return { ...state, moving: { ...state.moving, [conversationId]: { move, step, ...handOff && { handOff: true } } } }
  })
}

/** Asks the host to bring the Thread of `conversationId` back from the cloud; its steps arrive as events. */
export async function bringBack(conversationId: string): Promise<ThreadReturnOutcome | undefined> {
  if (!hasBridge() || cloudMovesStore.get().returning[conversationId]) return undefined
  const move = crypto.randomUUID()
  threadReturnStepped(conversationId, move, { kind: "packing" })
  try {
    return await getMako().threadReturn(conversationId, move)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    threadReturnStepped(conversationId, move, { kind: "stayed", reason })
    return { kind: "stayed", reason }
  }
}

/** A step of a return, from the host. Back or stayed is said once, then the strip goes; unsettled stays shown. */
export function threadReturnStepped(conversationId: string, move: string, step: ThreadReturnStep): void {
  if (step.kind === "back" || step.kind === "stayed") {
    cloudMovesStore.set((state) => ({ ...state, returning: Object.fromEntries(Object.entries(state.returning).filter(([id]) => id !== conversationId)) }))
    if (step.kind === "back") {
      toast.success("Back on this Mac", { id: `return:${move}`, description: "It goes on here, with what it did in the cloud in its worktree. The cloud machine is gone." })
      for (const id of step.conversations) {
        updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: undefined } : conversation))
        void hydrateLive(id, true)
      }
    } else if (step.outdated) {
      // Said above the composer, where its Update is, not in a toast that goes; weighed again for every harness it needs.
      const outdated = step.outdated
      cloudMovesStore.set((state) => ({ ...state, outdated: { ...state.outdated, [conversationId]: { outdated } } }))
      void checkHarnesses(conversationId)
    } else toast.message("It stayed in the cloud", { id: `return:${move}`, description: step.reason })
    return
  }
  cloudMovesStore.set((state) => ({ ...state, returning: { ...state.returning, [conversationId]: { move, step } } }))
}

/** Without one key: what the window keeps by conversation, put away. */
function without<Value>(record: Record<string, Value>, key: string): Record<string, Value> {
  return Object.fromEntries(Object.entries(record).filter(([id]) => id !== key))
}

/**
 * Weighs the Thread of `conversationId`'s harnesses against the cloud's again (`mako:thread-harness-check`), and keeps
 * what the host said for the window. Nothing is kept for a Thread that couldn't move at all: its chip says why. The
 * host takes its harnesses' installed readings again first, so one the person just updated, in Mako or elsewhere (another
 * app's install, a command), is weighed as it is now: this is also "Check again", and what the window does as they come back to it.
 */
export async function checkHarnesses(conversationId: string): Promise<ThreadHarnessCheck | undefined> {
  if (!hasBridge()) return undefined
  const check = await getMako().threadHarnessCheck(conversationId).catch(() => undefined)
  cloudMovesStore.set((state) => ({ ...state, harnesses: check ? { ...state.harnesses, [conversationId]: check } : without(state.harnesses, conversationId) }))
  return check
}

/**
 * One choice for the person: updates every harness here older than the cloud's that Mako can update, one after
 * another, then moves the Thread (`after: "move"`) or brings it back (`"back"`). An update that fails, or that leaves a
 * harness still older than the cloud's, stops there and says why; the Thread stays where it is, and nothing moves.
 * A way back the cloud refused updates the harness the refusal named too.
 */
export async function updateThen(conversationId: string, after: "move" | "back", handOff = false): Promise<void> {
  const running = cloudMovesStore.get().updating[conversationId]
  if (running && !running.failed) return
  const check = await checkHarnesses(conversationId)
  const runtimes = new Map<string, string>()
  if (check?.kind === "known") for (const behind of check.behind) if (behind.offer.kind === "update") runtimes.set(behind.harness, behind.offer.runtimeId)
  // The version a refused way back named is the one its records need, whatever the cloud says it runs now.
  const refused = after === "back" ? cloudMovesStore.get().outdated[conversationId]?.outdated : undefined
  if (refused?.offer.kind === "update" && !runtimes.has(refused.harness)) runtimes.set(refused.harness, refused.offer.runtimeId)
  const harnesses = [...runtimes.keys()]
  const set = (next: HarnessUpdating | undefined) => cloudMovesStore.set((state) => ({ ...state, updating: next ? { ...state.updating, [conversationId]: next } : without(state.updating, conversationId) }))
  const base = { after, harnesses, ...handOff && { handOff } }
  for (const [at, harness] of harnesses.entries()) {
    set({ ...base, at })
    try {
      const info = await providers.runRuntimeUpdate(runtimes.get(harness) ?? harness)
      const outcome = info.result?.outcome
      if (outcome !== "updated" && outcome !== "installed" && outcome !== "unchanged") {
        set({ ...base, at, failed: { harness, reason: info.result?.message ?? "The update didn't finish." } })
        return
      }
    } catch (error) {
      set({ ...base, at, failed: { harness, reason: error instanceof Error ? error.message : String(error) } })
      return
    }
  }
  // Weighed again: an update that didn't reach the cloud's version says so, rather than moving a Thread that couldn't come back.
  const updated = harnesses.length ? await checkHarnesses(conversationId) : check
  const short = updated?.kind === "known" ? updated.behind.find((behind) => runtimes.has(behind.harness)) : undefined
  if (short) {
    set({ ...base, at: harnesses.indexOf(short.harness), failed: { harness: short.harness, reason: `It's ${short.here} after the update, still older than the cloud's ${short.cloud}.` } })
    return
  }
  set(undefined)
  if (after === "move") {
    await moveToCloud(conversationId, handOff)
    return
  }
  dismissOutdatedReturn(conversationId)
  await bringBack(conversationId)
}

/** The person put a failed update away: the Thread stays where it is. */
export function dismissHarnessUpdate(conversationId: string): void {
  cloudMovesStore.set((state) => ({ ...state, updating: without(state.updating, conversationId) }))
}

/**
 * Updates the harness a way back was too old for, then brings the Thread back: one choice for the person (`updateThen`).
 * An update that fails says why and leaves the Thread in the cloud, where it goes on.
 */
export async function updateAndBringBack(conversationId: string): Promise<void> {
  await updateThen(conversationId, "back")
}

/** The person put the notice away; the Thread stays in the cloud, and its Cloud chip still brings it back. */
export function dismissOutdatedReturn(conversationId: string): void {
  cloudMovesStore.set((state) => ({ ...state, outdated: without(state.outdated, conversationId) }))
}
