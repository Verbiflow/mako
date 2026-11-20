import type { Root } from "hast"
import type { ProseParseReply, ProseParseRequest } from "./parsed-markdown"
import { KeptResults } from "./kept-results"

interface Work {
  owner: string
  text: string
  receive(tree: Root | null): void
  canceled: boolean
  /** Parsed ahead of a turn's mounting (`warmProse`): it waits behind every piece that's streaming on screen. */
  ahead: boolean
  /** A whole answer that has settled, drawn as `parseSettledProse` draws it. */
  settled?: ProseParseRequest["settled"]
}
let worker: Worker | null = null
let unavailable = false
let active: Work | null = null
const queued = new Map<string, Work>()

export function requestProse(
  owner: string,
  text: string,
  receive: Work["receive"],
  ahead = false,
  settled?: Work["settled"]
): void {
  const work: Work = { owner, text, receive, canceled: false, ahead, settled }
  if (!globalThis.Worker || unavailable) {
    receive(null)
    return
  }
  queued.set(owner, work)
  pump()
}

export function cancelProse(owner: string): void {
  queued.delete(owner)
  if (active?.owner === owner) active.canceled = true
}

function pump(): void {
  if (active || unavailable) return
  let work = queued.values().next().value
  if (work?.ahead) for (const waiting of queued.values()) if (!waiting.ahead) { work = waiting; break }
  if (!work) return
  queued.delete(work.owner)
  active = work
  const channel = new MessageChannel()
  let completed = false
  const complete = (tree: Root | null) => {
    if (completed) return
    completed = true
    channel.port1.onmessage = null
    channel.port1.onmessageerror = null
    channel.port1.close()
    clearTimeout(timeout)
    if (worker) { worker.onerror = null; worker.onmessageerror = null }
    active = null
    if (!work.canceled) work.receive(tree)
    pump()
  }
  const failed = () => {
    unavailable = true
    worker?.terminate()
    worker = null
    complete(null)
    for (const pending of queued.values())
      if (!pending.canceled) pending.receive(null)
    queued.clear()
  }
  const timeout = setTimeout(failed, 30_000)
  channel.port1.onmessage = (event: MessageEvent<ProseParseReply>) =>
    complete(event.data.ok ? event.data.tree : null)
  channel.port1.onmessageerror = failed
  try {
    worker ??= new Worker(
      new URL("./prose-parser.worker.ts", import.meta.url),
      { type: "module" }
    )
    worker.onerror = (event) => {
      console.error("Markdown worker failed:", event.message)
      failed()
    }
    worker.onmessageerror = failed
    const request: ProseParseRequest = { text: work.text, settled: work.settled }
    worker.postMessage(request, [channel.port2])
  } catch (error) {
    console.error("Markdown worker could not start:", error)
    failed()
  }
}

/** Below this a parse on the page is a millisecond or two, and not worth a worker's round trip. */
export const WARM_PROSE_CHARS = 2_048
/** How many may wait at once: a reader scrolling fast leaves the turns they passed behind. */
const WARM_WAITING = 24
let warmed = 0

/**
 * Settled prose parsed before its turn mounts. A turn coming into the window (a row a reader is scrolling toward, a
 * turn drawn in an idle moment after an open) parsed its Markdown in the commit that mounted it, 1.2 ms per 1,000
 * characters with the page held; parsed here first, in the worker, the commit only builds elements from the tree.
 * Nothing waits on it: prose whose tree hasn't arrived is parsed on the page, as it always was.
 */
const warm = new KeptResults<Root>(
  (text) => new Promise((resolve) => requestProse(`ahead:${++warmed}`, text, resolve, true)),
  { entries: 64, weight: 1_500_000 }
)

/** Asks for each of `texts` to be parsed ahead, the first first. */
export function warmProse(texts: readonly string[]): void {
  if (!globalThis.Worker || unavailable) return
  for (const text of texts) {
    if (warm.pending >= WARM_WAITING) return
    if (text.length >= WARM_PROSE_CHARS && !warm.has(text)) void warm.want(text)
  }
}

/** The tree parsed ahead for `text`, if one is kept. Reads only: safe while rendering. */
export function warmedProse(text: string): Root | undefined {
  return text.length >= WARM_PROSE_CHARS ? warm.get(text) : undefined
}

/** `text` has been drawn and its elements are kept by what drew them: its tree isn't needed again. */
export function forgetWarmedProse(text: string): void {
  warm.drop(text)
}
