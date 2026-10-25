import { getMako } from "@/lib/bridge"
import { acpStore, replaceAcpConversation } from "@/state/acp-state"
import { projectAcp, projectLive } from "@/state/live-projection"
import { responseText, type Exchange } from "@/lib/exchanges"
import type { LiveSnapshot } from "@/lib/types"
import type { LiveHistoryRead, LiveHistoryAddress, LiveHistoryPage, LiveHistorySnapshot } from "@mako/host/contracts/live-history"
import { liveReadingSource, transcriptReaders } from "@/state/transcript-reading"
import type { ReleasedTurn } from "@/state/transcript-residency"
import { EntrySchema, type Entry } from "@mako/sessions/entries"
import { locateShown, type ShownEntry } from "@/lib/entry-messages"
import type { EntryOriginal } from "@mako/sessions/record-original"
import { originalReading, type OriginalReading } from "@/state/thread-viewing"

/** Reassemble one explicitly requested value, validating part identity/order.
 * JSON is produced by the same typed host contract as the ordinary bridge. */
export async function readLiveValue<T>(id: string, input: LiveHistoryRead): Promise<T> {
  const bridge = getMako()
  let chunk = await bridge.liveRead(id, input)
  const record = chunk.record
  let offset = 0
  const pieces: string[] = []
  for (;;) {
    if (chunk.record !== record || chunk.offset !== offset || !chunk.data.length)
      throw new Error("The history response changed while it was loading. Try opening the conversation again.")
    pieces.push(chunk.data)
    offset += chunk.data.length
    if (chunk.next === null) {
      if (chunk.total !== offset) throw new Error("The history response ended before it was complete.")
      break
    }
    if (chunk.next !== offset) throw new Error("The history response skipped a part.")
    chunk = await bridge.liveRead(id, { kind: "part", record, offset })
  }
  // SAFETY: same trusted producer/consumer boundary as createMakoBridge; the framing
  // above proves complete delivery, and JSON.parse rejects malformed content.
  return JSON.parse(pieces.join("")) as T
}

export function readLiveSnapshot(id: string): Promise<LiveSnapshot | null>
export function readLiveSnapshot(id: string, conditional: true): Promise<LiveHistorySnapshot>
export async function readLiveSnapshot(id: string, conditional = false): Promise<LiveHistorySnapshot> {
  const bridge = getMako()
  if (Object.hasOwn(bridge, "liveRead")) {
    const held = acpStore.get().conversations[id]
    try { return await readLiveValue<LiveHistorySnapshot>(id, { kind: "snapshot", epoch: held?.epoch,
      ifCurrent: conditional && held?.hydrated && held.history && held.revision !== undefined
        ? { token: held.history.token, revision: held.revision } : undefined,
      from: held?.history ? { blocks: held.history.blockStart, base: held.base?.start ?? 0 }
        : transcriptReaders.rememberedWindow(liveReadingSource(id)) }) }
    catch (error) {
      // Existing hosts keep their old read API. A data/transport failure is
      // never a reason to silently retry an unbounded read.
      if (!(error instanceof Error) || !/Unknown Mako host method|requires a newer shared host/.test(error.message)) throw error
    }
  }
  return bridge.liveSnapshot(id)
}

const loading = new Map<string, Promise<void>>()

/** Reuse only host-proven immutable tool content; provider IDs/status alone
 * cannot prove that a later tool result has the same bytes. */
export function retainLiveDetails(snapshot: LiveSnapshot): LiveSnapshot {
  const held = acpStore.get().conversations[snapshot.session.id]
  if (!snapshot.history || held?.kind !== "live" || !held.history) return snapshot
  const live = new Map<string, Entry>()
  const saved = new Map<string, Entry>()
  for (const block of held.blocks)
    if (block.type === "tool" && block.historyVersion && !block.historyRest) live.set(block.historyVersion, block)
  for (const entry of held.base?.entries ?? [])
    if (entry.type === "tool" && entry.historyVersion && !entry.contentOmitted && !entry.attachmentsOmitted &&
        (entry.outputLength ?? 0) <= (entry.output?.length ?? 0)) saved.set(entry.historyVersion, entry)
  if (!live.size && !saved.size) return snapshot
  const blocks = snapshot.blocks.map(block => {
    const retained = block.type === "tool" && block.historyRest && block.historyVersion ? live.get(block.historyVersion) : undefined
    return retained?.type === "tool" ? retained : block
  })
  const base = snapshot.base ? { ...snapshot.base, entries: snapshot.base.entries.map(entry => {
    const retained = entry.type === "tool" && entry.historyVersion ? saved.get(entry.historyVersion) : undefined
    return retained?.type === "tool" ? retained : entry
  }) } : null
  return { ...snapshot, blocks, base }
}

/** Prepend content only. Historical control/receipt state is never authoritative. */
export function prependLiveHistory<T extends Pick<LiveSnapshot, "blocks" | "base" | "history">>(current: T, page: LiveHistoryPage): T {
  const before = current.history?.before
  if (!before || !page.history || page.history.token !== current.history?.token ||
      page.history.blockEnd !== before.blocks ||
      page.history.blockStart + page.blocks.length !== before.blocks ||
      (current.base && (!page.base || page.base.start + page.base.entries.length !== current.base.start)))
    throw new Error("The earlier history page did not match this conversation view.")
  const base = current.base && page.base ? {
    ...current.base, entries: [...page.base.entries, ...current.base.entries], start: page.base.start, hasEarlier: page.base.hasEarlier,
  } : current.base
  return { ...current, base, blocks: [...page.blocks, ...current.blocks],
    history: { ...current.history, blockStart: page.history.blockStart, turnStart: page.history.turnStart, before: page.history.before } }
}

/** A page can begin halfway through an answer. Copy reads its missing prefix
 * from the same captured view without moving the viewport or loading tool bodies. */
export async function completeLiveAnswer(id: string | undefined, exchange: Exchange): Promise<string> {
  const release = id ? transcriptReaders.protect(liveReadingSource(id), exchange.id) : () => {}
  try { return id ? await (await import("@/state/live-recovery")).withLiveView(id, () => readCompleteLiveAnswer(id, exchange)) : responseText(exchange) }
  finally { release() }
}

async function readCompleteLiveAnswer(id: string | undefined, exchange: Exchange): Promise<string> {
  const current = id ? acpStore.get().conversations[id] : undefined
  if (exchange.prompt || current?.kind !== "live" || !current.history?.before) return responseText(exchange)
  let view = { ...current, base: current.base ?? null }
  const following = projectAcp(current).exchanges[1]?.id
  let answer = exchange
  while (!answer.prompt && view.history?.before) {
    const page = await readLiveValue<LiveHistoryPage>(current.key, { kind: "earlier", token: view.history.token, before: view.history.before })
    view = prependLiveHistory(view, page)
    const exchanges = projectLive(view).exchanges
    const index = following ? exchanges.findIndex(item => item.id === following) - 1 : exchanges.length - 1
    const full = exchanges[index]
    if (!full) throw new Error("The complete answer could not be found in this history view.")
    answer = full
  }
  return responseText(answer)
}

/**
 * The bytes `entry` of live conversation `id` was read from, its record's
 * and the stream lines Mako recorded it from, read by its host from the
 * view this window holds, read again first for a live entry. A host from
 * before streams were read answers for the record alone, by the entry's id.
 */
export function readLiveOriginal(id: string, entry: ShownEntry, saved?: { path: string; id: string }): Promise<OriginalReading> {
  const live = (async () => {
    const { recaptureLive, withLiveView } = await import("@/state/live-recovery")
    if (entry.at.kind === "live") await recaptureLive(id)
    return withLiveView(id, () => {
      const held = acpStore.get().conversations[id]
      if (held?.kind !== "live" || !held.history) throw new Error("This conversation's history isn't open in this window.")
      const at = entry.at.kind === "live" ? { kind: "live" as const, index: locateShown(held.blocks, held.history.blockStart, entry.at.index, entry) } : entry.at
      return readLiveValue<EntryOriginal>(id, { kind: "original", token: held.history.token, at })
    })
  })()
  return originalReading(saved ? live.catch(() => getMako().threadOriginal(saved.path, saved.id)) : live)
}

const turnLoads = new Map<string, Promise<void>>()

/** Restore exactly the released coordinates from their immutable capture.
 * Controls and later streaming bytes always remain the current state's. */
export function loadReleasedLiveTurn(id: string, turnId: string): Promise<void> {
  const key = JSON.stringify([id, turnId])
  const loading = turnLoads.get(key)
  if (loading) return loading
  const work = (async () => {
    const release = transcriptReaders.protect(liveReadingSource(id), turnId)
    // A view the host let go is renewed and the turn read again from the new one; a renewal that read the whole
    // window back has brought the turn with it.
    try { await (await import("@/state/live-recovery")).withLiveView(id, () => restoreReleasedTurn(id, turnId)) }
    finally { release() }
  })().finally(() => turnLoads.delete(key))
  turnLoads.set(key, work)
  return work
}

async function restoreReleasedTurn(id: string, turnId: string): Promise<void> {
  const held = acpStore.get().conversations[id]
  const turn = held?.releasedTurns?.find(item => item.id === turnId)
  if (held?.kind !== "live" || !held.history || !turn) return
  const page = await readLiveValue<LiveHistoryPage>(id, { kind: "range", token: held.history.token,
    from: { blocks: turn.blocks.start, base: turn.base.start }, to: { blocks: turn.blocks.end, base: turn.base.end } })
  const current = acpStore.get().conversations[id]
  if (current?.kind !== "live" || current.history?.token !== held.history.token ||
      current.releasedTurns?.find(item => item.id === turnId) !== turn) return
  if (page.history.token !== held.history.token || page.history.blockStart !== turn.blocks.start ||
      page.history.blockEnd !== turn.blocks.end || page.blocks.length !== turn.blocks.end - turn.blocks.start ||
      (turn.base.end > turn.base.start && (!page.base || page.base.start !== turn.base.start ||
        page.base.entries.length !== turn.base.end - turn.base.start)))
    throw new Error("The reloaded turn did not match this conversation view.")
  const next = restoreTurn(current, turn, page)
  replaceAcpConversation(id, { ...next, projection: projectAcp(next) })
}

function restoreTurn<T extends { blocks: Entry[]; base?: LiveSnapshot["base"]; history?: LiveSnapshot["history"]; releasedTurns?: ReleasedTurn[] }>(
  current: T, turn: ReleasedTurn, page: LiveHistoryPage): T {
  const blocks = current.blocks.slice()
  blocks.splice(turn.blocks.start - current.history!.blockStart, page.blocks.length, ...page.blocks)
  const base = current.base && page.base ? { ...current.base, entries: current.base.entries.slice() } : current.base
  if (base && page.base) base.entries.splice(turn.base.start - base.start, page.base.entries.length, ...page.base.entries)
  return { ...current, blocks, base, releasedTurns: current.releasedTurns?.filter(item => item !== turn) }
}

export function loadLiveHistoryDetail(id: string, token: string, at: LiveHistoryAddress): Promise<void> {
  const key = JSON.stringify([id, token, at])
  const held = loading.get(key)
  if (held) return held
  const work = (async () => {
    const release = transcriptReaders.protect(liveReadingSource(id), "*")
    try {
    // The row names the view its preview came from; once the window took another, the window's is the one to read.
    let read = token
    const value = await (await import("@/state/live-recovery")).withLiveView(id, async () => {
      const held = acpStore.get().conversations[id]
      read = held?.kind === "live" && held.history ? held.history.token : token
      return EntrySchema.parse(await readLiveValue<Entry>(id, { kind: "detail", token: read, at }))
    })
    const current = acpStore.get().conversations[id]
    if (current?.kind !== "live" || current.history?.token !== read) return
    if (at.kind === "live") {
      const local = at.index - current.history.blockStart
      const before = current.blocks[local]
      if (before?.type !== "tool" || !before.historyRest || value.type !== "tool") return
      // A later tool update owns the displayed version and clears historyRest.
      const blocks = current.blocks.slice()
      blocks[local] = value
      const next = { ...current, blocks }
      replaceAcpConversation(id, { ...next, projection: projectAcp(next) })
    } else {
      const base = current.base
      if (!base) return
      const local = base.entries.findIndex(entry => entry.id === at.id)
      if (local < 0 || base.entries[local]!.type !== value.type) return
      const entries = base.entries.slice()
      entries[local] = value
      const next = { ...current, base: { ...base, entries } }
      replaceAcpConversation(id, { ...next, projection: projectAcp(next) })
    }
    } finally { release() }
  })().finally(() => loading.delete(key))
  loading.set(key, work)
  return work
}
