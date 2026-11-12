import { toast } from "sonner"
import type { MoveCarried, ReturnLanded, ReturnProjectMissing, ThreadMoveOutcome, ThreadMoveStep, ThreadReturnOptions, ThreadReturnOutcome, ThreadReturnStep } from "@mako/host/contracts/cloud-threads"
import type { OutdatedRestore } from "@mako/host/contracts/restore-plan"
import type { ThreadHarnessCheck } from "@mako/host/contracts/cloud-harnesses"
import { providers } from "@/state/providers"
import { getMako, hasBridge } from "@/lib/bridge"
import { acpStore, updateAcpConversation } from "@/state/acp-state"
import { receiveLive } from "@/state/live-door"
import { hydrateLive } from "@/state/live-recovery"
import { createHook, createStore } from "@/state/store"

/** Both directions share observation order and effect ownership; only a confirmed return establishes local authority. */
type CloudOperation = { origin: string; target: string; ignored?: true; superseded?: true; located?: string[]; refreshed?: string[] } & (
  | { direction: "outbound"; settled?: "moved" | "kept-here"; completed?: Extract<ThreadMoveStep, { kind: "moved" }> }
  | { direction: "return"; settled?: "back" | "stayed"; returned?: Extract<ThreadReturnStep, { kind: "back" }> }
)

/**
 * A Thread's move to the cloud, as the window shows it: the step the host is on, by the conversation it was asked
 * from (`thread-move-step`). The host does the move and owns its truth; this only mirrors it, so every window agrees
 * and a window opened mid-move shows the next step as it lands. Once moved, each of the Thread's conversations is
 * read again from its machine, its folder there.
 */
interface CloudMovesState {
  /** In arrival order, retained for this window's lifetime without a count/TTL cap: evicting old IDs would reopen stale-event adoption. */
  moves: Record<string, CloudOperation>
  /**
   * `handOff`: a move that pauses the Thread's running turn and continues it in the cloud (asked so, or seen pausing).
   * `ownBranch`: a Thread in the main checkout that went onto its own branch first, so its steps begin with that one.
   */
  moving: Record<string, { move: string; step: ThreadMoveStep; handOff?: boolean; ownBranch?: boolean; checking?: boolean }>
  /** Conversations whose Thread waits to hear from the account since this Mac went away (`away-held`): it runs nowhere here. */
  awayHeld: Record<string, true>
  /** A Thread the cloud took while this Mac was away, whose own files stayed in the project folder (`checkout-stayed`). */
  checkoutStayed: Record<string, { paths: string[]; unpushed: number }>
  /** Confirmed refusals stay with the conversation until dismissed or another move starts. */
  failedMoves: Record<string, { move: string; reason: string; handOff: boolean; continued: boolean }>
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

export const cloudMovesStore = createStore<CloudMovesState>({ moves: {}, moving: {}, awayHeld: {}, checkoutStayed: {}, failedMoves: {}, returning: {}, outdated: {}, missing: {}, harnesses: {}, updating: {}, followStopped: {} })
export const useCloudMoves = createHook(cloudMovesStore)

/** Where a moved conversation's folder is, as the cloud router names a cloud Thread's (`CLOUD_FOLDER_WHERE`). */
export const CLOUD_WHERE = "a cloud machine"

/**
 * Asks the host to move the Thread of `conversationId` to the cloud; its steps arrive as events. `handOff`: its agents
 * are working, so their turns are paused and go along, continuing in the cloud.
 */
export async function moveToCloud(conversationId: string, handOff = false): Promise<ThreadMoveOutcome | undefined> {
  if (!hasBridge() || moveInFlight(cloudMovesStore.get(), conversationId)) return undefined
  const move = crypto.randomUUID()
  cloudMovesStore.set((state) => ({
    ...state,
    moves: { ...state.moves, [move]: { direction: "outbound", origin: conversationId, target: conversationId } },
    moving: { ...state.moving, [conversationId]: { move, step: { kind: "packing" }, ...handOff && { handOff: true } } },
    failedMoves: without(state.failedMoves, conversationId),
  }))
  return askMove(conversationId, move, handOff)
}

/** A deliberate retry is a new move, retaining whether the failed attempt carried a running turn. */
export async function retryFailedMove(conversationId: string, move: string): Promise<ThreadMoveOutcome | undefined> {
  const failed = cloudMovesStore.get().failedMoves[conversationId]
  if (failed?.move !== move) return undefined
  return moveToCloud(conversationId, failed.handOff)
}

/** Dismissing an old notice cannot dismiss the failure of a newer attempt. */
export function dismissFailedMove(conversationId: string, move: string): void {
  cloudMovesStore.set((state) => state.failedMoves[conversationId]?.move === move ? { ...state, failedMoves: without(state.failedMoves, conversationId) } : state)
}

/** A lost answer is checked under the same move ID; it never starts a second move. */
export async function checkMoveAgain(conversationId: string): Promise<ThreadMoveOutcome | undefined> {
  const held = cloudMovesStore.get().moving[conversationId]
  const owner = held && currentMove(held.move)
  if (!hasBridge() || held?.step.kind !== "unsettled" || held.checking || owner?.target !== conversationId) return undefined
  cloudMovesStore.set((state) => ({ ...state, moving: { ...state.moving, [conversationId]: { ...held, checking: true } } }))
  try {
    return await askMove(owner.origin, held.move, held.handOff === true)
  } finally {
    cloudMovesStore.set((state) => {
      const target = state.moves[held.move]?.target
      const current = target && state.moving[target]
      return current && current.move === held.move ? { ...state, moving: { ...state.moving, [target]: { ...current, checking: false } } } : state
    })
  }
}

/** Only the owner's answer establishes a refusal. A transport error leaves the location unconfirmed. */
async function askMove(conversationId: string, move: string, handOff: boolean): Promise<ThreadMoveOutcome> {
  try {
    const outcome = await getMako().threadMove(conversationId, move, handOff ? { why: "asked" } : undefined)
    // Early refusals need not have emitted a step. A late reply must not replace a newer attempt.
    let owner = currentMove(move)
    if (owner?.origin === conversationId) {
      if (outcome.kind === "moved") {
        // A stored started plan answers without another event. Its optional conversation names a missed fork.
        if (outcome.conversation && outcome.conversation !== owner.target) {
          threadMoveStepped(owner.target, move, { kind: "own-branch", to: outcome.conversation })
          owner = currentMove(move)
        }
        if (owner && (!outcome.conversation || outcome.conversation === owner.target))
          completeMove(owner.target, move, { kind: "moved", conversations: [owner.target] }, knownMoveMembers(owner.target))
      } else if (outcome.kind === "kept-here" || outcome.kind === "unsettled") threadMoveStepped(owner.target, move, outcome)
    }
    return outcome
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const owner = currentMove(move)
    if (owner?.origin === conversationId) threadMoveStepped(owner.target, move, { kind: "unsettled", reason })
    return { kind: "unsettled", reason }
  }
}

/** Both addresses of an unresolved move are occupied; a fork cannot create another operation via its old tab. */
function moveInFlight(state: CloudMovesState, conversationId: string): boolean {
  return Boolean(state.moving[conversationId] || state.returning[conversationId]) || Object.entries(state.moves).some(([move, owner]) => !owner.ignored && !owner.superseded && !owner.settled && (owner.origin === conversationId || owner.target === conversationId) && (owner.direction === "return" || (latestOperation(state, owner.origin) === move && latestOperation(state, owner.target) === move)))
}

/** A reply can update only the operation still displayed at its current target, never a disposed or settled one. */
function currentMove(move: string): Extract<CloudOperation, { direction: "outbound" }> | undefined {
  const state = cloudMovesStore.get()
  const owner = state.moves[move]
  return owner?.direction === "outbound" && !owner.ignored && !owner.superseded && !owner.settled && state.moving[owner.target]?.move === move && latestOperation(state, owner.origin) === move && latestOperation(state, owner.target) === move ? owner : undefined
}

/** The latest observed operation to own or refresh an address. Move IDs are UUIDs, so record order is arrival order. */
function latestOperation(state: CloudMovesState, conversationId: string): string | undefined {
  return Object.entries(state.moves).findLast(([, owner]) => !owner.ignored && !owner.superseded && (owner.direction === "outbound" || owner.settled === "back") && (owner.origin === conversationId || owner.target === conversationId || (owner.direction === "outbound" ? owner.completed : owner.returned)?.conversations.includes(conversationId) || owner.refreshed?.includes(conversationId)))?.[0]
}

/** Retirement removes only these operations' displays/locks, retaining their IDs without claiming any location. */
function retireOperations(state: CloudMovesState, moves: string[]): CloudMovesState {
  const retired = new Set(moves)
  return {
    ...state,
    moves: Object.fromEntries(Object.entries(state.moves).map(([id, owner]) => [id, retired.has(id) ? { ...owner, superseded: true as const } : owner])),
    moving: Object.fromEntries(Object.entries(state.moving).filter(([, held]) => !retired.has(held.move))),
    returning: Object.fromEntries(Object.entries(state.returning).filter(([, held]) => !retired.has(held.move))),
  }
}

/** Confirmed newer ownership also ends obsolete pending UI work, in either direction, including newly learned members. */
function retireSuperseded(state: CloudMovesState, confirmed: string): CloudMovesState {
  const ids = Object.keys(state.moves)
  const older = ids.slice(0, ids.indexOf(confirmed))
  return retireOperations(state, older.filter((id) => {
    const owner = state.moves[id]
    return owner && !owner.ignored && !owner.superseded && !owner.settled && (latestOperation(state, owner.origin) === confirmed || latestOperation(state, owner.target) === confirmed)
  }))
}

/** An incompatible unseen ID has no authority, but remembering its rejection prevents later replay from adopting it. */
function ignoreOperation(state: CloudMovesState, move: string, conversationId: string, direction: CloudOperation["direction"]): void {
  cloudMovesStore.set({ moves: { ...state.moves, [move]: { direction, origin: conversationId, target: conversationId, ignored: true } } })
}

/** The RPC has no member list. These host-derived Thread IDs select readbacks, not synthetic moved membership. */
function knownMoveMembers(target: string): string[] {
  const { conversations } = acpStore.get()
  const thread = conversations[target]?.threadId
  return [...new Set([target, ...thread ? Object.values(conversations).filter((conversation) => conversation.kind === "live" && conversation.threadId === thread).map((conversation) => conversation.key) : []])]
}

/** A step from the host. A confirmed failure keeps its reason and recovery action above the composer. */
export function threadMoveStepped(conversationId: string, move: string, step: ThreadMoveStep): void {
  const state = cloudMovesStore.get()
  if (step.kind === "own-branch" && step.to && step.to !== conversationId && moveInFlight(state, step.to)) {
    if (!state.moves[move]) ignoreOperation(state, move, conversationId, "outbound")
    return
  }
  const known = state.moves[move]
  if (known) {
    if (known.ignored || known.superseded || known.direction !== "outbound" || (currentMove(move)?.target !== conversationId && !(step.kind === "moved" && known.settled === "moved" && known.target === conversationId && latestOperation(state, known.origin) === move && latestOperation(state, conversationId) === move))) return
  } else {
    // A move begun in another window first arrives as an event. It cannot displace one already owned here.
    if (moveInFlight(state, conversationId)) {
      ignoreOperation(state, move, conversationId, "outbound")
      return
    }
    cloudMovesStore.set({ moves: { ...state.moves, [move]: { direction: "outbound", origin: conversationId, target: conversationId } } })
  }
  if (step.kind === "own-branch" && step.to) {
    // Its harness forked onto its own branch: the move's steps are the fork's from here, as the window follows it there.
    const to = step.to
    cloudMovesStore.set((state) => ({
      ...state,
      moves: { ...state.moves, [move]: { direction: "outbound", origin: state.moves[move]?.origin ?? conversationId, target: to } },
      failedMoves: without(without(state.failedMoves, conversationId), to),
      moving: { ...without(state.moving, conversationId), [to]: { ...state.moving[conversationId], move, step, ownBranch: true } },
    }))
    return
  }
  if (step.kind === "moved") {
    completeMove(conversationId, move, step)
    return
  }
  if (step.kind === "kept-here") {
    cloudMovesStore.set((state) => ({
      ...state,
      moves: { ...state.moves, [move]: { direction: "outbound", origin: state.moves[move]?.origin ?? conversationId, target: conversationId, settled: "kept-here" } },
      failedMoves: { ...state.failedMoves, [conversationId]: {
        move,
        reason: step.reason,
        handOff: state.moving[conversationId]?.handOff === true || step.continued === true,
        continued: step.continued === true,
      } },
      moving: without(state.moving, conversationId),
    }))
    toast.message("It stayed on this Mac", { id: `move:${move}`, description: step.continued ? `${step.reason} Its turn goes on here.` : step.reason })
    return
  }
  cloudMovesStore.set((state) => {
    const handOff = step.kind === "pausing" || state.moving[conversationId]?.handOff
    const ownBranch = step.kind === "own-branch" || state.moving[conversationId]?.ownBranch
    return { ...state, failedMoves: without(state.failedMoves, conversationId), moving: { ...state.moving, [conversationId]: { ...state.moving[conversationId], move, step, ...handOff && { handOff: true }, ...ownBranch && { ownBranch: true } } } }
  })
}

/** Settlement and location/readback effects are deduplicated separately: later same-operation membership may add to them. */
function completeMove(conversationId: string, move: string, step: Extract<ThreadMoveStep, { kind: "moved" }>, readBack: string[] = []): void {
  const state = cloudMovesStore.get()
  const owner = state.moves[move]
  if (owner?.direction !== "outbound") return
  const previous = owner.completed
  const completed = { ...previous, ...step, conversations: [...new Set([...previous?.conversations ?? [], ...step.conversations])] }
  const reads = [...new Set([...owner.refreshed ?? [], ...completed.conversations, ...readBack])]
  const next = { ...state, moves: { ...state.moves, [move]: { ...owner, settled: "moved" as const, completed, refreshed: reads } } }
  const locations = completed.conversations.filter((id) => !owner.located?.includes(id) && latestOperation(next, id) === move)
  const refreshes = reads.filter((id) => !owner.refreshed?.includes(id) && latestOperation(next, id) === move)
  cloudMovesStore.set(retireSuperseded({
    ...next,
    moves: { ...next.moves, [move]: { ...next.moves[move], located: [...owner.located ?? [], ...locations], refreshed: [...owner.refreshed ?? [], ...refreshes] } },
    failedMoves: without(state.failedMoves, conversationId),
    moving: without(state.moving, conversationId),
  }, move))
  // Richer host metadata updates the existing toast under its same ID; identical/partial completions repeat nothing.
  if (!previous || JSON.stringify([previous.continued, previous.carried, previous.whileAway]) !== JSON.stringify([completed.continued, completed.carried, completed.whileAway])) {
    const carried = carriedSentence(completed.carried)
    if (completed.whileAway) toast.success("Continued in the cloud", { id: `move:${move}`, duration: completed.whileAway.behind ? Infinity : undefined, description: whileAwaySentence(completed.whileAway.behind) })
    else if (completed.continued) toast.success("Handed off to the cloud", { id: `move:${move}`, description: ["Its turn goes on in a cloud machine, at the same folder, where it left off.", carried].filter(Boolean).join(" ") })
    else toast.success("Moved to the cloud", { id: `move:${move}`, description: ["It goes on in a cloud machine, at the same folder. Its worktree here follows each turn there.", carried].filter(Boolean).join(" ") })
  }
  for (const id of new Set([...locations, ...refreshes])) {
    if (locations.includes(id)) receiveLive(id, { from: "said" }, () => updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: CLOUD_WHERE } : conversation)))
    if (refreshes.includes(id)) void hydrateLive(id, true)
  }
}

/** A Thread another device continued in the cloud while this Mac was off, as this Mac says it once it let go. */
export function whileAwaySentence(behind: boolean): string {
  const base = "It went on in a cloud machine while this Mac was off, so this Mac let go of it. Its worktree here follows each turn there; bring it back any time."
  return behind ? `${base} The last turns you read may not have reached the cloud before this Mac went quiet: they stay in this Mac's history.` : base
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
  // Only what this Mac sent comes back to its place: what the agent wrote elsewhere waits apart, beside the person's.
  const unsent = landed.outside.unsent ?? []
  if (unsent.length) parts.push(`${unsent.length === 1 ? name(unsent[0] ?? "") : files(unsent.length)}, written outside its worktree in the cloud, ${unsent.length === 1 ? "is" : "are"} kept apart: this Mac never sent ${unsent.length === 1 ? "it" : "them"}.`)
  const failed = landed.outside.failed ?? []
  const [first] = failed
  if (first) parts.push(failed.length === 1 ? `${name(first.path)} couldn't be written back: ${first.why}.` : `${files(failed.length)} outside its worktree couldn't be written back, such as ${name(first.path)}: ${first.why}.`)
  return parts.length ? parts.join(" ") : undefined
}

/** The person keeps the Thread in the cloud with their changes here: its notice goes; its Cloud chip still brings it back. */
/** The conversations whose Thread waits for the account since this Mac went away, the whole list as the host says it. */
export function awayHeld(conversations: readonly string[]): void {
  cloudMovesStore.set((state) => ({ ...state, awayHeld: Object.fromEntries(conversations.map((id) => [id, true as const])) }))
}

/** Which conversations wait for the account now, read once a window opens; `away-held` events keep it after. */
export async function loadAwayHeld(): Promise<void> {
  if (!hasBridge()) return
  const held = await getMako().awayHeldConversations().catch(() => undefined)
  if (held) awayHeld(held)
}

/** Runs the Thread of `conversationId` here, whatever the account did while this Mac was away. */
export async function runHereAnyway(conversationId: string): Promise<void> {
  if (!hasBridge()) return
  await getMako().runHandedOffHere(conversationId)
}

/** A Thread the cloud took left files of its own in the project folder. */
export function checkoutStayed(event: { conversation: string; paths: string[]; unpushed: number }): void {
  cloudMovesStore.set((state) => ({ ...state, checkoutStayed: { ...state.checkoutStayed, [event.conversation]: { paths: event.paths, unpushed: event.unpushed } } }))
}

export function dismissCheckoutStayed(conversationId: string): void {
  cloudMovesStore.set((state) => ({ ...state, checkoutStayed: without(state.checkoutStayed, conversationId) }))
}

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
  if (!hasBridge() || moveInFlight(cloudMovesStore.get(), conversationId)) return undefined
  return askReturn(conversationId, crypto.randomUUID(), options)
}

/** The host asked for a return, new or one it left unsettled: the window shows it packing until the host says more. */
async function askReturn(conversationId: string, move: string, options?: ThreadReturnOptions): Promise<ThreadReturnOutcome> {
  threadReturnStepped(conversationId, move, { kind: "packing" })
  try {
    const outcome = await getMako().threadReturn(conversationId, move, options)
    const owner = currentReturn(move)
    if (owner?.origin === conversationId) {
      if (outcome.kind === "back") completeReturn(owner.target, move, { kind: "back", conversations: [owner.target], ...outcome.landed && { landed: outcome.landed } }, knownMoveMembers(owner.target))
      else threadReturnStepped(owner.target, move, outcome)
    }
    return outcome
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const owner = currentReturn(move)
    if (owner?.origin === conversationId) threadReturnStepped(owner.target, move, { kind: "unsettled", reason, waitsOn: "cloud" })
    return { kind: "unsettled", reason, waitsOn: "cloud" }
  }
}

/** A return reply must still belong to the displayed operation; terminal and disposed replies do not regain it. */
function currentReturn(move: string): Extract<CloudOperation, { direction: "return" }> | undefined {
  const state = cloudMovesStore.get()
  const owner = state.moves[move]
  return owner?.direction === "return" && !owner.ignored && !owner.superseded && !owner.settled && state.returning[owner.target]?.move === move ? owner : undefined
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
  const state = cloudMovesStore.get()
  const known = state.moves[move]
  if (known) {
    if (known.ignored || known.superseded || known.direction !== "return" || known.target !== conversationId || (currentReturn(move)?.target !== conversationId && !(step.kind === "back" && known.settled === "back" && latestOperation(state, known.origin) === move && latestOperation(state, conversationId) === move))) return
  } else {
    if (state.returning[conversationId]) {
      ignoreOperation(state, move, conversationId, "return")
      return
    }
    cloudMovesStore.set({ moves: { ...state.moves, [move]: { direction: "return", origin: conversationId, target: conversationId } } })
  }
  if (step.kind === "back") {
    completeReturn(conversationId, move, step)
    return
  }
  if (step.kind === "stayed") {
    cloudMovesStore.set((state) => ({ ...state, returning: without(state.returning, conversationId), moves: { ...state.moves, [move]: { direction: "return", origin: state.moves[move]?.origin ?? conversationId, target: conversationId, settled: "stayed" } } }))
    if (step.missing) {
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

/** A confirmed return joins the same ownership order as outbound moves, before any local effects are applied. */
function completeReturn(conversationId: string, move: string, step: Extract<ThreadReturnStep, { kind: "back" }>, readBack: string[] = []): void {
  const state = cloudMovesStore.get()
  const owner = state.moves[move]
  if (owner?.direction !== "return") return
  const previous = owner.returned
  const returned = { ...previous, ...step, conversations: [...new Set([...previous?.conversations ?? [], ...step.conversations])] }
  const reads = [...new Set([...owner.refreshed ?? [], ...returned.conversations, ...readBack])]
  const next = { ...state, moves: { ...state.moves, [move]: { ...owner, settled: "back" as const, returned, refreshed: reads } } }
  if (latestOperation(next, owner.origin) !== move || latestOperation(next, owner.target) !== move) {
    cloudMovesStore.set(retireOperations(state, [move]))
    return
  }
  const locations = returned.conversations.filter((id) => !owner.located?.includes(id) && latestOperation(next, id) === move)
  const refreshes = reads.filter((id) => !owner.refreshed?.includes(id) && latestOperation(next, id) === move)
  cloudMovesStore.set(retireSuperseded({
    ...next,
    moves: { ...next.moves, [move]: { ...next.moves[move], located: [...owner.located ?? [], ...locations], refreshed: [...owner.refreshed ?? [], ...refreshes] } },
    returning: without(state.returning, conversationId),
    // A confirmed local owner also releases an obsolete outbound lock, including an old fork's source alias.
    moving: Object.fromEntries(Object.entries(state.moving).filter(([id, held]) => latestOperation(next, id) === held.move && latestOperation(next, state.moves[held.move]?.origin ?? id) === held.move)),
    failedMoves: Object.fromEntries(Object.entries(state.failedMoves).filter(([id]) => latestOperation(next, id) !== move)),
    followStopped: Object.fromEntries(Object.entries(state.followStopped).filter(([id]) => !locations.includes(id))),
  }, move))
  if (!previous || JSON.stringify(previous.landed) !== JSON.stringify(returned.landed)) {
    const landed = landedSentence(returned.landed)
    const conflicted = Boolean(returned.landed?.conflicts.length || returned.landed?.outside.failed?.length)
    const say = conflicted ? toast.warning : toast.success
    const waiting = [...returned.landed?.outside.waiting ?? [], ...returned.landed?.outside.unsent ?? []]
    const kept = returned.landed?.outside.kept
    const compare = kept && waiting.length ? { label: waiting.length === 1 ? "Open the cloud's copy" : "Show the cloud's copies", onClick: () => void getMako().revealPath(waiting.length === 1 ? `${kept}${waiting[0]}` : kept).catch(() => undefined) } : undefined
    say("Back on this Mac", { id: `return:${move}`, description: landed ?? "It goes on here, with what it did in the cloud in its worktree. The cloud machine is gone.", ...landed && { duration: 12_000 }, ...compare && { action: compare } })
  }
  for (const id of new Set([...locations, ...refreshes])) {
    if (locations.includes(id)) receiveLive(id, { from: "said" }, () => updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: undefined } : conversation)))
    if (refreshes.includes(id)) void hydrateLive(id, true)
  }
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
