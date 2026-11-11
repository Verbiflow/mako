import { reconcileRoster } from "@/lib/native-roster"
import { acknowledgeComposerSettings } from "@/state/composer-settings"
import { playFeedback } from "@/state/feedback"
import { getMako, hasBridge } from "@/lib/bridge"
import type { ContinuationResolution, LiveAction, LiveBatch, LiveSnapshot, LiveSummary } from "@/lib/types"
import { acpStore, carriedFailureSeen, removeAcpConversation, replaceAcpConversation, updateAcpConversation, type AcpConversation, type LiveAcpConversation } from "@/state/acp-state"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { noteFinAsks, noteListedOutcome, syncThreadStatus } from "@/state/acp-live"
import { threadsStore } from "@/state/thread-store"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import { changesSession, expandLiveBatch, isCompactBatch, requestsAfter, sessionAfter, type HeardLiveBatch } from "@mako/host/contracts/live-conversations"
import { laterPrompt, personPromptedAt, promptedAfter } from "@mako/host/contracts/worked-at"
import { projectLive } from "@/state/live-projection"
import { toast } from "sonner"
import { settleMessage } from "@/state/message-outbox"
import { isHostReconnectingError } from "@mako/host/contracts/host-connection"
import { prependLiveHistory, readLiveSnapshot, readLiveValue, retainLiveDetails } from "@/state/live-history"
import { isHistoryExpired, type LiveHistoryCursor, type LiveHistoryPage } from "@mako/host/contracts/live-history"
import { liveReadingSource, transcriptReaders } from "@/state/transcript-reading"
import { currentStarts, readsOut, readsSettled, readsSince, receiveLive, unlistedSince, unplacedReadAnswered, unplacedReadGoesOut, type ReadOut, type Received } from "@/state/live-door"

const fetching = new Map<string, Promise<boolean>>()
const pending = new Map<string, HeardLiveBatch[]>()

function readGoesOut(id: string): ReadOut {
  const asked = acpStore.get().conversations[id]
  const read: ReadOut = asked?.kind === "live" && asked.revision !== undefined ? { revision: asked.revision, ...(asked.epoch && { epoch: asked.epoch }) } : { revision: -1 }
  readsOut.set(id, (readsOut.get(id) ?? new Set()).add(read))
  return read
}

/**
 * The read is answered: whether what it says is past, older than what this window took meanwhile, or can't be placed
 * against it (a start it can't order, and not the one it last learned is current), when it isn't taken either, and
 * the current host is read afresh where this window still holds the conversation. `fresh`: it's that read's answer.
 */
function readAnswered(id: string, read: ReadOut, snapshot: { revision: number; epoch?: string } | null, fresh = false): boolean {
  return readVerdict(id, read, snapshot, fresh) !== "take"
}

/**
 * `readAnswered`'s verdict: `take` it; `older` than what the window took of it while the read was out, and nothing
 * else (what holds it still takes only its view, `takeView`); or `past` altogether.
 */
function readVerdict(id: string, read: ReadOut, snapshot: { revision: number; epoch?: string } | null, fresh = false): "take" | "older" | "past" {
  const out = readsOut.get(id)
  out?.delete(read)
  if (out && !out.size) readsOut.delete(id)
  readsSettled()
  if (!snapshot) return "take"
  // Of a conversation its host stopped listing here while it was out: nothing the window holds, nor brings back.
  if (read.unlisted) return "past"
  // Behind a batch of its own start the stream sent while it was out, taken or not: older, so a window that holds it
  // keeps only its view, and one that doesn't never takes it.
  if (read.heard && snapshot.epoch === read.heard.epoch && snapshot.revision < read.heard.revision) return "older"
  if (read.revision < 0) return "take"
  const order = olderThan(snapshot, read)
  if (order === true) return "older"
  // A fresh read speaks for the current host only while nothing was taken since it was asked.
  if (order !== undefined || (fresh && !read.moved) || snapshot.epoch === currentStarts.get(id)) return "take"
  if (acpStore.get().conversations[id]) readAfresh(id)
  return "past"
}

/** Every read out of this conversation hears the revision it now stands at here. */
function noteTaken(id: string): void {
  const current = acpStore.get().conversations[id]
  if (current?.kind !== "live" || current.revision === undefined) return
  const taken = { revision: current.revision, ...(current.epoch && { epoch: current.epoch }) }
  for (const read of readsOut.get(id) ?? []) {
    if (read.revision >= 0 && olderThan(read, taken) === false) continue
    read.revision = taken.revision
    read.epoch = taken.epoch
    read.moved = true
  }
}

/** What a snapshot of the host's goes to once it's taken, with the answer it came in: by default, the door. */
type Take<Answer> = (snapshot: LiveSnapshot, answer: Answer) => void
const takeWhole = (snapshot: LiveSnapshot) => applyLiveSnapshot(snapshot)

/** A read out, from its ask to its answer: of conversation `id`, or of one only its answer names, out `since` then. */
interface LiveRead { id?: string; out?: ReadOut; since: number }

function openRead(id: string | undefined): LiveRead {
  return id === undefined ? { since: unplacedReadGoesOut() } : { id, since: readsSince(), out: readGoesOut(id) }
}

/** The read's answer is `snapshot`: its verdict (`readVerdict`, or past when its conversation was unlisted since). */
function answerVerdict(read: LiveRead, snapshot: LiveSnapshot): "take" | "older" | "past" {
  if (read.out && read.id === snapshot.session.id) {
    const verdict = readVerdict(read.id, read.out, snapshot)
    read.out = undefined
    return verdict
  }
  return unlistedSince(snapshot.session.id, read.since) ? "past" : "take"
}

/**
 * Takes a read's answer by its verdict: what's current goes to `take`; one only older than what the window took
 * goes to the door, which keeps of it only its view while the window holds the conversation (`takeSnapshot`'s stale
 * path, as a recapture or a renewed view needs); one that's past goes nowhere.
 */
function takeAnswer<Answer>(read: LiveRead, snapshot: LiveSnapshot, answer: Answer, take: Take<Answer>): void {
  const verdict = answerVerdict(read, snapshot)
  if (verdict === "take") take(snapshot, answer)
  else if (verdict === "older" && acpStore.get().conversations[snapshot.session.id]) applyLiveSnapshot(snapshot)
}

function closeRead(read: LiveRead): void {
  if (read.out && read.id !== undefined) readAnswered(read.id, read.out, null)
  else if (read.id === undefined) unplacedReadAnswered()
  read.out = undefined
}

/**
 * The one read of a conversation's snapshot the window makes of its host, but `hydrateLive`'s (which keeps the same
 * record): `ask` (its snapshot, `readLiveSnapshot`, or an action that answers with it), a read of conversation `id`
 * out from the moment it's asked until it's answered, so what reaches the window meanwhile goes on its record
 * (`receiveLive`). The snapshot its answer holds (`snapshotOf`) goes to `take`, by default the door
 * (`applyLiveSnapshot`), unless it's past: older than what the window took meanwhile, of a start it can't place, or of
 * a Session its host stopped listing here while it was out. `id` is undefined where the window learns which
 * conversation it is from the answer (a path's owner); one that names another (a fork, a capture) is weighed by what
 * was unlisted while it was out. Resolves with the answer, taken or not; an ask that fails rejects, its read closed.
 */
export async function readLiveFrom<Answer>(id: string | undefined, ask: () => Promise<Answer>, snapshotOf: (answer: Answer) => LiveSnapshot | null | undefined, take: Take<Answer> = takeWhole): Promise<Answer> {
  const read = openRead(id)
  try {
    const answer = await ask()
    const snapshot = snapshotOf(answer)
    if (snapshot) takeAnswer(read, snapshot, answer, take)
    return answer
  } finally {
    closeRead(read)
  }
}

/** `readLiveFrom` for an ask that answers with the snapshot itself, or nothing. */
export function readLive<Answer extends LiveSnapshot | null | undefined>(id: string | undefined, ask: () => Promise<Answer>, take: Take<Answer> = takeWhole): Promise<Answer> {
  return readLiveFrom(id, ask, (answer) => answer, take)
}

/**
 * How the host goes on with the session at `path`, read as any snapshot is (`readLiveFrom`): one it already holds
 * (`attached`) is taken with the binding it answers on.
 */
export function readContinuation(path: string): Promise<ContinuationResolution> {
  return readLiveFrom(undefined, () => getMako().resolveContinuation(path), (resolved) => resolved.transport === "attached" ? resolved.snapshot : null,
    (snapshot, resolved) => applyLiveSnapshot(snapshot, resolved.transport === "attached" ? resolved.bindingId ?? null : null))
}

/** `readLive` for an ask whose answer is several conversations' snapshots (the rewinds a host recovers). */
export async function readLives(ask: () => Promise<readonly LiveSnapshot[]>): Promise<readonly LiveSnapshot[]> {
  const read = openRead(undefined)
  try {
    const snapshots = await ask()
    for (const snapshot of snapshots) takeAnswer(read, snapshot, snapshot, takeWhole)
    return snapshots
  } finally {
    closeRead(read)
  }
}

/**
 * A conversation's snapshot read back and taken, as an answer's receipt is (`answerLiveApproval`), unless it's past
 * (`readLive`). The snapshot either way, or null when there's none to read.
 */
export async function readBackLive(id: string): Promise<LiveSnapshot | null> {
  return readLive(id, () => readLiveSnapshot(id).catch(() => null))
}
// Invalid/oversized snapshots cannot be repaired by refetching on every token.
// Activation and reconnect retry them. Transient outages may recover on a later
// batch even if the independent event stream stayed connected throughout.
const failed = new Map<string, { description: string; reconnecting: boolean }>()
/**
 * The revision from which every batch merged into the window in order. A view read at or after it holds the window's
 * history below the window as the window does: a batch that touched that history was buffered for a snapshot instead.
 */
const mergedSince = new Map<string, number>()
/**
 * The batch a reread left waiting, and how many rereads in a row left that same batch waiting: the host answered
 * without it, so each next ask waits longer and nothing a host never answers can spin. New batches read at once.
 */
const stuck = new Map<string, { batch: HeardLiveBatch; tries: number }>()

function restoredLive(id: string): void {
  if (failed.delete(id)) toast.dismiss(`live-restore:${id}`)
}

/**
 * Whether `incoming` continues the numbering `held` was built on. Revisions
 * compare only within one host epoch; across epochs the newer snapshot wins
 * outright, because the host that wrote it may have rewritten what it reopened
 * at the same revision.
 */
function sameEpoch(held: { epoch?: string } | undefined, incoming: { epoch?: string }): boolean {
  return held?.epoch === undefined || incoming.epoch === undefined || held.epoch === incoming.epoch
}

/** A host start as its epoch says it (`LiveConversations.epoch`): its generation on its data root, and that root's name. */
function startOf(epoch: string): { generation: number; root: string } | undefined {
  const said = /^g(\d+)\.([A-Za-z0-9_-]{8,16})\./.exec(epoch)
  return said ? { generation: Number(said[1]), root: said[2]! } : undefined
}

/**
 * Whether `said` is older than `held`, as one order: an older start of the host, whatever its revision, or an older
 * revision of the same start; a newer start always wins. Undefined where the order can't be established: either epoch
 * says no generation (a build before they did), or they're of two data roots (another device's, or a record lost).
 * One that names no start at all is read as the same start.
 */
function olderThan(said: { epoch?: string; revision: number }, held: { epoch?: string; revision: number }): boolean | undefined {
  if (said.epoch === undefined || held.epoch === undefined || said.epoch === held.epoch) return said.revision < held.revision
  const [saidStart, heldStart] = [startOf(said.epoch), startOf(held.epoch)]
  if (!saidStart || !heldStart || saidStart.root !== heldStart.root || saidStart.generation === heldStart.generation) return undefined
  return saidStart.generation < heldStart.generation
}

/** Conversations whose next read is the current host's word, asked for when a reply couldn't be placed. */
const freshReads = new Set<string>()

/** A reply this window couldn't place against what it holds: it isn't taken, and the current host is asked afresh. */
function readAfresh(id: string): void {
  freshReads.add(id)
  if (fetching.has(id)) rereads.add(id)
  else void hydrateLive(id, true)
}

/** Where the history on screen begins, when it is a window the host paged. */
function windowStart(conversation: AcpConversation | undefined): LiveHistoryCursor | undefined {
  return conversation?.kind === "live" && conversation.hydrated && conversation.history
    ? { blocks: conversation.history.blockStart, base: conversation.base?.start ?? 0 }
    : undefined
}

function reachesEarlier(left: LiveHistoryCursor, right: LiveHistoryCursor): boolean {
  return left.blocks < right.blocks || left.base < right.base
}

/**
 * Whether taking `snapshot` would drop history the reader has on screen. A
 * snapshot answering an action carries only the newest window, and a refresh
 * asked for the window as it stood when it left, before a page the reader
 * loaded meanwhile. `covers` is the window the read was asked for: history
 * the host chose not to return for that window is its call to make.
 */
function dropsLoadedHistory(existing: AcpConversation | undefined, snapshot: LiveSnapshot, covers?: LiveHistoryCursor): boolean {
  const held = windowStart(existing)
  if (!held || !snapshot.history || !sameEpoch(existing, snapshot)) return false
  const incoming = { blocks: snapshot.history.blockStart, base: snapshot.base?.start ?? held.base }
  return reachesEarlier(held, incoming) && (!covers || reachesEarlier(held, covers))
}

/**
 * A steer the host has answered and kept (`steerTo`): its words reached the turn, or may have. One still on its way
 * stays in the outbox until it's answered, and one refused goes on as a message, kept until that is taken.
 */
function steerTaken(action: LiveAction): boolean {
  return action.state.kind !== "dispatching" && action.state.kind !== "not-accepted"
}

/** A snapshot taken in (a read's, or an action's answer), through the door (`receiveLive`). */
export function applyLiveSnapshot(snapshot: LiveSnapshot, replyBindingId?: string | null, covers?: LiveHistoryCursor, fresh = false): void {
  receiveLive(snapshot.session.id, { from: "answer" }, () => takeSnapshot(snapshot, replyBindingId, covers, fresh))
}

function takeSnapshot(snapshot: LiveSnapshot, replyBindingId?: string | null, covers?: LiveHistoryCursor, fresh = false): void {
  restoredLive(snapshot.session.id)
  for (const request of snapshot.requests) settleMessage(request.id, true)
  for (const transfer of snapshot.control?.transfers ?? []) settleMessage(transfer.input.id, true)
  for (const action of snapshot.control?.actions ?? []) if (steerTaken(action)) settleMessage(action.input.id, true)
  const id = snapshot.session.id
  const existing = acpStore.get().conversations[id]
  // Older than what this window holds of it, shown or only listed (it was let go of, and its revision kept): a read the
  // stream overtook, or one answered by a start of its host older than the one it holds.
  // What a copy in the account said is no start of a host: the device itself, back, always says more.
  const order = existing?.kind === "live" && existing.revision !== undefined && !(existing.copy && !snapshot.copy)
    ? olderThan(snapshot, { revision: existing.revision, ...(existing.epoch && { epoch: existing.epoch }) })
    : false
  // One it can't place (a start without a generation, or another data root's) never replaces what it holds, unless
  // it's of the start it last learned the conversation is of now, or the answer to the fresh read asked for it.
  if (order === undefined && !fresh && snapshot.epoch !== currentStarts.get(id)) return readAfresh(id)
  const stale = order === true
  const narrower = !stale && dropsLoadedHistory(existing, snapshot, covers)
  if (stale || narrower) {
    if (replyBindingId !== undefined && existing) updateAcpConversation(id, (current) => ({ ...current, replyBindingId: replyBindingId ?? undefined }))
    if (stale && existing?.kind === "live") {
      if (existing.hydrated) takeView(existing, snapshot)
      dropHeld(existing)
    }
    // The same state, read again over the range on screen, replaces it whole; one on screen not yet read is read again.
    if (narrower || (stale && acpStore.get().activeKey === id && !existing?.hydrated)) rereadLive(id)
    return
  }
  const pendingPrompts = existing?.pendingPrompts?.filter(
    (prompt) => !snapshot.requests.some((request) => request.id === prompt.id) &&
      !snapshot.control?.transfers.some((transfer) => transfer.input.id === prompt.id)
  )
  const observedChange = existing?.kind === "live" && sameEpoch(existing, snapshot) &&
    pending.get(id)?.some(batch => sameEpoch(batch, snapshot) && batch.revision > (existing.revision ?? 0) && batch.revision <= snapshot.revision)
  snapshot = retainLiveDetails(snapshot)
  replaceAcpConversation(id, {
    key: id,
    replyBindingId: replyBindingId === undefined ? existing?.replyBindingId : replyBindingId ?? undefined,
    draftKey: existing?.draftKey ?? id,
    harness: snapshot.session.harness,
    cwd: snapshot.session.cwd,
    title: snapshot.session.title,
    threadPath: snapshot.threadPath,
    elsewhere: existing?.elsewhere,
    elsewhereKind: existing?.elsewhereKind,
    // Read from its copy, its device is still off; a snapshot from the device itself says it's back.
    quietSince: snapshot.copy ? existing?.quietSince : undefined,
    cloudContinue: snapshot.copy ? existing?.cloudContinue : undefined,
    // The Thread's name and when it last moved are the account's list's word, which a snapshot read from its owner
    // doesn't repeat: kept from the listing, so the rail row doesn't fall back to the Session's title once it's opened.
    threadTitle: snapshot.threadTitle ?? existing?.threadTitle,
    movedAt: snapshot.movedAt ?? existing?.movedAt,
    rail: snapshot.rail ?? existing?.rail,
    promptedAt: laterPrompt(personPromptedAt(snapshot.requests, snapshot.control?.actions), snapshot.promptedAt ?? existing?.promptedAt),
    threadId: snapshot.threadId ?? existing?.threadId,
    sessionId: snapshot.sessionId ?? existing?.sessionId,
    parent: snapshot.parent ?? existing?.parent,
    // An Apex listed from another device keeps its row's Fins once opened, until its own roster says them.
    fins: snapshot.fins ?? existing?.fins,
    createdAt: snapshot.createdAt,
    updatedAt: Date.now(),
    kind: "live",
    session: snapshot.session,
    nativePaths: snapshot.control?.bindings.flatMap((binding) =>
      binding.path ? [binding.path] : []
    ),
    control: snapshot.control,
    nativeAgents: snapshot.nativeAgents,
    goal: snapshot.goal,
    side: snapshot.side,
    requests: snapshot.requests,
    harnessTurns: snapshot.harnessTurns,
    spentThrough: snapshot.spentThrough,
    pendingPrompts,
    base: snapshot.base,
    baseSource: snapshot.baseSource,
    historyFailure: snapshot.historyFailure,
    baseCoveredBlocks: snapshot.baseCoveredBlocks,
    blocks: snapshot.blocks,
    revision: snapshot.revision,
    epoch: snapshot.epoch ?? existing?.epoch,
    activityAt: snapshot.activityAt,
    nativeActivity: snapshot.nativeActivity,
    history: snapshot.history,
    copy: snapshot.copy,
    hydrated: true,
    projection: projectLive(snapshot, existing?.projection, pendingPrompts),
    permission: snapshot.permissions[0] ?? null,
    queued: snapshot.requests.filter(
      (request) => request.status === "queued" || request.status === "held"
    ),
    hiddenUserPrompt: null,
    sending: false,
    canceling: false,
    failureSeen: carriedFailureSeen(
      existing?.kind === "live" ? existing : undefined,
      snapshot.session
    ),
  })
  const restored = acpStore.get().conversations[id]
  if (observedChange) notifyCompletion(existing.requests, snapshot.requests)
  if (restored?.kind === "live") acknowledgeComposerSettings(restored)
  if (restored?.kind === "live")
    syncThreadStatus(
      restored,
      existing?.kind === "live" ? existing.session.status : "starting",
      existing?.threadPath,
      observedChange ? undefined : "hydrate"
    )
  mergedSince.set(id, snapshot.revision)
  // Its start is current now. What waited for it: its own start's batches, then any of a newer start or of the one the
  // stream last said, which go on after it (a reply of a start it can't order is then placed by a fresh read). One of a
  // start older than it, or one it can't order that the stream has since left, is past: replayed, it would ask this
  // host for a snapshot in its numbering, which never comes, and again after every answer.
  const said = currentStarts.get(id)
  if (snapshot.epoch) currentStarts.set(id, snapshot.epoch)
  const buffered = (pending.get(id) ?? []).filter((batch) => sameEpoch(snapshot, batch) || goesOn(batch, snapshot, said))
  pending.delete(id)
  for (const batch of buffered) applyLiveBatch(batch, true)
  noteTaken(id)
  // An answer its Fins heard while this window held a gap, or held the Session not at all, takes back what was said; an
  // ask that came meanwhile is said, quietly, as its own approval is (`syncThreadStatus`).
  const read = acpStore.get().conversations[id]
  if (read?.kind === "live") noteFinAsks(read, true)
}

/**
 * A snapshot the stream overtook: the window holds newer content than it, but it names a view the host holds. When
 * every batch since it merged in order and its history reaches back as far as the window's, that view holds the
 * window's earlier history, released turns and full outputs exactly, so reads go to it rather than to a view the host
 * let go. Without this, a window reading a conversation that streams could never replace a view the host let go.
 */
function takeView(existing: Extract<AcpConversation, { kind: "live" }>, snapshot: LiveSnapshot): void {
  const since = mergedSince.get(existing.key)
  const view = snapshot.history
  if (!existing.history || !view || since === undefined || since > snapshot.revision || view.token === existing.history.token ||
      (existing.base && (!snapshot.base || snapshot.base.start > existing.base.start)))
    return
  updateAcpConversation(existing.key, (current) => current.kind === "live" && current.history
    ? { ...current, history: { ...current.history, token: view.token } } : current)
}

/**
 * Whether a batch that waited on a snapshot of another start goes on after it: one of a newer start, or one of a start
 * it can't order that is the one the window last learned the conversation is of (`said`), the stream's latest word.
 */
function goesOn(batch: { epoch?: string; revision: number }, held: { epoch?: string; revision: number }, said: string | undefined): boolean {
  const order = olderThan(batch, held)
  return order === false || (order === undefined && batch.epoch === said)
}

/**
 * Buffered batches the window already holds wait for nothing, nor do those of another start that are past (`goesOn`);
 * only one past what it holds asks for a newer snapshot.
 */
function dropHeld(existing: Extract<AcpConversation, { kind: "live" }>): void {
  const held = { revision: existing.revision ?? 0, ...(existing.epoch && { epoch: existing.epoch }) }
  const waiting = pending.get(existing.key)?.filter((batch) =>
    sameEpoch(existing, batch) ? batch.revision > held.revision : goesOn(batch, held, currentStarts.get(existing.key)))
  if (waiting?.length) pending.set(existing.key, waiting)
  else pending.delete(existing.key)
}

/** Refreshes that must run again once the one in flight lands, over the window on screen by then. */
const rereads = new Set<string>()

function rereadLive(id: string): void {
  if (fetching.has(id)) rereads.add(id)
  else void hydrateLive(id)
}

/**
 * Read the conversation into a new view whatever this window holds. A view
 * is fixed when it's read, so what streamed since isn't in it, and a refresh
 * that finds this window current keeps the view it has. A caller holding an operation's authority checks it again
 * after the hydration wait, before admitting a new read, and before that read may publish.
 */
export async function recaptureLive(id: string, isCurrent: () => boolean = () => true): Promise<void> {
  await fetching.get(id)
  if (!isCurrent()) return
  const covers = windowStart(acpStore.get().conversations[id])
  await readLiveFrom(id, () => readLiveSnapshot(id), (snapshot) => isCurrent() ? snapshot : null,
    (snapshot) => applyLiveSnapshot(snapshot, undefined, covers))
}

export async function hydrateLive(id: string, quiet = false): Promise<boolean> {
  if (!hasBridge()) return false
  const existing = fetching.get(id)
  if (existing) return existing
  let restored = false
  const covers = windowStart(acpStore.get().conversations[id])
  // The current host's word, asked for because a reply couldn't be placed: taken, whatever its start.
  const fresh = freshReads.delete(id)
  const since = readsSince()
  const read = readGoesOut(id)
  const fetch = readLiveSnapshot(id, true)
    .then((snapshot) => {
      restored = true
      // Its canonical answer may name another conversation. Weigh that conversation's retirement before settling
      // the requested read: settling the last read clears the record of what was unlisted while it was out.
      const unlisted = snapshot && !("kind" in snapshot) && unlistedSince(snapshot.session.id, since)
      // Taken newer meanwhile, held still or not (let go of, or no longer listed): that's newer than what it says.
      if (readAnswered(id, read, snapshot && !("kind" in snapshot) ? snapshot : null, fresh) || unlisted) {
        if (!acpStore.get().conversations[id]) pending.delete(id)
        restoredLive(id)
        if (acpStore.get().activeKey === id && !acpStore.get().conversations[id]?.hydrated) rereadLive(id)
        return false
      }
      if (snapshot && "kind" in snapshot) {
        restoredLive(id)
        const held = acpStore.get().conversations[id]
        if (held?.kind === "live") dropHeld(held)
      }
      else if (snapshot) applyLiveSnapshot(snapshot, undefined, covers, fresh && !read.moved)
      else {
        pending.delete(id)
        restoredLive(id)
      }
      return snapshot !== null
    })
    .catch((error) => {
      const description = error instanceof Error ? error.message : String(error)
      const previous = failed.get(id)
      // Transport outages belong to the shared reconnect/owner state. They
      // are not a new conversation failure on every refresh or in every tab.
      const reconnecting = error instanceof Error && isHostReconnectingError(error)
      if (!quiet && !reconnecting && previous?.description !== description)
        toast.error("Conversation could not refresh", { id: `live-restore:${id}`, description })
      // A quiet probe must not consume the user's first visible error.
      failed.set(id, { description: quiet && !reconnecting ? previous?.description ?? "" : description, reconnecting })
      return false
    })
    .finally(() => {
      readAnswered(id, read, null)
      fetching.delete(id)
      const waiting = restored ? pending.get(id)?.[0] : undefined
      if (!rereads.delete(id) && !waiting) {
        stuck.delete(id)
        // Its last read settled: one read only to catch up goes back to being listed, unless it's on screen now.
        if (releaseWhenRead.delete(id) && acpStore.get().activeKey !== id) unloadLive(id)
      } else {
        const held = stuck.get(id)
        const tries = waiting && held?.batch === waiting ? held.tries + 1 : 0
        if (waiting) stuck.set(id, { batch: waiting, tries })
        if (tries === 5) console.warn(`Conversation ${id} keeps waiting on batch ${waiting?.revision} (epoch ${waiting?.epoch ?? "none"}), which the host's snapshots never reach`)
        const again = () => void hydrateLive(id)
        if (tries === 0) queueMicrotask(again)
        else setTimeout(again, Math.min(8_000, 125 * 2 ** tries))
      }
    })
  fetching.set(id, fetch)
  return fetch
}

/** Listed Sessions read again whole (`refreshListed`), to be let go again once their last read settles. */
const releaseWhenRead = new Set<string>()

/**
 * A listed Session read again whole, quietly, and let go again unless it's on screen by then: once the last read it
 * takes settles, since one that answers before batches it overtook is read again (`hydrateLive`).
 */
function refreshListed(id: string): void {
  if (fetching.has(id)) return
  releaseWhenRead.add(id)
  void hydrateLive(id, true)
}

/**
 * Put a loaded conversation back the way boot listed it: its session,
 * requests and status stay and keep following batches, its transcript goes
 * and is read again, the newest window as the host pages it, when it is
 * shown. False while a read of it is in flight.
 */
export function unloadLive(id: string): boolean {
  const current = acpStore.get().conversations[id]
  if (current?.kind !== "live" || !current.hydrated || fetching.has(id)) return false
  pending.delete(id)
  mergedSince.delete(id)
  stuck.delete(id)
  replaceAcpConversation(id, {
    ...current,
    hydrated: false,
    blocks: [],
    base: undefined,
    baseCoveredBlocks: undefined,
    history: undefined,
    projection: undefined,
    releasedTurns: undefined,
  })
  return true
}

function batchNativeActivity(batch: LiveBatch, current: { nativeActivity?: LiveSnapshot["nativeActivity"] }): LiveSnapshot["nativeActivity"] {
  return batch.nativeActivity === undefined ? current.nativeActivity : (batch.nativeActivity ?? undefined)
}

function batchGoal(batch: LiveBatch, current: { goal?: LiveSnapshot["goal"] }): LiveSnapshot["goal"] {
  return batch.goal === undefined ? current.goal : (batch.goal ?? undefined)
}

function batchSide(batch: LiveBatch, current: { side?: LiveSnapshot["side"] }): LiveSnapshot["side"] {
  return batch.side === undefined ? current.side : (batch.side ?? undefined)
}

function batchHistoryFailure(batch: LiveBatch, current: { historyFailure?: string }): string | undefined {
  return batch.historyFailure === undefined ? current.historyFailure : (batch.historyFailure ?? undefined)
}

/**
 * A batch as its host sent it, whole or in the compact live form (`expandLiveBatch`, the one reading of that form the
 * desk's windows and the web client share). A compact batch is read against what this window holds only where it holds
 * the revision before it; held anywhere else (buffered, out of order, another epoch) it waits as it came and is read
 * when it's next in line, so a snapshot taken meanwhile is what it's read against.
 */
export function applyLiveBatch(heard: HeardLiveBatch, replayed = false): void {
  // Heard on the stream, it's its host's own word; one that waited on a snapshot, replayed after it, was heard already.
  receiveLive(heard.id, replayed ? { from: "answer" } : { from: "said", revision: heard.revision, ...(heard.epoch && { epoch: heard.epoch }) }, () => takeBatch(heard))
}

function takeBatch(heard: HeardLiveBatch): void {
  if (!isCompactBatch(heard)) applyBatch(heard, heard, false)
  else {
    const current = acpStore.get().conversations[heard.id]
    const held = current?.kind === "live" && sameEpoch(current, heard) && heard.revision === (current.revision ?? 0) + 1 ? current : undefined
    const read = expandLiveBatch(heard, held ? { blocks: held.hydrated ? held.blocks : [], requests: held.requests ?? [], ...(held.control && { control: held.control }), ...(held.nativeAgents && { nativeAgents: held.nativeAgents }) } : { blocks: [] })
    for (const patch of read.unheld) settleMessage(patch.id, true)
    applyBatch(read.batch, heard, read.unread)
    // A listed Session can read the rest without its roster. If the seal failed, read it whole as a gap is.
    if (read.unreadRoster && held) refreshListed(heard.id)
  }
  noteTaken(heard.id)
}

/**
 * `batch` merged, or `heard` (what it was read from) buffered for a snapshot. `unread`: `heard` said more than this
 * window could read of it, which a conversation it only lists does without, and one it shows reads again.
 */
function applyBatch(batch: LiveBatch, heard: HeardLiveBatch, unread: boolean): void {
  for (const request of batch.requests ?? batch.requestChanges ?? []) settleMessage(request.id, true)
  for (const transfer of batch.control?.transfers ?? []) settleMessage(transfer.input.id, true)
  for (const action of batch.control?.actions ?? []) if (steerTaken(action)) settleMessage(action.input.id, true)
  const current = acpStore.get().conversations[batch.id]
  if (current?.kind === "live" && sameEpoch(current, batch) && batch.revision <= (current.revision ?? 0)) return
  if (
    current?.kind === "live" &&
    !current.hydrated &&
    !batch.historyChanged &&
    acpStore.get().activeKey !== batch.id &&
    !fetching.has(batch.id)
  ) {
    if (sameEpoch(current, batch) && batch.revision <= (current.revision ?? 0)) return
    // A Session this host runs whose batches it missed (it read one back that the stream had overtaken, then let it
    // go), or held as of a host start before this batch's: what changed meanwhile and goes only when it changes, an
    // approval or a roster, isn't in this batch, so it's read again rather than merged over. Another device's listed
    // Sessions take what their link sends.
    if (current.elsewhere === undefined && current.revision !== undefined && (!sameEpoch(current, batch) || batch.revision > current.revision + 1))
      return refreshListed(batch.id)
    const session = sessionAfter(current.session, batch)
    const requests = requestsAfter(current.requests, batch)
    const next = {
      ...current,
      session,
      harness: session.harness,
      cwd: session.cwd,
      title: session.title,
      control: batch.control ?? current.control,
      nativePaths: batch.control
        ? batch.control.bindings.flatMap((binding) =>
            binding.path ? [binding.path] : []
          )
        : current.nativePaths,
      nativeAgents: batch.nativeAgents ? reconcileRoster(current.nativeAgents, batch.nativeAgents) : current.nativeAgents,
      goal: batchGoal(batch, current),
      side: batchSide(batch, current),
      historyFailure: batchHistoryFailure(batch, current),
      harnessTurns: batch.harnessTurns ?? current.harnessTurns,
      spentThrough: batch.spentThrough === undefined ? current.spentThrough : (batch.spentThrough ?? undefined),
      requests: requests ?? current.requests,
      promptedAt: promptedAfter(current.promptedAt, batch),
      permission: batch.permissions
        ? (batch.permissions[0] ?? null)
        : current.permission,
      threadPath:
        batch.threadPath === undefined
          ? current.threadPath
          : (batch.threadPath ?? undefined),
      revision: batch.revision,
      // Its numbers are its host start's: a batch of a newer start is what it's held as of from then.
      epoch: batch.epoch ?? current.epoch,
      activityAt: batch.activityAt ?? current.activityAt,
      nativeActivity: batchNativeActivity(batch, current),
      updatedAt: Date.now(),
      failureSeen: carriedFailureSeen(current, session),
    }
    replaceAcpConversation(batch.id, next)
    notifyCompletion(current.requests, requests)
    if (changesSession(batch) || batch.permissions || requests || agentAsksMoved(current, next))
      syncThreadStatus(next, current.session.status, current.threadPath)
    if (batch.nativeAgents) noteFinAsks(next)
    return
  }
  if (
    !current?.hydrated ||
    current.kind !== "live" ||
    // A gap in the numbering, or numbering from another host: the blocks on
    // screen are not what this batch was reduced against, so it is buffered
    // and a fresh snapshot is taken rather than merged onto the wrong state.
    !sameEpoch(current, batch) ||
    unread ||
    batch.historyChanged ||
    (current.releasedTurns?.length && batch.updates.length &&
      (batch.changedFrom === undefined || current.releasedTurns.some(turn => batch.changedFrom! < turn.blocks.end))) ||
    (current.history && (batch.base !== undefined || batch.baseCoveredBlocks !== undefined ||
      (batch.changedFrom !== undefined && batch.changedFrom < current.history.blockStart) ||
      batch.updates.some(update => update.kind === "tool-update" && current.blocks.some(block =>
        block.type === "tool" && block.id === update.id && block.historyRest)))) ||
    batch.revision > (current.revision ?? 0) + 1
  ) {
    // A bounded buffer is only an optimization. The host snapshot remains authoritative.
    const buffered = pending.get(batch.id) ?? []
    pending.set(batch.id, [...buffered.slice(-127), heard])
    const failure = failed.get(batch.id)
    if (!failure || failure.reconnecting) void hydrateLive(batch.id)
    return
  }
  if (batch.revision <= (current.revision ?? 0)) return
  const session = sessionAfter(current.session, batch)
  const blocks = reduceLiveUpdates(current.blocks, batch.updates)
  const history = current.history ? { ...current.history,
    blockEnd: batch.blockCount ?? current.history.blockStart + blocks.length } : undefined
  const base = batch.base === undefined ? (current.base ?? null) : batch.base
  const baseCoveredBlocks = batch.baseCoveredBlocks ?? current.baseCoveredBlocks
  const changedRequests = requestsAfter(current.requests, batch)
  const requests = changedRequests ?? current.requests
  const pendingPrompts = changedRequests || batch.control
    ? current.pendingPrompts?.filter(
        (prompt) => !requests?.some((request) => request.id === prompt.id) &&
          !(batch.control ?? current.control)?.transfers.some((transfer) => transfer.input.id === prompt.id)
      )
    : current.pendingPrompts
  replaceAcpConversation(batch.id, {
    ...current,
    control: batch.control ?? current.control,
    nativeAgents: batch.nativeAgents ? reconcileRoster(current.nativeAgents, batch.nativeAgents) : current.nativeAgents,
    goal: batchGoal(batch, current),
    side: batchSide(batch, current),
    historyFailure: batchHistoryFailure(batch, current),
    harnessTurns: batch.harnessTurns ?? current.harnessTurns,
    spentThrough: batch.spentThrough === undefined ? current.spentThrough : (batch.spentThrough ?? undefined),
    nativePaths: batch.control
      ? batch.control.bindings.flatMap((binding) =>
          binding.path ? [binding.path] : []
        )
      : current.nativePaths,
    harness: session.harness,
    requests,
    promptedAt: promptedAfter(current.promptedAt, batch),
    pendingPrompts,
    blocks,
    history,
    session,
    revision: batch.revision,
    epoch: batch.epoch ?? current.epoch,
    activityAt: batch.activityAt ?? current.activityAt,
    nativeActivity: batchNativeActivity(batch, current),
    base,
    baseCoveredBlocks,
    threadPath:
      batch.threadPath === undefined
        ? current.threadPath
        : (batch.threadPath ?? undefined),
    sending: changesSession(batch) || (pendingPrompts?.length ?? 0) < (current.pendingPrompts?.length ?? 0)
      ? false : current.sending,
    canceling: session.status === "running" ? current.canceling : false,
    permission: batch.permissions
      ? (batch.permissions[0] ?? null)
      : current.permission,
    queued: changedRequests
      ? changedRequests.filter(
          (request) => request.status === "queued" || request.status === "held"
        )
      : current.queued,
    projection:
      requests === current.requests &&
      pendingPrompts === current.pendingPrompts &&
      blocks === current.blocks &&
      base === current.base &&
      baseCoveredBlocks === current.baseCoveredBlocks &&
      session.status === current.session.status &&
      session.harness === current.session.harness
        ? current.projection
        : acpStore.get().activeKey === batch.id
          ? projectLive(
              { blocks, base, baseCoveredBlocks, history, session, requests, releasedTurns: current.releasedTurns },
              current.projection,
              pendingPrompts
            )
          : undefined,
    updatedAt: Date.now(),
    failureSeen: carriedFailureSeen(current, session),
  })
  notifyCompletion(current.requests, changedRequests)
  const next = acpStore.get().conversations[batch.id]
  if (next && (batch.session ?? batch.sessionChanges)?.settings) acknowledgeComposerSettings(next)
  if (
    next?.kind === "live" &&
    (changesSession(batch) || batch.permissions || changedRequests || agentAsksMoved(current, next))
  )
    syncThreadStatus(next, current.session.status, current.threadPath)
  if (next?.kind === "live" && batch.nativeAgents) noteFinAsks(next)
}

/** An agent's ask raised or answered: a batch of control alone says it, and it's said to the person as an approval is. */
function agentAsksMoved(before: Pick<LiveAcpConversation, "control">, after: Pick<LiveAcpConversation, "control">): boolean {
  const ids = (conversation: Pick<LiveAcpConversation, "control">) => conversation.control?.asks?.map((ask) => ask.id).join() ?? ""
  return ids(before) !== ids(after)
}

function notifyCompletion(
  previous: LiveSnapshot["requests"] | undefined,
  next: LiveSnapshot["requests"] | undefined
): void {
  if (
    next?.some(
      (request) =>
        request.status === "completed" &&
        previous?.some(
          (old) => old.id === request.id && old.status === "dispatching"
        )
    )
  )
    playFeedback("complete")
}

/**
 * Conversations the account no longer lists here (another device's cloud conversation that went home with its Thread,
 * or ended): gone from the rail. The one on screen says so, rather than vanishing under the reader.
 */
export function unlistLive(ids: readonly string[]): void {
  const active = acpStore.get().activeKey
  for (const id of ids) {
    receiveLive(id, { from: "said", unlisted: true }, () => {
      pending.delete(id)
      mergedSince.delete(id)
      stuck.delete(id)
      removeAcpConversation(id)
    })
  }
  if (active && ids.includes(active))
    toast.info("That conversation left the cloud", { description: "It went back to the computer it came from, or it ended.", duration: ACTION_TOAST_MS })
}

/**
 * Conversations the account lists that this window hadn't (another device's in the cloud), or listed again as they
 * changed: in the rail, unopened. Never selected: one arriving while the person reads something else stays a row.
 */
export function listLive(summaries: LiveSummary[]): void {
  // Read as a reconnect: a conversation already here takes where it runs now and is read again there when it's opened.
  admitLiveSummaries(summaries, true)
  const active = acpStore.get().activeKey
  if (active && summaries.some((summary) => summary.session.id === active)) void hydrateLive(active)
}

export function hydrateLiveSummaries(
  summaries: LiveSummary[],
  reconnect = false
): void {
  admitLiveSummaries(summaries, reconnect)
  const active = acpStore.get().activeKey
  if (active && summaries.some((summary) => summary.session.id === active))
    void hydrateLive(active)
  if (reconnect) return
  const requested = globalThis.sessionStorage?.getItem(
    "mako:reload-conversation"
  )
  if (requested && requested !== "new" && !summaries.some((summary) => summary.session.id === requested) && !acpStore.get().activeKey) {
    // The selected conversation may belong to another host and therefore be
    // absent from this host's boot list. Its persisted route can restore it.
    acpStore.set({ activeKey: requested })
    void hydrateLive(requested).then(() => {
      if (acpStore.get().activeKey !== requested) return
      const restored = acpStore.get().conversations[requested]
      if (restored) threadsStore.set({ composerHarness: restored.harness })
      else acpStore.set({ activeKey: null })
    })
    return
  }
  const selected =
    summaries.find((summary) => summary.session.id === requested) ??
    summaries.toSorted((a, b) => b.createdAt - a.createdAt)[0]
  if (selected && requested !== "new" && !acpStore.get().activeKey) {
    acpStore.set({ activeKey: selected.session.id })
    threadsStore.set({ composerHarness: selected.session.harness })
    void hydrateLive(selected.session.id)
  }
}

/**
 * The host's summaries, each listed as a conversation this window holds: new ones unopened, ones it held updated, a
 * reconnect's read again. Boot and a reconnect select and open after; a listing selects nothing.
 */
function admitLiveSummaries(summaries: LiveSummary[], reconnect: boolean): void {
  for (const summary of summaries) {
    const said: Received = { from: "said", revision: summary.revision, ...(summary.epoch && { epoch: summary.epoch }) }
    receiveLive(summary.session.id, said, () => admitSummary(summary, reconnect))
  }
}

/** One summary of the host's, listed (`admitLiveSummaries`). */
function admitSummary(summary: LiveSummary, reconnect: boolean): void {
  const previous = acpStore.get().conversations[summary.session.id]
  if (previous?.hydrated && !reconnect) {
    // Opened here, it reads its owner's stream; its Fins still come from the list while this window holds no roster of them.
    if (previous.kind === "live" && summary.elsewhere !== undefined && previous.fins !== summary.fins)
      replaceAcpConversation(summary.session.id, { ...previous, fins: summary.fins, children: summary.children ?? previous.children })
    return
  }
  if (reconnect && previous?.kind === "live") {
    replaceAcpConversation(summary.session.id, {
      ...previous,
      session: summary.session,
      hasSessionQuestions: summary.hasSessionQuestions,
      hydrated: false,
      nativePaths: summary.nativePaths,
      elsewhere: summary.elsewhere ?? previous.elsewhere,
      elsewhereKind: summary.elsewhereKind ?? previous.elsewhereKind,
      order: summary.order ?? previous.order,
      waitingOn: summary.waitingOn,
      waitingFor: summary.waitingFor,
      threadTitle: summary.threadTitle,
      quietSince: summary.quietSince,
      cloudContinue: summary.cloudContinue,
      movedAt: summary.movedAt ?? previous.movedAt,
      rail: summary.rail,
      promptedAt: laterPrompt(summary.promptedAt, previous.promptedAt),
      threadId: summary.threadId ?? previous.threadId,
      sessionId: summary.sessionId ?? previous.sessionId,
      parent: summary.parent ?? previous.parent,
      children: summary.children,
      fins: summary.fins,
      // A summary carries no permission. Another device's asks come with its listing; this host's stays as this window
      // held it, and is read again below, since only a batch or a snapshot says whether it's still asked.
      permission: summary.elsewhere === undefined ? previous.permission : null,
      failureSeen: carriedFailureSeen(previous, summary.session),
    })
    // A turn that ended while this renderer was away is still an outcome:
    // the summary is the only word it gets, so the transition is read here
    // as a replay — recorded for the mark and the badge, never announced.
    // Only a turn's end is read this way; a permission the summary cannot
    // carry must not be taken for one that was answered.
    const restored = acpStore.get().conversations[summary.session.id]
    if (
      restored?.kind === "live" &&
      previous.session.status === "running" &&
      summary.session.status !== "running"
    )
      syncThreadStatus(restored, previous.session.status, previous.threadPath, "hydrate")
    // Another device's Session changed: what the change says (the account's own rule, read by the host) is told
    // here as it would be on any device, and an ask answered anywhere goes.
    if (restored?.kind === "live" && summary.elsewhere !== undefined) noteListedOutcome(previous, restored, summary.attention)
    else if (previous.permission) refreshListed(summary.session.id)
    return
  }
  replaceAcpConversation(summary.session.id, {
    kind: "live",
    key: summary.session.id,
    draftKey: summary.session.id,
    session: summary.session,
    hasSessionQuestions: summary.hasSessionQuestions,
    harness: summary.session.harness,
    cwd: summary.session.cwd,
    title: summary.session.title,
    nativePaths: summary.nativePaths,
    threadPath: summary.threadPath,
    elsewhere: summary.elsewhere,
    elsewhereKind: summary.elsewhereKind,
    order: summary.order,
    waitingOn: summary.waitingOn,
    waitingFor: summary.waitingFor,
    threadTitle: summary.threadTitle,
    quietSince: summary.quietSince,
    cloudContinue: summary.cloudContinue,
    movedAt: summary.movedAt,
    rail: summary.rail,
    promptedAt: summary.promptedAt,
    threadId: summary.threadId,
    sessionId: summary.sessionId,
    parent: summary.parent,
    children: summary.children,
    fins: summary.fins,
    revision: summary.revision,
    // Its numbers are its host start's: without the start, a newer one's would be read as the same.
    ...(summary.epoch && { epoch: summary.epoch }),
    hydrated: false,
    createdAt: summary.createdAt,
    updatedAt: summary.createdAt,
    blocks: [],
    queued: [],
    hiddenUserPrompt: null,
    permission: null,
    sending: false,
    canceling: false,
  })
  const restored = acpStore.get().conversations[summary.session.id]
  if (restored?.kind === "live")
    syncThreadStatus(restored, "starting", undefined, "hydrate")
}

export async function loadEarlierLive(id: string): Promise<void> {
  const release = transcriptReaders.protect(liveReadingSource(id), "*")
  try { await withLiveView(id, () => readEarlierLive(id)) }
  finally { release() }
}

/**
 * Makes the window name a view other than `dead`, one a read was just refused against: the reread in flight when
 * there is one, else the conversation read again over the window on screen. The view the window names afterwards, or
 * `undefined` when it couldn't take one.
 */
export async function renewLiveView(id: string, dead: string): Promise<string | undefined> {
  const named = () => {
    const held = acpStore.get().conversations[id]
    return held?.kind === "live" ? held.history?.token : undefined
  }
  await fetching.get(id)
  if (named() === dead) {
    const covers = windowStart(acpStore.get().conversations[id])
    await readLive(id, () => readLiveSnapshot(id), (snapshot) => applyLiveSnapshot(snapshot, undefined, covers))
  }
  const renewed = named()
  return renewed === dead ? undefined : renewed
}

/**
 * `attempt` reads against the window's view of conversation `id`. Refused because the host let the view go, or because
 * the native history moved under it, the window takes a current view and `attempt` runs once more; only a second
 * refusal reaches the person.
 */
export async function withLiveView<T>(id: string, attempt: () => Promise<T>): Promise<T> {
  const held = acpStore.get().conversations[id]
  const dead = held?.kind === "live" ? held.history?.token : undefined
  try { return await attempt() }
  catch (error) {
    if (!dead || !(error instanceof Error) || !isHistoryExpired(error) || !(await renewLiveView(id, dead))) throw error
    return await attempt()
  }
}

async function readEarlierLive(id: string): Promise<void> {
  const held = acpStore.get().conversations[id]
  if (held?.kind === "live" && held.history) {
    const before = held.history.before
    if (!before) return
    const page = await readLiveValue<LiveHistoryPage>(id, { kind: "earlier", token: held.history.token, before })
    const current = acpStore.get().conversations[id]
    if (current?.kind !== "live" || current.history?.token !== held.history.token ||
        current.history.before?.blocks !== before.blocks || current.history.before?.base !== before.base) return
    const next = prependLiveHistory({ ...current, base: current.base ?? null }, page)
    receiveLive(id, { from: "answer" }, () =>
      replaceAcpConversation(id, { ...next, projection: projectLive({ ...next, base: next.base ?? null }, undefined, next.pendingPrompts) }))
    return
  }
  await readLive(id, () => getMako().liveEarlier(id))
}

/** Losing a peer host affects only the conversations that it owns. */
export function markLiveOwnerDisconnected(ids: string[]): void {
  for (const id of ids) {
    const current = acpStore.get().conversations[id]
    if (current?.kind !== "live") continue
    receiveLive(id, { from: "said" }, () => replaceAcpConversation(id, {
      ...current,
      session: { ...current.session, connection: "disconnected" },
    }))
  }
}
