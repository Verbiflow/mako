import { getMako } from "@/lib/bridge"
import { acpStore, replaceAcpConversation } from "@/state/acp-state"
import { projectAcp, projectLive } from "@/state/live-projection"
import { responseText, type Exchange } from "@/lib/exchanges"
import type { LiveSnapshot, EntryBlock } from "@/lib/types"
import type { LiveHistoryRead, LiveHistoryAddress, LiveHistoryPage, LiveHistorySnapshot } from "../../electron/contracts/live-history"
import { LiveBlockSchema, type LiveBlock } from "../../electron/contracts/live-content"

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
      from: held?.history ? { blocks: held.history.blockStart, base: held.base?.start ?? 0 } : undefined }) }
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
  const details = new Map<string, LiveBlock | EntryBlock>()
  for (const block of held.blocks)
    if (block.type === "tool" && block.historyVersion && !block.historyRest) details.set(block.historyVersion, block)
  for (const entry of held.base?.entries ?? [])
    if (entry.kind === "assistant") for (const block of entry.blocks)
      if (block.type === "tool" && block.historyVersion && !block.contentOmitted && !block.attachmentsOmitted &&
          (block.outputLength ?? 0) <= (block.output?.length ?? 0)) details.set(block.historyVersion, block)
  if (!details.size) return snapshot
  const blocks = snapshot.blocks.map(block => {
    const retained = block.type === "tool" && block.historyRest && block.historyVersion ? details.get(block.historyVersion) : undefined
    return retained?.type === "tool" && "title" in retained ? retained : block
  })
  const base = snapshot.base ? { ...snapshot.base, entries: snapshot.base.entries.map(entry => entry.kind === "assistant"
    ? { ...entry, blocks: entry.blocks.map(block => {
      const retained = block.type === "tool" && block.historyVersion ? details.get(block.historyVersion) : undefined
      return retained?.type === "tool" && "name" in retained ? retained : block
    }) } : entry) } : null
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

export function loadLiveHistoryDetail(id: string, token: string, at: LiveHistoryAddress): Promise<void> {
  const key = JSON.stringify([id, token, at])
  const held = loading.get(key)
  if (held) return held
  const work = (async () => {
    const value = await readLiveValue<LiveBlock | EntryBlock>(id, { kind: "detail", token, at })
    const current = acpStore.get().conversations[id]
    if (current?.kind !== "live" || current.history?.token !== token) return
    if (at.kind === "live") {
      const local = at.index - current.history.blockStart
      const before = current.blocks[local]
      if (before?.type !== "tool" || !before.historyRest || value.type !== "tool") return
      // A later tool update owns the displayed version and clears historyRest.
      const blocks = current.blocks.slice()
      blocks[local] = LiveBlockSchema.parse(value)
      const next = { ...current, blocks }
      replaceAcpConversation(id, { ...next, projection: projectAcp(next) })
    } else {
      const base = current.base
      if (!base) return
      const local = at.entry - base.start
      const entry = base.entries[local]
      if (entry?.kind !== "assistant" || value.type !== "tool" || !("name" in value)) return
      const blocks = entry.blocks.slice()
      blocks[at.block] = value
      const entries = base.entries.slice()
      entries[local] = { ...entry, blocks }
      const next = { ...current, base: { ...base, entries } }
      replaceAcpConversation(id, { ...next, projection: projectAcp(next) })
    }
  })().finally(() => loading.delete(key))
  loading.set(key, work)
  return work
}
