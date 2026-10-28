import { toast } from "sonner"
import type { MoveCarried, ReturnLanded, ReturnProjectMissing, ThreadMoveOutcome, ThreadMoveStep, ThreadReturnOptions, ThreadReturnOutcome, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
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
  /**
   * `handOff`: a move that pauses the Thread's running turn and continues it in the cloud (asked so, or seen pausing).
   * `ownBranch`: a Thread in the main checkout that went onto its own branch first, so its steps begin with that one.
   */
  moving: Record<string, { move: string; step: ThreadMoveStep; handOff?: boolean; ownBranch?: boolean }>
  /** A Thread coming back from the cloud, by the conversation it was asked from (`thread-return-step`). */
  returning: Record<string, { move: string; step: ThreadReturnStep }>
  /**
   * A way back that stayed because a harness here is older than the one that wrote its sessions in the cloud, by the
   * conversation it was asked from: shown above the composer until the update brings it back, or the person dismisses it.
   */
  outdated: Record<string, { outdated: OutdatedRestore }>
  /**
   * A way back refused before the cloud was asked, because the Thread's project isn't on this Mac, by the conversation
   * it was asked from: shown above the composer, with the host's words, until the person chooses where the project is
   * now or keeps the Thread in the cloud.
   */
  missing: Record<string, { missing: ReturnProjectMissing; reason: string }>
  /**
   * What each Thread's harnesses here and in the cloud mean for moving it either way, by the conversation it was
   * weighed for (`mako:thread-harness-check`): read as its Local or Cloud chip opens, and again after an update.
   */
  harnesses: Record<string, ThreadHarnessCheck>
  /** Harnesses Mako updates before a move or a way back, by the conversation it was asked from (`updateThen`). */
  updating: Record<string, HarnessUpdating>
  /**
   * A Thread in the cloud whose worktree here stopped following it, because the person changed it here
   * (`thread-follow-stopped`), by each of its conversations: said above the composer, with the way to bring it back.
   */
  followStopped: Record<string, { folders: string[]; at: number }>
}

/**
 * One choice that updates the harnesses Mako can update, one after another, then moves the Thread or brings it back:
 * `at`, the harness updating now; `failed`, the one that didn't, and why. The Thread stays where it is meanwhile.
 */
export type HarnessUpdating = { after: "move" | "back"; handOff?: boolean; harnesses: string[]; at: number; failed?: { harness: string; reason: string } }

export const cloudMovesStore = createStore<CloudMovesState>({ moving: {}, returning: {}, outdated: {}, missing: {}, harnesses: {}, updating: {}, followStopped: {} })
export const useCloudMoves = createHook(cloudMovesStore)

/** Where a moved conversation's folder is, as the cloud router names a cloud Thread's (`CLOUD_FOLDER_WHERE`). */
export const CLOUD_WHERE = "a cloud machine"

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
  if (step.kind === "own-branch" && step.to) {
    // Its harness forked onto its own branch: the move's steps are the fork's from here, as the window follows it there.
    const to = step.to
    cloudMovesStore.set((state) => ({ ...state, moving: { ...without(state.moving, conversationId), [to]: { move, step, ownBranch: true } } }))
    return
  }
  if (step.kind === "moved" || step.kind === "kept-here") {
    cloudMovesStore.set((state) => ({ ...state, moving: Object.fromEntries(Object.entries(state.moving).filter(([id]) => id !== conversationId)) }))
    if (step.kind === "moved") {
      const carried = carriedSentence(step.carried)
      if (step.continued) toast.success("Handed off to the cloud", { id: `move:${move}`, description: ["Its turn goes on in a cloud machine, at the same folder, where it left off.", carried].filter(Boolean).join(" ") })
      else toast.success("Moved to the cloud", { id: `move:${move}`, description: ["It goes on in a cloud machine, at the same folder. Its worktree here follows each turn there.", carried].filter(Boolean).join(" ") })
      for (const id of step.conversations) {
        updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: CLOUD_WHERE } : conversation))
        void hydrateLive(id, true)
      }
    } else toast.message("It stayed on this Mac", { id: `move:${move}`, description: step.continued ? `${step.reason} Its turn goes on here.` : step.reason })
    return
  }
  cloudMovesStore.set((state) => {
    const handOff = step.kind === "pausing" || state.moving[conversationId]?.handOff
    const ownBranch = step.kind === "own-branch" || state.moving[conversationId]?.ownBranch
    return { ...state, moving: { ...state.moving, [conversationId]: { move, step, ...handOff && { handOff: true }, ...ownBranch && { ownBranch: true } } } }
  })
}

/** Why a path stayed behind, in a few words. */
const LEFT_WHY = {
  secret: "a secret",
  "too-large": "too large to carry yet",
  elsewhere: "where a cloud machine can't hold it",
  unreadable: "unreadable",
  folder: "inside its own folder",
  "older-cloud": "the cloud's machines don't carry it yet",
} satisfies Record<MoveCarried["left"][number]["why"], string>

/** What a move took besides its worktree, and what stayed, as a sentence or two; nothing when it was only its worktree. */
export function carriedSentence(carried: MoveCarried | undefined): string | undefined {
  if (!carried) return undefined
  const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`
  const went = [
    carried.repositories > 1 ? (carried.repositories === 2 ? "both its repositories" : `all ${carried.repositories} of its repositories`) : undefined,
    carried.outside ? `${files(carried.outside)} from outside its folder` : undefined,
  ].filter(Boolean)
  const parts = went.length ? [`It took ${went.join(" and ")}.`] : []
  const first = carried.left[0]
  if (first) {
    const name = first.path.split("/").at(-1) ?? first.path
    parts.push(carried.left.length === 1 ? `One file stayed here: ${name}, ${LEFT_WHY[first.why]}.` : `${files(carried.left.length)} stayed here, such as ${name}, ${LEFT_WHY[first.why]}.`)
  }
  return parts.length ? parts.join(" ") : undefined
}

/** How a way back landed where it wasn't simply laid down, as a sentence or two; nothing when it was. */
export function landedSentence(landed: ReturnLanded | undefined): string | undefined {
  if (!landed) return undefined
  const files = (count: number) => `${count} ${count === 1 ? "file" : "files"}`
  const name = (path: string) => path.split("/").at(-1) ?? path
  const parts: string[] = []
  const conflicts = new Set(landed.conflicts)
  const clean = landed.merged.filter((path) => !conflicts.has(path))
  if (clean.length) parts.push(`Your edits to ${clean.length === 1 ? name(clean[0] ?? "") : files(clean.length)} stayed.`)
  if (conflicts.size) parts.push(conflicts.size === 1 ? `${name(landed.conflicts[0] ?? "")} has conflict markers: you both changed it. The agent knows.` : `${files(conflicts.size)} have conflict markers: you both changed them. The agent knows.`)
  if (landed.mine) parts.push(`Your commits are on ${landed.mine}.`)
  // The cloud's copies are kept apart, which the toast's action opens.
  if (landed.outside.waiting.length) parts.push(`You changed ${landed.outside.waiting.length === 1 ? name(landed.outside.waiting[0] ?? "") : `${files(landed.outside.waiting.length)} outside its worktree`} meanwhile, so yours stayed.`)
  else if (landed.outside.placed.length) parts.push(`${files(landed.outside.placed.length)} outside its worktree came back to ${landed.outside.placed.length === 1 ? "its place" : "their places"}.`)
  return parts.length ? parts.join(" ") : undefined
}

/** The person keeps the Thread in the cloud with their changes here: its notice goes; its Cloud chip still brings it back. */
export function dismissFollowStopped(conversationId: string): void {
  cloudMovesStore.set((state) => ({ ...state, followStopped: without(state.followStopped, conversationId) }))
}

/** A Thread in the cloud whose worktree here stopped following it: the person changed it here. */
export function followStopped(event: { conversations: string[]; folders: string[]; at: number }): void {
  cloudMovesStore.set((state) => ({ ...state, followStopped: { ...state.followStopped, ...Object.fromEntries(event.conversations.map((id) => [id, { folders: event.folders, at: event.at }])) } }))
}

/**
 * Asks the host to bring the Thread of `conversationId` back from the cloud; its steps arrive as events. `options.project`:
 * the folder its project is in now, when the one it was made from moved.
 */
export async function bringBack(conversationId: string, options?: ThreadReturnOptions): Promise<ThreadReturnOutcome | undefined> {
  if (!hasBridge() || cloudMovesStore.get().returning[conversationId]) return undefined
  return askReturn(conversationId, crypto.randomUUID(), options)
}

/** The host asked for a return, new or one it left unsettled: the window shows it packing until the host says more. */
async function askReturn(conversationId: string, move: string, options?: ThreadReturnOptions): Promise<ThreadReturnOutcome> {
  threadReturnStepped(conversationId, move, { kind: "packing" })
  try {
    return await getMako().threadReturn(conversationId, move, options)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    threadReturnStepped(conversationId, move, { kind: "stayed", reason })
    return { kind: "stayed", reason }
  }
}

/**
 * The person asks again about a return the host left unsettled: the same return, under its own id, goes on from where
 * its plan stands, and settles, or says again who it waits on.
 */
export async function askReturnAgain(conversationId: string): Promise<ThreadReturnOutcome | undefined> {
  const entry = cloudMovesStore.get().returning[conversationId]
  if (!hasBridge() || entry?.step.kind !== "unsettled") return undefined
  return askReturn(conversationId, entry.move)
}

/**
 * A Thread whose project isn't on this Mac anymore, brought back into the folder the person chooses as its project's
 * now: the host checks it's a clone of the same repository, tells the worktree where it is, and brings the Thread back.
 */
export async function bringBackFromChosenProject(conversationId: string): Promise<void> {
  if (!hasBridge()) return
  const project = await getMako().pickFolder()
  if (!project) return
  dismissMissingProject(conversationId)
  await bringBack(conversationId, { project })
}

/** The person keeps the Thread in the cloud: its notice goes, and its Cloud chip still brings it back. */
export function dismissMissingProject(conversationId: string): void {
  cloudMovesStore.set((state) => ({ ...state, missing: without(state.missing, conversationId) }))
}

/** A step of a return, from the host. Back or stayed is said once, then the strip goes; unsettled stays shown. */
export function threadReturnStepped(conversationId: string, move: string, step: ThreadReturnStep): void {
  if (step.kind === "back" || step.kind === "stayed") {
    cloudMovesStore.set((state) => ({ ...state, returning: Object.fromEntries(Object.entries(state.returning).filter(([id]) => id !== conversationId)) }))
    if (step.kind === "back") {
      const landed = landedSentence(step.landed)
      const conflicted = Boolean(step.landed?.conflicts.length)
      // Conflicts to resolve read as a caution, and anything merged stays long enough to read.
      const say = conflicted ? toast.warning : toast.success
      // The cloud's copies of files outside its worktree that the person changed meanwhile: one opens, several show.
      const waiting = step.landed?.outside.waiting ?? []
      const kept = step.landed?.outside.kept
      const compare = kept && waiting.length ? { label: waiting.length === 1 ? "Open the cloud's copy" : "Show the cloud's copies", onClick: () => void getMako().revealPath(waiting.length === 1 ? `${kept}${waiting[0]}` : kept).catch(() => undefined) } : undefined
      say("Back on this Mac", { id: `return:${move}`, description: landed ?? "It goes on here, with what it did in the cloud in its worktree. The cloud machine is gone.", ...landed && { duration: 12_000 }, ...compare && { action: compare } })
      cloudMovesStore.set((state) => ({ ...state, followStopped: Object.fromEntries(Object.entries(state.followStopped).filter(([id]) => !step.conversations.includes(id))) }))
      for (const id of step.conversations) {
        updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: undefined } : conversation))
        void hydrateLive(id, true)
      }
    } else if (step.missing) {
      // Said above the composer, where choosing the project's folder is, not in a toast that goes.
      const entry = { missing: step.missing, reason: step.reason }
      cloudMovesStore.set((state) => ({ ...state, missing: { ...state.missing, [conversationId]: entry } }))
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
