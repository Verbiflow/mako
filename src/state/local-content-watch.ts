import { getMako, hasBridge } from "@/lib/bridge"
import { acpStore } from "@/state/acp-state"
import { transcriptReaders, liveReadingSource } from "@/state/transcript-reading"
import { liveContentReaders, watchLiveContentReaders } from "@/state/live-content-readers"
import { LOCAL_CONTENT_LIMIT } from "@mako/host/contracts/local-content-watch"
import { RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"

/** Every retained body is a reader, even off screen. Detail/copy operations have their own leases. */
export function localContentUnion(): string[] | null {
  const ids = liveContentReaders()
  for (const conversation of Object.values(acpStore.get().conversations))
    if (conversation.hydrated) ids.add(conversation.key)
  // A bound cannot silently omit a reader. Too many readers opts this stream back into full delivery.
  return ids.size > LOCAL_CONTENT_LIMIT ? null : [...ids].sort()
}

let epoch = 0
let last: { ids: string[] | null; generation: string | null } | undefined
let sending: Promise<unknown> = Promise.resolve()
let scheduled = false

/** Serialized full-set replacement: an old asynchronous removal cannot overtake a later promotion. */
export function syncLocalContent(): Promise<string | null> {
  const send = async () => {
    const watch = hasBridge() ? getMako().watchLiveContent : undefined
    if (!watch) return null
    const ids = localContentUnion()
    const previous = last
    if (previous && (ids === null ? previous.ids === null : previous.ids !== null &&
      ids.length === previous.ids.length && ids.every((id, index) => previous.ids?.[index] === id))) return previous.generation
    const started = epoch
    const generation = await watch(ids)
    if (started !== epoch) throw new RuntimeDisconnectedError(false)
    last = { ids, generation }
    return generation
  }
  const result = sending.then(send, send)
  sending = result
  return result
}

function changed(): void {
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    // Failure leaves the previous (or full) delivery in place. A content read awaits and reports its own failure.
    void syncLocalContent().catch(() => {})
  })
}

/** In-flight snapshots from the old connection cannot establish a new connection's content view. */
export function resetLocalContent(): void {
  epoch++
  last = undefined
  changed()
}

export function watchLocalContent(): () => void {
  if (!hasBridge() || !getMako().watchLiveContent) return () => {}
  const release = watchLiveContentReaders(changed)
  changed()
  return () => { release(); resetLocalContent() }
}

/** Interest is acknowledged before the existing guarded snapshot/page read; its lease lasts through all parts. */
export async function withLocalContent<T>(id: string, read: () => Promise<T>): Promise<T> {
  if (!hasBridge() || !getMako().watchLiveContent) return read()
  const release = transcriptReaders.protect(liveReadingSource(id), "*")
  const started = epoch
  try {
    await syncLocalContent()
    if (started !== epoch) throw new RuntimeDisconnectedError(false)
    const result = await read()
    if (started !== epoch) throw new RuntimeDisconnectedError(false)
    return result
  } finally { release() }
}
