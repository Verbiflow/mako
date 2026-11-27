import { Slot } from "@/extend/slot"
import { quietly } from "@/lib/quiet-retry"
import { elementScroll, measureElement, useVirtualizer, type Virtualizer } from "@tanstack/react-virtual"
import { useRowRef } from "@/lib/virtual-row-ref"
import { registerCommands } from "@/extend/commands"
import {
  TranscriptSourceContext,
  type TranscriptSource,
} from "./source-context"
import { flushSync } from "react-dom"
import type { ReactNode, Ref, WheelEvent as ReactWheelEvent, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from "react"
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Exchange } from "@/components/transcript/exchange"
import { ReportRun } from "@/components/transcript/report-run"
import { FailedRequestsContext } from "@/components/transcript/failed-requests"
import { foldReportRuns } from "@/lib/report-runs"
import {
  NAVIGATOR_WIDTH,
  TurnNavigator,
} from "@/components/transcript/turn-navigator"
import { useNavigatorPrompts } from "@/components/transcript/navigator-prompts"
import {
  exchangeRequests,
  LEAD_EXCHANGE_ID,
  arrivedSince,
  continuedFrom,
  endOf,
  type LeftAt,
  isInterruptedNote,
  renamedExchanges,
  drawnProse,
  turnRequest,
  type Exchange as ExchangeData,
} from "@/lib/exchanges"
import type { CarriedHistory, MakoPrompt, TurnStop } from "@/state/prompt-delivery"
import { cn } from "@/lib/utils"
import { ArrowDownIcon } from "lucide-react"
import { Orb } from "@/components/ui/orb/orb"
import { liveReadingSource, nativeReadingSource, transcriptReaders, type TranscriptReading, type TranscriptPreviewIdentity } from "@/state/transcript-reading"
import { loadReleasedLiveTurn } from "@/state/live-history"
import { loadReleasedThreadTurn } from "@/state/thread-viewing"
import { TranscriptPaneContext } from "@/state/conversation-scope"
import { SCROLL_WRITE_EVENT, TRANSCRIPT_END_EVENT, TranscriptEndContext } from "./transcript-end"
import { READER_SCROLL_EVENT } from "@/lib/reader-scroll"
import { CompactPresentationContext } from "./compact-presentation"
import { rowChecker } from "./row-check"
import { warmSettledProse } from "./settled-prose"
import { wokeAfterRest, type WokeAfterRest } from "@/lib/woke-after-rest"
import { keptEntries } from "@/lib/kept-entries"
import { RowHeights, estimateRow, sameFacts, type KeptRow, type RowFacts } from "@/lib/row-heights"

const NEAR_BOTTOM = 96
/** How far below the pane's top a message just sent is placed (`sentTurn`). */
const SENT_TOP = 24
/**
 * How far a reader moves to mean it. Fingers resting on a trackpad send a few pixels each way, which is no leaving the
 * end; a flick passes this in a few events, a wheel's notch in one. Short of the 60 px a slow move up is kept at.
 */
const LEFT_END = 24
/**
 * What a wheel adds up over: its travel in the direction it's going now, since it last turned, so jitter starts over
 * at each turn and only a move in one direction reaches `LEFT_END`. Not its net: a reader who wheeled up and then
 * the same way back down had a net of nothing, read as fingers at rest, and the end they came back to wasn't followed.
 */
const WHEEL_WINDOW_MS = 500
/** A reader's input has ended this long after it last moved anything, for what no `scrollend` follows: input that moved nothing, or a browser without it. */
const INPUT_SETTLE_MS = 160
/** The longest a crossing into a window waits for the reader's input to settle (`sized`): one who never stops still crosses. */
const CROSSING_WAIT_MS = 2000
const TEXT_BLOCKS = "p,pre,li,td,h1,h2,h3,h4,h5,h6"
const PREVIEW_ATTRIBUTES = {
  file: "data-inline-file-preview",
  document: "data-inline-document",
  code: "data-inline-code",
  tool: "data-transcript-tool",
} as const
const INLINE_FLOW_BOXES = "[data-inline-file-preview],[data-inline-document],[data-inline-code],[data-transcript-tool],[data-asset-collection],.mako-prose,.plan-frame,[data-collapse]"

/**
 * How far above the scrollport earlier history starts arriving. Far enough
 * that a reader scrolling at a steady pace never meets the edge; near enough
 * that a session opened at its end loads nothing it will not show.
 */
const LOAD_AHEAD = 720

/**
 * How many turns are mounted when a session opens, and how many more each
 * reveal adds as the reader nears the top. Thirty covers more than a
 * screenful while avoiding hundreds of synchronous Markdown parses for a
 * large session.
 */
const INITIAL_TURNS = 30
const MORE_TURNS = 30
/**
 * How many of those turns are drawn in the commit that opens a conversation, before the pane has been measured, and
 * how many more each idle moment after it adds. Thirty turns parsed and rendered in the click was most of what an open
 * cost, for a pane that shows two or three of them: the rest fill in above the reader while nothing else wants the
 * page, and all at once the moment the reader moves (`drawAll`). Before the first paint the count is raised until the pane is covered with a pane's worth to spare
 * (`layOutEnd`), so the newest turn paints at the end and what mounts above it afterwards moves nothing.
 */
const FIRST_TURNS = 6
const IDLE_TURNS = 2
/** How many turns past the mounted rows of a window have their answers parsed ahead (`warmSettledProse`), each way. */
const PARSED_AHEAD = 4

/**
 * Past either, only the turns near the viewport mount. A session of few prompts can hold thousands of tool calls,
 * so the turn count alone would mount every one of them.
 */
const WINDOWED_TURNS = 40
const WINDOWED_ITEMS = 120

/**
 * What each windowed transcript's rows measured, by row key, at the window's width (`RowHeights`): for the window's
 * life, and across a reload. Opened again, the virtualizer starts from these as its own measurements (`seedMeasured`),
 * so its rows are placed at those sizes in the first frame: its measurements arrive a frame after it paints, and
 * placed at the estimate the newest turn painted, then jumped as they landed. They can't be its estimates: a row
 * measured at its estimate is never stored, so when the estimate moved every such row moved with it, and no resize
 * said so. A row that no longer holds what it held when it was measured (`rowFacts`) is measured again.
 */
type RowSizes = Virtualizer<HTMLDivElement, Element>["itemSizeCache"]
type RowKey = RowSizes extends Map<infer Key, number> ? Key : never
/** The window's storage, where it has one it may use: a page refused it keeps its sizes for its own life only. */
function windowStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
const rowHeights = new RowHeights(windowStorage())
/** The window's width, which the sizes are kept by; none where a transcript is drawn without a window (a test's render). */
const windowWidth = () => globalThis.innerWidth ?? 0
/** A turn nothing can be told about (a released one) stands at this until it's measured. */
const ESTIMATED_ROW = 360
/** The column's `gap-7` between turns, kept by the virtualizer between windowed rows. */
const ROW_GAP = 28
/** A row can grow with nothing in the document changing (an image's size, a font): how long that can go unseen. */
const ROW_CHECK_MS = 1_000
/** How often, at most, a transcript's measured rows are kept while it's read, and how soon after they're written. */
const KEEP_ROWS_MS = 2_000

/** What a turn's height comes from, read once for the turn as it stands. */
const turnFacts = new WeakMap<ExchangeData, RowFacts>()
function rowFacts(exchange: ExchangeData): RowFacts {
  let facts = turnFacts.get(exchange)
  if (!facts) {
    // A run is its one line while closed, whatever its turns hold: its label is all its estimate reads.
    facts = { chars: exchange.run?.label.length ?? 0, lines: 0, tools: 0 }
    for (const message of exchange.prompt ? [exchange.prompt, ...exchange.response] : exchange.response)
      for (const block of message.blocks) {
        if (block.type === "toolCall") facts.tools += 1
        else if (block.type === "text") {
          facts.chars += block.text.length
          for (let at = block.text.indexOf("\n"); at >= 0; at = block.text.indexOf("\n", at + 1)) facts.lines += 1
        }
      }
    turnFacts.set(exchange, facts)
  }
  return facts
}

let savingRows: ReturnType<typeof setTimeout> | undefined

function keepMeasured(source: string, sizes: RowSizes, exchanges: readonly ExchangeData[], keyOf: (index: number) => RowKey): void {
  const rows = new Map<string, KeptRow>()
  for (let index = 0; index < exchanges.length; index += 1) {
    const exchange = exchanges[index]!
    const size = exchange.unloaded === undefined ? sizes.get(keyOf(index)) : undefined
    if (size !== undefined) rows.set(String(keyOf(index)), { size, ...rowFacts(exchange) })
  }
  rowHeights.keep(source, windowWidth(), rows)
  savingRows ??= setTimeout(() => {
    savingRows = undefined
    rowHeights.save()
  }, KEEP_ROWS_MS)
}

/** Each row kept at this width that still holds what it held stands at its size; one that changed is measured again. */
function seedMeasured(source: string, sizes: RowSizes, exchanges: readonly ExchangeData[], keyOf: (index: number) => RowKey): void {
  const kept = rowHeights.kept(source, windowWidth())
  if (!kept) return
  for (let index = 0; index < exchanges.length; index += 1) {
    // A released turn holds nothing to compare: its placeholder stands at the height its row last had.
    if (exchanges[index]!.unloaded !== undefined) continue
    const key = keyOf(index)
    const row = kept.get(String(key))
    if (!row) continue
    if (!sameFacts(row, rowFacts(exchanges[index]!))) sizes.delete(key)
    else if (!sizes.has(key)) sizes.set(key, row.size)
  }
}

/** A turn's messages and calls, counted once for the turn as it stands: a settled turn is the same object in every frame. */
const turnItemCounts = new WeakMap<ExchangeData, number>()

/** Whether the turns hold more than `WINDOWED_ITEMS` messages and calls, counting no further than it takes to say so. */
function pastWindowedItems(exchanges: readonly ExchangeData[]): boolean {
  let items = 0
  for (const exchange of exchanges) {
    let count = turnItemCounts.get(exchange)
    if (count === undefined) {
      count = exchange.system.length + exchange.response.reduce((blocks, message) => blocks + message.blocks.length, 0)
      turnItemCounts.set(exchange, count)
    }
    items += count
    if (items > WINDOWED_ITEMS) return true
  }
  return false
}

/** When the page next has nothing to do, or its next task where a browser has no idle callback (WebKit). */
function whenIdle(work: () => void): () => void {
  if ("requestIdleCallback" in globalThis) {
    const idle = requestIdleCallback(work, { timeout: 200 })
    return () => cancelIdleCallback(idle)
  }
  const timer = setTimeout(work, 32)
  return () => clearTimeout(timer)
}

const NO_WOKE: ReadonlyMap<string, WokeAfterRest> = new Map()
const NO_KEYS: ReadonlyMap<string, string> = new Map()
const NO_RENAMES: ReadonlyMap<string, string> = new Map()

/**
 * The keys of turns that were renamed, by their current id; every other turn
 * is keyed by its id. A key belongs to one turn: a turn whose own id is
 * another's inherited key keeps it, and the other goes by its id.
 */
function turnKeys(
  previous: ReadonlyMap<string, string>,
  exchanges: readonly ExchangeData[],
  renamed: ReadonlyMap<string, string>
): ReadonlyMap<string, string> {
  if (previous.size === 0 && renamed.size === 0) return NO_KEYS
  const keys = new Map<string, string>()
  for (const [old, next] of renamed) keys.set(next, previous.get(old) ?? old)
  for (const exchange of exchanges) {
    const key = previous.get(exchange.id)
    if (key && !keys.has(exchange.id)) keys.set(exchange.id, key)
  }
  const own = new Set(
    exchanges.filter((exchange) => !keys.has(exchange.id)).map((exchange) => exchange.id)
  )
  for (const [id, key] of keys) if (own.has(key)) keys.delete(id)
  return keys.size === 0 ? NO_KEYS : keys
}

interface ScrollAnchor {
  exchangeId?: string
  exchangeOffset?: number
  /** Text and previews hold a position inside a turn, not just between turns. */
  block?: { element: Element; offset: number; preview?: TranscriptPreviewIdentity }
  scrollHeight: number
  scrollTop: number
  shown: number
  hasEarlier: boolean
  /** The first mounted exchange as it was, so a page can be told from a token. */
  head: string
}

/**
 * What a request for earlier history would change: the first mounted exchange
 * and how much it holds. History arrives above it or inside it (the lead
 * exchange grows at its top); tokens streaming below leave it as it is.
 */
function headOf(shown: ExchangeData[]): string {
  const first = shown[0]
  return first
    ? `${first.id}:${first.response.length}:${first.system.length}`
    : ""
}

function previewSelector(preview: TranscriptPreviewIdentity) {
  return `[${PREVIEW_ATTRIBUTES[preview.type ?? "file"]}="${CSS.escape(preview.path)}"]`
}

function previewIdentity(element: Element): TranscriptPreviewIdentity | undefined {
  const turn = element.closest("[data-exchange]")
  if (!turn) return undefined
  for (const type of ["file", "document", "code", "tool"] as const) {
    const path = element.getAttribute(PREVIEW_ATTRIBUTES[type])
    if (path === null) continue
    const preview = { type, path, index: 0 }
    const matches = turn.querySelectorAll(previewSelector(preview))
    return { ...preview, index: Array.from(matches).indexOf(element) }
  }
  return undefined
}

function readingBlockAt(element: Element | null) {
  // Loading/error paragraphs disappear when the preview body is replaced.
  // The owner survives those states and gallery remounts.
  return element?.closest("[data-inline-code]") ??
    element?.closest("[data-inline-file-preview],[data-inline-document]") ??
    element?.closest(TEXT_BLOCKS) ?? element?.closest("[data-transcript-tool]")
}

/**
 * The reading position, as painted text or media and its turn (or the turn
 * given), with their offsets from the scrollport. A lead exchange's top
 * moves when earlier history lands inside it; its painted paragraph can
 * still anchor the reader, including a bookmark in a partial answer.
 */
function captureAnchor(
  node: HTMLDivElement,
  shown: ExchangeData[],
  hasEarlier: boolean,
  at?: Element
): ScrollAnchor {
  const viewport = node.getBoundingClientRect()
  const viewportTop = viewport.top
  const painted = document.elementFromPoint(
    viewport.left + viewport.width / 2,
    viewport.top + viewport.height / 2
  )
  const blockAt = (y: number) =>
    readingBlockAt(document.elementFromPoint(viewport.left + viewport.width / 2, y))
  let block = readingBlockAt(painted)
  // The middle of the pane can land in a margin. Nearby painted content is
  // a better anchor than the container of an entire long answer.
  for (
    let offset = 8;
    !block && offset <= Math.min(48, viewport.height / 2);
    offset += 8
  )
    block = blockAt(viewport.top + viewport.height / 2 + offset) ??
      blockAt(viewport.top + viewport.height / 2 - offset)
  // Audio players and short prompt bubbles need not reach the center line.
  // If that line hit whitespace, find the visible content at the same height
  // within the painted turn rather than falling back to the whole turn.
  const paintedTurn = painted?.closest("[data-exchange]")
  if (!block && paintedTurn && node.contains(paintedTurn)) {
    const x = viewport.left + viewport.width / 2
    const y = viewport.top + viewport.height / 2
    const selectors = [...Object.values(PREVIEW_ATTRIBUTES).map(attribute => `[${attribute}]`), TEXT_BLOCKS].join(",")
    const candidates = Array.from(paintedTurn.querySelectorAll(selectors)).flatMap(element => {
      if (element.closest("[inert]") || !element.checkVisibility({ contentVisibilityAuto: true })) return []
      const rect = element.getBoundingClientRect()
      return rect.width > 1 && rect.top <= y && rect.bottom > y && rect.right > viewport.left && rect.left < viewport.right
        ? [{ element, distance: Math.max(rect.left - x, x - rect.right, 0) }] : []
    }).sort((left, right) => left.distance - right.distance)
    block = readingBlockAt(candidates[0]?.element ?? null)
  }
  const visibleTurn = (block ?? painted)?.closest("[data-exchange]")
  const anchor =
    at ??
    (visibleTurn && node.contains(visibleTurn) &&
      (visibleTurn.getAttribute("data-exchange") !== LEAD_EXCHANGE_ID || !!block)
      ? visibleTurn
      : undefined) ??
    Array.from(node.querySelectorAll("[data-exchange]")).find(
      (element) =>
        element.getAttribute("data-exchange") !== LEAD_EXCHANGE_ID &&
        element.getBoundingClientRect().bottom > viewportTop + 1
    )
  const readingBlock = !at && block && anchor?.contains(block)
    ? block
    : undefined
  return {
    exchangeId: anchor?.getAttribute("data-exchange") ?? undefined,
    exchangeOffset: anchor
      ? anchor.getBoundingClientRect().top - viewportTop
      : undefined,
    block: readingBlock
      ? {
          element: readingBlock,
          offset: readingBlock.getBoundingClientRect().top - viewportTop,
          preview: previewIdentity(readingBlock),
        }
      : undefined,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
    shown: shown.length,
    hasEarlier,
    head: headOf(shown),
  }
}

/**
 * Lay the newest turns out for real before scrolling to the end. A turn that
 * has just mounted has no remembered size, so `content-visibility: auto`
 * measures it at its placeholder height, and the end of a column of
 * placeholders is somewhere among the first turns. The turns that fill the
 * pane render in full until the frame after the first paint has recorded
 * their sizes; `contain-intrinsic-size: auto` keeps them from then on.
 */
function layOutEnd(node: HTMLDivElement) {
  const turns = node.querySelectorAll<HTMLElement>("[data-exchange]")
  const settling: HTMLElement[] = []
  let covered = 0
  for (
    let index = turns.length - 1;
    index >= 0 && covered < node.clientHeight;
    index -= 1
  ) {
    const turn = turns[index]!
    turn.setAttribute("data-settling", "")
    settling.push(turn)
    covered += turn.offsetHeight
  }
  let frame = requestAnimationFrame(() => {
    frame = requestAnimationFrame(() => {
      for (const turn of settling) turn.removeAttribute("data-settling")
    })
  })
  return {
    release: () => {
      cancelAnimationFrame(frame)
      for (const turn of settling) turn.removeAttribute("data-settling")
    },
    // The turns mounted above the ones that fill the pane, or fewer than none while those don't fill it yet.
    spare: covered < node.clientHeight ? -1 : turns.length - settling.length,
  }
}

function holdPrependedHeights(node: HTMLDivElement, exchangeId?: string) {
  if (!exchangeId) return
  for (const element of node.querySelectorAll("[data-exchange]")) {
    if (element.getAttribute("data-exchange") === exchangeId) break
    element.setAttribute("data-preserve-height", "")
  }
}

/**
 * Whether the scroller moved toward earlier turns since `from`. Past the end
 * counts as the end: iOS bounces a scroller back from beyond it, which is no
 * move away from the newest turn.
 */
function leftEnd(node: HTMLDivElement, from: number): boolean {
  const end = node.scrollHeight - node.clientHeight
  return Math.min(node.scrollTop, end) < Math.min(from, end) - 0.5
}

/** How far `travel` went in the direction of its last step, back to the step before it that went the other way. */
function wheelRun(travel: readonly { by: number }[]): number {
  let run = 0
  for (let index = travel.length - 1; index >= 0; index -= 1) {
    const { by } = travel[index]!
    if (run !== 0 && Math.sign(by) === -Math.sign(run)) break
    run += by
  }
  return run
}

/** `event` added to a wheel's `travel`, what went past `WHEEL_WINDOW_MS` dropped, and how far it has gone since it last turned, in pixels. */
function wheelNet(travel: { at: number; by: number }[], event: ReactWheelEvent, pageHeight: number): number {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pageHeight : 1
  const at = performance.now()
  travel.push({ at, by: event.deltaY * unit })
  while (travel[0]!.at < at - WHEEL_WINDOW_MS) travel.shift()
  return wheelRun(travel)
}

/** Whether the wheel's last half second came to nothing a reader meant, as fingers at rest do. */
function wheelResting(travel: readonly { at: number; by: number }[], now: number): boolean {
  const recent = travel.filter((step) => step.at >= now - WHEEL_WINDOW_MS)
  return recent.length > 0 && Math.abs(wheelRun(recent)) < LEFT_END
}

/** Whether a wheel over `target` moves a scroller inside the transcript rather than the transcript. */
function wheelTakenInside(target: EventTarget, viewport: HTMLElement, deltaY: number): boolean {
  for (let node = target instanceof Element ? target : null; node && node !== viewport; node = node.parentElement) {
    const room = node.scrollHeight - node.clientHeight
    if (room <= 1 || (deltaY < 0 ? node.scrollTop <= 0 : node.scrollTop >= room - 1)) continue
    const { overflowY } = getComputedStyle(node)
    if (overflowY === "auto" || overflowY === "scroll") return true
  }
  return false
}

/** The offset needed to put the captured content back at its recorded place. */
function scrollAnchorShift(node: HTMLDivElement, snapshot: ScrollAnchor): number {
  const block = snapshot.block
  const anchor = snapshot.exchangeId
    ? node.querySelector(`[data-exchange="${CSS.escape(snapshot.exchangeId)}"]`)
    : null
  // A preview can remount when a file resolves, reloads, or leaves its gallery.
  // Its conversation path survives that replacement; the old DOM node doesn't.
  const element = block?.element.isConnected && node.contains(block.element) ? block.element
    : block?.preview ? anchor?.querySelectorAll(previewSelector(block.preview))[block.preview.index] : undefined
  let shift: number
  if (block && element) {
    shift = element.getBoundingClientRect().top - node.getBoundingClientRect().top - block.offset
    block.element = element
  } else if (anchor && snapshot.exchangeOffset !== undefined) {
    shift = anchor.getBoundingClientRect().top - node.getBoundingClientRect().top - snapshot.exchangeOffset
  } else {
    shift = snapshot.scrollTop + (node.scrollHeight - snapshot.scrollHeight) - node.scrollTop
  }
  return shift
}

/**
 * Moves the scroller so the captured content is where it was, and says whether
 * it had to. Content already within a pixel of its place is left alone: a
 * shift under a pixel is the layout's rounding, not the content moving.
 */
function preserveScrollAnchor(node: HTMLDivElement, snapshot: ScrollAnchor): boolean {
  const shift = scrollAnchorShift(node, snapshot)
  if (Math.abs(shift) < 1) return false
  node.scrollTop += shift
  return true
}

type HistoryEdgeState = "loading" | "more" | "start"

/**
 * The top of the transcript. It holds one row's height in every state so the
 * turns below never shift: quiet while more history waits out of view,
 * "Loading earlier turns…" while a page is fetched, and the beginning of the
 * conversation once there is nothing above.
 */
function HistoryEdge({
  state,
  opening,
  ref,
}: {
  state: HistoryEdgeState
  opening?: ReactNode
  ref?: Ref<HTMLDivElement>
}) {
  return (
    <div
      ref={ref}
      data-earlier={state}
      role={state === "loading" ? "status" : undefined}
      className="flex h-7 shrink-0 items-center gap-3 text-label text-faint"
    >
      {state === "loading" ? (
        <span className="animate-enter mx-auto flex items-center gap-2">
          <Orb state="breathing" size={20} />
          <span>Loading earlier turns…</span>
        </span>
      ) : state === "start" && opening ? (
        opening
      ) : state === "start" ? (
        <>
          <span aria-hidden className="h-px min-w-0 flex-1 bg-hairline" />
          <span className="animate-enter shrink-0">
            Beginning of conversation
          </span>
          <span aria-hidden className="h-px min-w-0 flex-1 bg-hairline" />
        </>
      ) : null}
    </div>
  )
}

function ReleasedExchange({ id, label, height, viewport, load }: {
  id: string; label: string; height: number; viewport: HTMLDivElement | null; load: () => Promise<void>
}) {
  const element = useRef<HTMLElement>(null)
  const [failed, setFailed] = useState(false)
  const fetch = useCallback(() => {
    setFailed(false)
    // Asked again once by itself; still failing, the row offers to load it again, and the host's words go to its log.
    void quietly("an earlier turn", load).catch(error => {
      setFailed(true)
      console.warn(`An earlier turn didn't load ${JSON.stringify({ error: error instanceof Error ? error.message : String(error) })}`)
    })
  }, [load])
  useEffect(() => {
    const node = element.current
    if (!node || !viewport || failed) return
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      fetch()
    }, { root: viewport, rootMargin: `${LOAD_AHEAD}px 0px`, threshold: 0 })
    observer.observe(node)
    return () => observer.disconnect()
  }, [viewport, fetch, failed])
  return (
    <article ref={element} data-exchange={id} data-unloaded className="scroll-mt-6" style={{ height: Math.max(28, height) }}>
      <button type="button" className="pressable text-ui text-faint" onClick={fetch}>
        {failed ? "Try loading this turn again" : "Loading turn…"}
      </button>
      <span className="sr-only">{label}</span>
    </article>
  )
}

/**
 * The provider-neutral conversation scroller. It follows a stream only while
 * the reader is already at the bottom, loads earlier history as the reader
 * nears the top, and preserves their place when those turns are prepended.
 */
export function ConversationTimeline({
  source = {},
  identity,
  exchanges: turns,
  streamingId,
  interruptedId,
  interruptedRequests,
  makoPrompts,
  carriedHistories,
  askedAt,
  sentId,
  failedId,
  empty,
  footer,
  beside,
  opening,
  hasEarlier = false,
  loadingEarlier = false,
  onLoadEarlier,
  entrance = true,
}: {
  source?: TranscriptSource
  identity: string
  exchanges: ExchangeData[]
  streamingId?: string
  interruptedId?: string
  /** Turns cut short, by request id, with the reason and whether the newest may be continued. */
  interruptedRequests?: ReadonlyMap<string, TurnStop>
  /** Prompts Mako sent itself, by request id, shown as Mako's line. */
  makoPrompts?: ReadonlyMap<string, MakoPrompt>
  /** The history each request carried to a new session (`carriedHistories`), drawn above its words. */
  carriedHistories?: ReadonlyMap<string, CarriedHistory>
  /** When each request was sent, by request id: a live prompt's time, which its blocks don't carry. */
  askedAt?: ReadonlyMap<string, number>
  /** The turn the person's newest message opened, by its id: arriving at the end, it's placed near the top (`sentTurn`). */
  sentId?: string
  failedId?: string
  empty: ReactNode
  footer?: ReactNode
  /** What stands beside "Jump to latest" while the reader is away from the end: the conversation's activity pill. */
  beside?: ReactNode
  /** The transcript's first line in place of "Beginning of conversation", once its start is on screen. */
  opening?: ReactNode
  hasEarlier?: boolean
  loadingEarlier?: boolean
  onLoadEarlier?: () => Promise<void>
  /**
   * Whether a new identity arrives with the thread transition. A conversation
   * that continues in place — the same turns, now live — passes false so the
   * transcript the reader is looking at does not re-enter.
   */
  entrance?: boolean
}) {
  "use no memo"
  /**
   * The turns as the transcript draws them, each run of report turns as one (`foldReportRuns`). A turn that streams,
   * was cut short, failed or ends on its failure row stands as itself, as does a prompt Mako sent for something else
   * (a goal's step, a review). The list is the one given while it holds no run, and a run is the same object while
   * its turns are (`runsBefore`), so a streamed token is a look-up a turn here and no row drawn again. Everything
   * below reads this list: a run is windowed, measured, keyed and named in the navigator as any turn is.
   */
  const failedRequests = useContext(FailedRequestsContext)
  const runsBefore = useRef<ExchangeData[]>([])
  const exchanges = useMemo(() => {
    const stands = (exchange: ExchangeData) =>
      exchange.id === streamingId || exchange.id === interruptedId || exchange.id === failedId ||
      exchangeRequests(exchange).some((request) => interruptedRequests?.has(request) || makoPrompts?.has(request) || failedRequests.has(request))
    runsBefore.current = foldReportRuns(turns, stands, runsBefore.current)
    return runsBefore.current
  }, [turns, streamingId, interruptedId, failedId, interruptedRequests, makoPrompts, failedRequests])
  const sourceValue = useMemo(
    () => ({ threadPath: source.threadPath, liveId: source.liveId }),
    [source.threadPath, source.liveId]
  )
  const pane = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const topFade = useRef<HTMLSpanElement>(null)
  const edgeRow = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const userScrolling = useRef(false)
  // Pointer/key release ends input ownership, but scroll motion can continue.
  // Cleanup waits for the browser's scrollend rather than that earlier release.
  const scrollMotion = useRef(false)
  /**
   * A finger on the scroller. Its gesture isn't over while it's down, whatever
   * `scrollend` says: a programmatic scroll ends with one too. iOS moves the
   * scroller before the page hears of it, so a write while it's down puts the
   * content back under the finger.
   */
  const touching = useRef(false)
  /** A button held on the scroller: its bar being dragged, or a selection. Its input isn't over, however still it is. */
  const pressing = useRef(false)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inputSettled = useRef<() => void>(() => {})
  /** Input is the reader's only until it settles: left standing, the next layout shift would count as their scroll. */
  const settleInput = useCallback(() => {
    clearTimeout(settleTimer.current)
    settleTimer.current = setTimeout(() => inputSettled.current(), INPUT_SETTLE_MS)
  }, [])
  /** The reader's input is under way: a finger down, a button held, a wheel or a fling still moving the scroller. */
  const inputMoving = () => userScrolling.current || scrollMotion.current || touching.current || pressing.current
  /*
   * Once windowed, a conversation stays windowed while it's shown: releasing a turn's body never remounts the rest.
   * The crossing lays out every row it keeps in one long task (80 to 150 ms on a 4× slowed phone), which under a finger
   * or a fling holds the page while the scroller travels on. So it waits for the reader's input to settle, or for
   * `CROSSING_WAIT_MS` of input that never does, and crosses then. Only a column that already holds its turns but
   * the one arriving waits (`drawn`, the turns its last commit drew unwindowed): drawing that one more costs what a turn
   * does. A conversation opened mid-gesture (the timeline is reused across Threads, and the last one's input may not
   * have settled) or a history arriving whole would draw all of it, and windows at once. One that falls back below
   * the window as it waits (a rewind, a fork in place) stops waiting.
   */
  const sized = useRef<{ identity: string; windowed: boolean; drawn?: number; waitingSince?: number }>({ identity, windowed: false })
  if (sized.current.identity !== identity) sized.current = { identity, windowed: false }
  if (!sized.current.windowed && (exchanges.length > WINDOWED_TURNS || pastWindowedItems(exchanges))) {
    const since = sized.current.waitingSince ?? performance.now()
    const drawn = sized.current.drawn
    if (drawn === undefined || exchanges.length - drawn > 1 || !inputMoving() || performance.now() - since >= CROSSING_WAIT_MS)
      sized.current = { identity, windowed: true }
    else sized.current.waitingSince = since
  } else if (sized.current.waitingSince !== undefined) sized.current = { identity, windowed: false, drawn: sized.current.drawn }
  useLayoutEffect(() => {
    if (sized.current.identity === identity && !sized.current.windowed) sized.current.drawn = exchanges.length
  })
  const windowed = sized.current.windowed
  const crossingWait = windowed ? undefined : sized.current.waitingSince
  // A look that finds input settled renders again; should input have started by then, the wait goes on from a new look.
  const [looked, crossNow] = useState(0)
  useEffect(() => {
    if (crossingWait === undefined) return
    let timer: ReturnType<typeof setTimeout>
    const look = () => {
      if (!inputMoving() || performance.now() - crossingWait >= CROSSING_WAIT_MS) crossNow((count) => count + 1)
      else timer = setTimeout(look, INPUT_SETTLE_MS)
    }
    timer = setTimeout(look, Math.min(INPUT_SETTLE_MS, Math.max(0, crossingWait + CROSSING_WAIT_MS - performance.now())))
    return () => clearTimeout(timer)
  }, [crossingWait, looked])
  /** The end is followed again as the finger lifts; set by the observer below. */
  const followEnd = useRef<() => void>(() => {})
  /**
   * The virtualizer is reconciling toward a row (a jump, the end) and would
   * keep writing toward it. The reader's own input replaces that target, and
   * without one their input writes nothing.
   */
  const seeking = useRef(false)
  const lastScrollTop = useRef(0)
  /** The wheel's last half second, as when and how far: `wheelNet`. */
  const wheelTravel = useRef<{ at: number; by: number }[]>([])
  /** The wheel is on a scroller inside the transcript: a gesture stays with the scroller it began on, as the browser's does. */
  const innerWheel = useRef(false)
  /**
   * The offset the timeline last scrolled to itself. Any other scroll — the
   * reader's, the virtualizer's, the browser's for focus or find — moves the
   * reading position, which must follow it.
   */
  const ownScrollTop = useRef<number | null>(null)
  /** That offset, kept after its scroll event has been read: what the row check tells the transcript's own scroll by. */
  const lastOwnScrollTop = useRef<number | null>(null)
  const correction = useRef<{ node: HTMLDivElement; anchor: ScrollAnchor; top: number; frame: number; revision: number } | null>(null)
  const restore = useRef<ScrollAnchor | null>(null)
  const readingAnchor = useRef<ScrollAnchor | null>(null)
  // A correction owns the logical point until a complete layout frame agrees with it. Scroll callbacks in that
  // interval can carry real input, but the DOM they see may still contain a remounted turn's estimated height.
  const displaceCorrection = useCallback((node: HTMLDivElement) => {
    const owner = correction.current
    if (!owner) return false
    if (owner.node !== node || owner.anchor !== (restore.current ?? readingAnchor.current)) {
      cancelAnimationFrame(owner.frame)
      correction.current = null
      return false
    }
    // Every internal write records its actual readback in owned(). A browser clamp at a newly shorter end is also
    // layout movement. Any other displacement belongs to the reader, even after the correction's own scrollend.
    const end = Math.max(0, node.scrollHeight - node.clientHeight)
    const clamped = owner.top > end && node.scrollTop === end
    const movement = clamped ? 0 : node.scrollTop - owner.top
    if (movement !== 0) {
      const anchor = owner.anchor
      const moved = { ...anchor,
        exchangeOffset: anchor.exchangeOffset === undefined ? undefined : anchor.exchangeOffset - movement,
        block: anchor.block ? { ...anchor.block, offset: anchor.block.offset - movement } : undefined }
      if (restore.current === anchor) restore.current = moved
      if (readingAnchor.current === anchor) readingAnchor.current = moved
      owner.anchor = moved
    }
    owner.top = node.scrollTop
    return true
  }, [])
  const settleCorrection = useCallback(function settleCorrection(): void {
    const owner = correction.current
    if (!owner) return
    cancelAnimationFrame(owner.frame)
    const revision = ++owner.revision
    // The first frame allows the resize observers to reconcile estimates. Publication waits for the next frame,
    // the same owner/revision, its actual scroll readback and matching anchor geometry; another write restarts it.
    owner.frame = requestAnimationFrame(() => {
      owner.frame = requestAnimationFrame(() => {
        if (correction.current !== owner || owner.revision !== revision || viewport.current !== owner.node) return
        const pendingMovement = owner.node.scrollTop !== owner.top
        if (!displaceCorrection(owner.node)) return
        if (pendingMovement) {
          settleCorrection()
          return
        }
        const retired = owner.anchor.exchangeId && !owner.node.querySelector(`[data-exchange="${CSS.escape(owner.anchor.exchangeId)}"]`)
        const shift = retired ? 0 : scrollAnchorShift(owner.node, owner.anchor)
        const end = Math.max(0, owner.node.scrollHeight - owner.node.clientHeight)
        // A shortened document can make the old offset unattainable. Accept the browser's bound rather than
        // repeatedly scheduling a correction it cannot apply.
        const limited = Math.max(0, Math.min(end, owner.node.scrollTop + shift)) === owner.node.scrollTop
        if (retired || Math.abs(shift) < 1 || limited) {
          correction.current = null
          // Once coherent, a long gesture may have reached another turn. Hand off to the point actually painted
          // there; retaining an off-screen or virtualized-away anchor would pin the wrong turn through later changes.
          if (readingAnchor.current === owner.anchor && !restore.current) {
            readingAnchor.current = captureAnchor(owner.node, [], false)
            reportReading.current()
          }
        } else followEnd.current()
      })
    })
  }, [displaceCorrection])
  useLayoutEffect(() => () => {
    if (correction.current) cancelAnimationFrame(correction.current.frame)
    correction.current = null
  }, [identity])
  const owned = useCallback((node: HTMLDivElement) => {
    lastScrollTop.current = node.scrollTop
    ownScrollTop.current = node.scrollTop
    lastOwnScrollTop.current = node.scrollTop
    if (correction.current?.node === node) {
      correction.current.top = node.scrollTop
      settleCorrection()
    }
    if (touching.current) node.dispatchEvent(new Event(SCROLL_WRITE_EVENT, { bubbles: true }))
  }, [settleCorrection])

  const restoringReader = useRef<ScrollAnchor | null>(null)
  const pendingJump = useRef<string | null>(null)
  const readerPane = useRef(Symbol("transcript pane"))
  const persistentPane = useContext(TranscriptPaneContext)
  const paneKey = persistentPane ?? readerPane.current
  const bookmarkRestore = useRef<TranscriptReading["anchor"]>(undefined)
  const reportReading = useRef<() => void>(() => {})
  /** The same report for what the transcript did itself (the end followed as an answer grows): said at most once a second. */
  const reportGrowth = useRef<() => void>(() => {})
  const heights = useRef(new Map<string, number>())
  const direction = useRef<"up" | "down">("down")
  const readingSource = source.liveId ? liveReadingSource(source.liveId)
    : source.threadPath ? nativeReadingSource(source.threadPath) : `timeline:${identity}`
  const historyBlocks = source.historyFrom?.blocks
  const historyBase = source.historyFrom?.base
  /**
   * One request for earlier history at a time, from the moment it is asked
   * for until the turns are on screen and the reading position is restored.
   * A request that changes nothing stalls further requests until the reader
   * scrolls again, so a source that cannot page never spins.
   */
  const awaitingEarlier = useRef(false)
  const sawLoading = useRef(false)
  const stalled = useRef(false)
  const flight = useRef(0)
  /** The latest proximity check, for callers that outlive one render. */
  const wake = useRef<() => void>(() => {})
  const [showJump, setShowJump] = useState(false)
  // Where the transcript ended when the reader left its end, so the way back says how much arrived since.
  const [leftAt, setLeftAt] = useState<LeftAt | null>(null)
  if (!showJump && leftAt !== null) setLeftAt(null)
  else if (showJump && leftAt === null) setLeftAt(endOf(exchanges))
  const arrived = showJump && leftAt ? arrivedSince(exchanges, leftAt) : 0
  const transcriptEnd = useContext(TranscriptEndContext)
  // A phone's width keeps no rail of turns: its gutter would take a tenth of the screen, and it reads back by hover.
  const navigates = useContext(CompactPresentationContext)?.navigator !== false
  /** With `transcriptEnd` provided: room after the column that keeps a followed end from moving back (`pin`). */
  const steadyEnd = useRef<HTMLDivElement>(null)
  const highWater = useRef(0)
  const highWaterWidth = useRef(0)
  const reflowing = useRef(0)
  /** For this frame and the next, the column's height is all flowing again, and a smaller one is no shrink to keep room for. */
  const reflow = useCallback(() => {
    cancelAnimationFrame(reflowing.current)
    reflowing.current = requestAnimationFrame(() => {
      reflowing.current = requestAnimationFrame(() => {
        reflowing.current = 0
      })
    })
  }, [])
  const [activeTurn, setActiveTurn] = useState<string | null>(null)
  /**
   * Each turn's React key, for the turns that came back under another id. A
   * renamed turn keeps the key it had, so it stays mounted at its laid-out
   * size rather than arriving as a placeholder, and every reference to it
   * follows it to its new id before the column is measured.
   */
  const named = useRef({ identity, exchanges, keys: NO_KEYS })
  const renamed =
    named.current.exchanges === exchanges || named.current.identity !== identity
      ? NO_RENAMES
      : renamedExchanges(named.current.exchanges, exchanges)
  const keys =
    named.current.exchanges === exchanges
      ? named.current.keys
      : turnKeys(
          named.current.identity === identity ? named.current.keys : NO_KEYS,
          exchanges,
          renamed
        )
  /**
   * How many of the newest turns are mounted, and the newest turn it was
   * counted against. Turns arriving below the first mounted one raise the
   * count and turns leaving lower it, so the same first turn stays mounted
   * and none above the reader unmounts; history arriving above waits for a
   * reveal.
   */
  const [tail, setTail] = useState({
    limit: INITIAL_TURNS,
    last: exchanges.at(-1)?.id,
  })
  const newest = exchanges.at(-1)?.id
  if (tail.last !== newest) {
    const before =
      named.current.identity === identity ? named.current.exchanges : []
    const from = before.length - Math.min(before.length, tail.limit)
    const firstId = before[from]?.id
    const first =
      firstId === undefined
        ? -1
        : exchanges.findIndex(
            (exchange) => exchange.id === (renamed.get(firstId) ?? firstId)
          )
    const last =
      tail.last === undefined ? undefined : (renamed.get(tail.last) ?? tail.last)
    const previous =
      last === undefined
        ? -1
        : exchanges.findIndex((exchange) => exchange.id === last)
    const arrived =
      first >= 0
        ? exchanges.length - first - (before.length - from)
        : previous < 0
          ? 0
          : exchanges.length - 1 - previous
    setTail({ limit: Math.max(INITIAL_TURNS, tail.limit + arrived), last: newest })
  }
  const [everMore, setEverMore] = useState(false)
  const hidden = windowed ? 0 : Math.max(0, exchanges.length - tail.limit)
  const shown = hidden > 0 ? exchanges.slice(hidden) : exchanges
  /*
   * Of the turns shown, the ones drawn so far: from `first` on, or all of them (`FIRST_TURNS`). Named by its id, so a
   * turn arriving at the end or the count settling at the front leaves the same turns drawn. A reader coming back to a
   * place up the transcript gets all of them at once: that place is among the ones that would wait.
   */
  const [stage, setStage] = useState<{ identity: string; first: string | null; fills: number }>({ identity: "", first: null, fills: 0 })
  let undrawn = 0
  if (!windowed && shown.length > 0) {
    if (stage.identity !== identity) {
      const bookmark = transcriptReaders.bookmark(readingSource, paneKey)
      undrawn = shown.length <= FIRST_TURNS || (bookmark && !bookmark.following && bookmark.anchor) ? 0 : shown.length - FIRST_TURNS
      setStage({ identity, first: undrawn ? shown[undrawn]!.id : null, fills: 0 })
    } else if (stage.first !== null) undrawn = Math.max(0, shown.findIndex((exchange) => exchange.id === stage.first))
  }
  const drawn = undrawn > 0 ? shown.slice(undrawn) : shown
  const staging = undrawn > 0
  /** The turns shown as this render has them, for the idle moment that draws more of them. */
  const staged = useRef({ shown, undrawn })
  staged.current = { shown, undrawn }
  /** What the end's last layout found (`layOutEnd`): the turns drawn above those that fill the pane. */
  const endSpare = useRef(0)
  /**
   * The reader has begun to move: every turn still waiting is drawn now, in this event, so wherever their input takes
   * them the turn is there, as it was when an open drew them all. It costs that one input what the open was spared,
   * and only for a reader who moves in the moments before the idle slices finish.
   */
  const drawAll = useCallback(() => {
    if (staged.current.undrawn === 0) return
    flushSync(() => setStage((current) => (current.first === null ? current : { ...current, first: null })))
  }, [])
  const isEmpty = exchanges.length === 0
  const more = hidden > 0 || hasEarlier
  const edge = more || everMore || exchanges.length > INITIAL_TURNS
  const edgeState: HistoryEdgeState = loadingEarlier
    ? "loading"
    : more
      ? "more"
      : "start"
  const rowKey = (index: number) => keys.get(exchanges[index]!.id) ?? exchanges[index]!.id
  const placedTotal = useRef(0)
  /** How much of a windowed column is rows' estimates (`estimateSize`), not yet their measured sizes. */
  const estimated = useRef<() => number>(() => 0)
  estimated.current = () => {
    if (!windowed) return 0
    let height = 0
    for (let index = 0; index < exchanges.length; index += 1) {
      const key = rowKey(index)
      if (!rows.itemSizeCache.has(key)) height += estimateTurn(index)
    }
    return height
  }
  /*
   * A row never measured is placed at what its turn's words and calls come to, at the pixels a character has been
   * taking in this window (`RowHeights.pxPerChar`), read once for the conversation shown: an estimate that moved
   * while its rows stood on it would move them. One constant for every turn left a long transcript's column wrong by
   * most of its height, and corrected it a row at a time as a reader scrolled.
   */
  const pxPerChar = useRef({ identity: "", value: 0, made: new Map<RowKey, number>() })
  if (pxPerChar.current.identity !== identity) pxPerChar.current = { identity, value: rowHeights.pxPerChar(windowWidth()), made: new Map() }
  // A row keeps the estimate it was first given: a turn released from memory holds nothing to estimate from, and
  // given another, every unmeasured row above a reader moved at once as memory was trimmed.
  const estimateTurn = (index: number) => {
    const exchange = exchanges[index]
    if (!exchange) return ESTIMATED_ROW
    const key = rowKey(index)
    let estimate = pxPerChar.current.made.get(key)
    if (estimate === undefined) {
      estimate = exchange.unloaded !== undefined ? ESTIMATED_ROW : estimateRow(rowFacts(exchange), pxPerChar.current.value)
      pxPerChar.current.made.set(key, estimate)
    }
    return estimate
  }
  /*
   * A row's new size is placed in the frame it is laid out, never the next: the resize observer's sizes apply in its
   * own callback, the virtualizer writes every row's offset and the column's height there itself, and the end is
   * followed in the same pass. Placed a frame later, a row that just grew (a sent message, a report, an answer) is
   * painted over what follows it. The space between rows is the virtualizer's gap, so a row arriving below another
   * doesn't change that one's size.
   */
  const [rowCheck] = useState(() => rowChecker<Element>())
  /** The viewport and offset a live crossing into a window starts from (`carryIntoWindow`): `initialRect` is read as it's enabled. */
  const crossingRect = useRef({ width: 0, height: 0 })
  const crossingOffset = useRef(0)
  const carried = useRef(false)
  const rows = useVirtualizer({
    count: exchanges.length,
    enabled: windowed,
    getScrollElement: () => viewport.current,
    initialRect: crossingRect.current,
    initialOffset: () => crossingOffset.current,
    estimateSize: (index) => estimateTurn(index),
    getItemKey: (index) => rowKey(index),
    // Two turns each way: six drew, parsed and laid out a dozen turns nobody was looking at on every open and jump.
    overscan: 2,
    gap: ROW_GAP,
    scrollMargin: edge ? 80 : 24,
    directDomUpdates: true,
    measureElement: (element, entry, instance) => {
      if (entry) rowCheck.heard(element)
      return measureElement(element, entry, instance)
    },
    onChange: (instance) => {
      const total = instance.getTotalSize()
      if (total === placedTotal.current) return
      placedTotal.current = total
      followEnd.current()
    },
    scrollToFn: (offset, options, instance) => {
      elementScroll(offset, options, instance)
      if (viewport.current) owned(viewport.current)
    },
  })
  const measureRow = useRowRef(rows)
  /**
   * A conversation that grows into a window is on screen as it crosses, and the virtualizer's first commit knows neither
   * the viewport nor its rows: it would mount the first turns at offset 0, and the column would paint empty until a seek
   * landed a frame later. The rows are still laid out here, so it starts from their sizes, the viewport, and the offset
   * that keeps the first row in view where it is, and that first commit paints what the last one did.
   */
  const carryIntoWindow = () => {
    const node = viewport.current
    if (!node?.clientHeight || named.current.identity !== identity || node.querySelector("[data-virtual-transcript]")) return
    const view = node.getBoundingClientRect()
    const indexes = new Map(exchanges.map((exchange, index) => [exchange.id, index]))
    let anchor: { index: number; top: number } | undefined
    for (const turn of node.querySelectorAll("[data-exchange]")) {
      const index = indexes.get(turn.getAttribute("data-exchange") ?? "")
      if (index === undefined) continue
      const box = turn.getBoundingClientRect()
      // One `content-visibility` skips has its placeholder's height, not its own, and only what's inside it says so.
      if (turn.firstElementChild?.checkVisibility({ contentVisibilityAuto: true })) rows.itemSizeCache.set(rowKey(index), Math.round(box.height))
      if (!anchor && box.bottom > view.top) anchor = { index, top: box.top }
    }
    if (!anchor) return
    let start = rows.options.scrollMargin
    for (let index = 0; index < anchor.index; index += 1)
      start += (rows.itemSizeCache.get(rowKey(index)) ?? estimateTurn(index)) + ROW_GAP
    crossingRect.current.width = node.clientWidth
    crossingRect.current.height = node.clientHeight
    crossingOffset.current = Math.max(0, start + view.top - anchor.top)
    carried.current = true
  }
  const seeded = useRef<string | undefined>(undefined)
  if (!windowed) {
    seeded.current = undefined
    crossingRect.current.width = crossingRect.current.height = crossingOffset.current = 0
  } else if (seeded.current !== identity) {
    seeded.current = identity
    seedMeasured(readingSource, rows.itemSizeCache, exchanges, rowKey)
    carryIntoWindow()
  }
  const mountedRows = useRef<(only?: ReadonlySet<Element>) => boolean>(() => false)
  mountedRows.current = (only) => rowCheck.check({
    rows,
    list: viewport.current?.querySelector("[data-virtual-transcript]") ?? null,
    keyOf: rowKey,
    partsOf: (index) => exchanges[index]!.response.length,
    streaming: (index) => exchanges[index]!.id === streamingId,
    // Only a row kept out of view (`data-sized`) is ever skipped; what's in its turn says whether it is right now.
    skipped: (element) => {
      const inside = element.hasAttribute("data-sized") ? element.firstElementChild?.firstElementChild : undefined
      return Boolean(inside?.checkVisibility() && !inside.checkVisibility({ contentVisibilityAuto: true }))
    },
    following: pinned.current,
  }, only)
  /*
   * A message the person just sent is placed near the pane's top (`SENT_TOP`), and its answer grows under it with
   * nothing moving: the reader starts each answer at its first line, not by chasing its last. It's the end being
   * followed, as ever, over room kept after the column (`sendRoom`): as tall as it takes for the end of the scroller
   * to put the sent turn's top there, and shorter by every line the answer adds, so the scroller's height stands
   * still while it fills. Once the turn fills the pane the room is nothing, and the end is followed as it always
   * was, without a step between the two. Every rule of following holds through it: only the reader lets go.
   * The room is the transcript's while it's shown: a Thread opened lands on its newest turn at its end.
   */
  const sendRoom = useRef<HTMLDivElement>(null)
  const sentTurn = useRef<string | null>(null)
  const keepSendRoom = useCallback((node: HTMLDivElement) => {
    const room = sendRoom.current
    const id = sentTurn.current
    if (!room || !id) return
    const view = node.getBoundingClientRect()
    const place = room.getBoundingClientRect()
    const held = place.height
    const turn = node.querySelector(`[data-exchange="${CSS.escape(id)}"]`)
    if (!turn) {
      // Its turn left the page (a window's reader far up): room nobody can see goes, and seen, it stays as it is.
      if (held && place.top < view.bottom) return
      room.style.height = "0px"
      sentTurn.current = null
      return
    }
    // From the turn's top to the scroller's end, less the room itself: what the scroller holds for the pane to show.
    const below = place.top - turn.getBoundingClientRect().top
    const after = view.top - node.scrollTop + node.scrollHeight - place.bottom
    // To the fraction of a pixel the boxes are at: rounded, the turn sat half a pixel off and stepped as it filled.
    const want = Math.max(0, node.clientHeight - SENT_TOP - below - after)
    if (Math.abs(want - held) > 0.05) room.style.height = `${want}px`
    if (!want) sentTurn.current = null
  }, [])
  /** Sends the virtualizer toward a row or the end, which it keeps reconciling toward until `endSeek`. */
  const seek = useCallback((target: number | "end") => {
    seeking.current = true
    if (target === "end") rows.scrollToEnd({ behavior: "auto" })
    else rows.scrollToIndex(target, { align: "start", behavior: "auto" })
  }, [rows])
  /** Ends the virtualizer's reconciling toward a row, at the scroller's own offset. */
  const endSeek = useCallback((node: HTMLDivElement) => {
    if (!seeking.current) return
    seeking.current = false
    rows.scrollToOffset(node.scrollTop, { behavior: "auto" })
  }, [rows])
  /** One owner preserves the captured content through every layout change. */
  const holdReader = useCallback(
    (node: HTMLDivElement) => {
      const displaced = displaceCorrection(node)
      const snapshot = restore.current ?? readingAnchor.current
      if (
        !snapshot?.exchangeId ||
        !node.querySelector(
          `[data-exchange="${CSS.escape(snapshot.exchangeId)}"]`
        )
      )
        return
      // A resize can arrive before the scroll event for this frame. Preserve the movement not yet reported as well as
      // the reader's place in the media. Not the reader's input alone: while an anchor holds, the scroller anchors
      // nothing itself (`overflow-anchor: none`) and this file reports its own writes as it makes them (`owned`), so a
      // change it hasn't heard of is a scroll, the reader's or one made for them, such as the Shiver card's "Fins need you"
      // line bringing the card back. Counted as layout, the hold put the old point back over it, a frame before that
      // scroll's event. Left out are what it can't tell apart: the virtualizer's own writes while windowed, and the
      // browser's clamp at a newly shorter end.
      const end = Math.max(0, node.scrollHeight - node.clientHeight)
      const clamped = lastScrollTop.current > end && node.scrollTop === end
      const unreported = !displaced && !clamped &&
        (!windowed || userScrolling.current || scrollMotion.current || touching.current)
      const movement = unreported ? node.scrollTop - lastScrollTop.current : 0
      const moved = movement === 0 ? snapshot : { ...snapshot,
        exchangeOffset: snapshot.exchangeOffset === undefined ? undefined : snapshot.exchangeOffset - movement,
        block: snapshot.block ? { ...snapshot.block, offset: snapshot.block.offset - movement } : undefined }
      // Nothing above the reader changed: the scroller is theirs, and the
      // snapshot stays measured from the last position they reported.
      if (!preserveScrollAnchor(node, moved)) {
        if (displaced) settleCorrection()
        return
      }
      if (restore.current === snapshot) restore.current = moved
      if (readingAnchor.current === snapshot) readingAnchor.current = moved
      // Replace the virtualizer's outstanding target so it cannot undo the
      // offset just restored inside the answer.
      endSeek(node)
      owned(node)
      const owner = correction.current ?? { node, anchor: moved, top: node.scrollTop, frame: 0, revision: 0 }
      owner.anchor = moved
      owner.top = node.scrollTop
      correction.current = owner
      settleCorrection()
    },
    [owned, endSeek, displaceCorrection, settleCorrection, windowed]
  )
  useLayoutEffect(() => {
    const before = named.current
    named.current = { identity, exchanges, keys }
    if (renamed.size === 0) return
    const follow = (id: string) => {
      const next = renamed.get(id)
      if (next) return next
      if (exchanges.some((exchange) => exchange.id === id)) return id
      // Gone without a match: the turn as far from the end stands in, so the
      // reader stays among the same turns rather than wherever the offset lands.
      const at = before.exchanges.findIndex((exchange) => exchange.id === id)
      if (at < 0 || exchanges.length === 0) return id
      const index = exchanges.length - (before.exchanges.length - at)
      return exchanges[Math.max(0, Math.min(exchanges.length - 1, index))]!.id
    }
    const moved = (anchor: ScrollAnchor | null) =>
      anchor?.exchangeId
        ? { ...anchor, exchangeId: follow(anchor.exchangeId) }
        : anchor
    restore.current = moved(restore.current)
    readingAnchor.current = moved(readingAnchor.current)
    restoringReader.current = moved(restoringReader.current)
    if (pendingJump.current) pendingJump.current = follow(pendingJump.current)
    setActiveTurn((current) => (current ? follow(current) : current))
    // Turns can trade places at the same total height, which no resize reports.
    if (viewport.current && !pinned.current) holdReader(viewport.current)
    // The turns a report names go by other ids now.
    reportReading.current()
  }, [identity, exchanges, keys, renamed, holdReader])
  const previousWindowed = useRef(windowed)
  useLayoutEffect(() => {
    if (previousWindowed.current === windowed) return
    previousWindowed.current = windowed
    const node = viewport.current,
      snapshot = readingAnchor.current
    if (!node || awaitingEarlier.current) return
    // Either way across, the column is a different one: laid-out turns become rows placed at their estimates, or the
    // reverse, and a shorter column is no shrink to keep room for at a followed end (`pin`). Left to the room, a crossing
    // the carry couldn't make (at the end of a short pane, where what follows the turns fills it and no turn is in view
    // to hold) kept the laid-out column's height after the rows, and the end it went to was blank, every row far above.
    reflow()
    if (carried.current) {
      carried.current = false
      // The rows it couldn't know take their sizes before this paints, so no frame shows them at an estimate, and the row
      // in view is held by hand: the virtualizer keeps a reader's place for a first measure, not for one going up. It's
      // already where the reader was, so one who's up gets no seek, which would only send them to their turn's top.
      const top = node.getBoundingClientRect().top
      const placed = [...(node.querySelector("[data-virtual-transcript]")?.children ?? [])]
      const held = placed.find((row) => row.getBoundingClientRect().bottom > top)
      const before = held?.getBoundingClientRect().top
      for (const row of placed) rows.resizeItem(Number(row.getAttribute("data-index")), Math.round(row.getBoundingClientRect().height))
      const moved = held && before !== undefined ? held.getBoundingClientRect().top - before : 0
      if (moved) {
        node.scrollTop += moved
        owned(node)
      }
      if (pinned.current) seek("end")
      return
    }
    if (pinned.current) {
      if (windowed) seek("end")
      else node.scrollTop = node.scrollHeight
      return
    }
    if (!snapshot?.exchangeId) return
    const index = exchanges.findIndex(
      (exchange) => exchange.id === snapshot.exchangeId
    )
    if (index < 0) return
    if (windowed) seek(index)
    else if (index < hidden)
      setTail((current) => ({ ...current, limit: exchanges.length - index }))
    restoringReader.current = snapshot
  }, [windowed, seek, exchanges, hidden, owned, reflow])
  const virtualRows = rows.getVirtualItems()
  const mountedKeys = windowed
    ? virtualRows.map((row) => row.key).join("\0")
    : ""
  /*
   * The rows kept mounted around the pane (the overscan) are left to the browser to skip while they're out of view
   * (`data-sized`: `content-visibility: auto` in index.css), each standing at the height it was just laid out at, so
   * it costs no layout or paint until it's read and the virtualizer finds it the size it placed. A row in view is laid
   * out for real. Marked in the next frame's first moment, by hand: marked in the render a row's measurement caused,
   * it changed size under the observer delivering that measurement, which Chromium reports as a resize loop.
   */
  const inView = rows.range
  const firstInView = windowed ? inView?.startIndex : undefined
  const lastInView = windowed ? inView?.endIndex : undefined
  useLayoutEffect(() => {
    if (firstInView === undefined || lastInView === undefined) return
    const frame = requestAnimationFrame(() => {
      const list = viewport.current?.querySelector("[data-virtual-transcript]")
      if (!list) return
      const skip: [HTMLElement, number][] = []
      const draw: HTMLElement[] = []
      const placed = new Map(rows.getVirtualItems().map((item) => [item.index, item.size]))
      for (const row of list.children) {
        if (!(row instanceof HTMLElement)) continue
        const index = Number(row.dataset.index)
        const out = index < firstInView || index > lastInView
        if (out && !row.hasAttribute("data-sized")) {
          // Only a row at the size it was placed at is set aside. One that changed this frame (its turn finishing in
          // the batch that brought the next) has a size nobody has read yet, and skipped, it stood at the one the
          // browser remembered from before: it stays laid out for the row check to read, and goes at the next pass.
          const height = row.getBoundingClientRect().height
          const size = placed.get(index)
          if (size !== undefined && Math.abs(height - size) <= 1) skip.push([row, height])
        } else if (!out && row.hasAttribute("data-sized")) draw.push(row)
      }
      for (const [row, height] of skip) {
        if (!height) continue
        row.style.setProperty("--row-size", `${height}px`)
        row.setAttribute("data-sized", "")
      }
      for (const row of draw) row.removeAttribute("data-sized")
    })
    return () => cancelAnimationFrame(frame)
  }, [firstInView, lastInView, mountedKeys, rows])

  useLayoutEffect(() => {
    const node = viewport.current,
      snapshot = restoringReader.current
    if (
      !node ||
      !snapshot?.exchangeId ||
      userScrolling.current ||
      pendingJump.current
    )
      return
    if (
      !node.querySelector(
        `[data-exchange="${CSS.escape(snapshot.exchangeId)}"]`
      )
    )
      return
    preserveScrollAnchor(node, snapshot)
    // Measurement reconciliation must no longer own the old index target.
    endSeek(node)
    owned(node)
    readingAnchor.current = snapshot
    restoringReader.current = null
  }, [mountedKeys, shown.length, undrawn, endSeek, owned])

  useEffect(() => {
    if (more) setEverMore(true)
  }, [more, identity])

  const scrollToEnd = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const node = viewport.current
      if (!node) return
      restore.current = null
      bookmarkRestore.current = undefined
      if (!awaitingEarlier.current) node.removeAttribute("data-preserve-scroll")
      pendingJump.current = null
      userScrolling.current = false
      scrollMotion.current = false
      readingAnchor.current = null
      node.removeAttribute("data-reading-anchor")
      restoringReader.current = null
      pinned.current = true
      if (windowed) seek("end")
      else
        node.scrollTo({
          top: node.scrollHeight,
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : behavior,
        })
      owned(node)
      setShowJump(false)
    },
    [seek, windowed, owned]
  )
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const toEnd = () => scrollToEnd()
    node.addEventListener(TRANSCRIPT_END_EVENT, toEnd)
    return () => node.removeEventListener(TRANSCRIPT_END_EVENT, toEnd)
  }, [scrollToEnd])
  // The app scrolling for the reader (`scrollReaderTo`) is their movement, as a wheel's is: the place they had goes, any
  // target the virtualizer was reconciling toward goes, and what moves next is theirs until it settles, so a hold before
  // its scroll event keeps it rather than putting the old place back. Windowed too, where nothing else says so.
  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const readerScroll = () => {
      drawAll()
      endSeek(node)
      bookmarkRestore.current = undefined
      if (!awaitingEarlier.current) node.removeAttribute("data-preserve-scroll")
      pendingJump.current = null
      restoringReader.current = null
      if (displaceCorrection(node)) settleCorrection()
      else readingAnchor.current = captureAnchor(node, [], false)
      if (!awaitingEarlier.current) restore.current = null
      stalled.current = false
      scrollMotion.current = true
      settleInput()
    }
    node.addEventListener(READER_SCROLL_EVENT, readerScroll)
    return () => node.removeEventListener(READER_SCROLL_EVENT, readerScroll)
  }, [endSeek, displaceCorrection, settleCorrection, settleInput, drawAll])
  useEffect(() => transcriptEnd?.away(showJump), [transcriptEnd, showJump])
  useEffect(() => {
    if (!transcriptEnd) return
    transcriptEnd.bind(() => scrollToEnd("smooth"))
    return () => transcriptEnd.bind(null)
  }, [transcriptEnd, scrollToEnd])

  const onScroll = useCallback(() => {
    const node = viewport.current
    if (!node) return
    topFade.current?.toggleAttribute("data-scrolled", node.scrollTop > 0.5)
    const movingUp = leftEnd(node, lastScrollTop.current)
    const positionChanged = node.scrollTop !== lastScrollTop.current
    const movingDown = node.scrollTop > lastScrollTop.current + 0.5
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const atBottom = distance < NEAR_BOTTOM
    // Layout/virtualizer adjustments are not reader intent. Keyboard input
    // participates through the same explicit input handlers below.
    const corrected = displaceCorrection(node)
    if (corrected && positionChanged) settleCorrection()
    lastScrollTop.current = node.scrollTop
    const ours =
      ownScrollTop.current !== null &&
      node.scrollTop === ownScrollTop.current
    // A wheel that outran the scroller inside has chained on down to the transcript, and is the reader's here again.
    if (innerWheel.current && movingDown && !ours) {
      innerWheel.current = false
      userScrolling.current = true
    }
    if ((userScrolling.current || touching.current) && !ours) scrollMotion.current = true
    if (userScrolling.current || scrollMotion.current) settleInput()
    ownScrollTop.current = null
    // Only the reader's movement decides: up leaves the end, down into it follows again. A scroll that ended
    // short of the end after moving up stays where it was left.
    if ((userScrolling.current || scrollMotion.current || touching.current) && !ours) {
      if (movingUp && distance >= LEFT_END) pinned.current = false
      else if (movingDown && atBottom && !wheelResting(wheelTravel.current, performance.now())) pinned.current = true
    }
    // A reader who keeps scrolling while a page is on its way moves the
    // position that page must be placed around.
    if (!corrected && awaitingEarlier.current && restore.current && !pinned.current) {
      const { shown, hasEarlier, head } = restore.current
      restore.current = { ...captureAnchor(node, [], hasEarlier), shown, head }
    }
    // During correction, displace the intended point instead of adopting transient DOM geometry.
    // A duplicate scrollend with no movement cannot supply a new reading position.
    if (
      !corrected &&
      !pinned.current &&
      !awaitingEarlier.current &&
      !pendingJump.current &&
      !bookmarkRestore.current &&
      !restoringReader.current &&
      ((!ours && positionChanged) || !readingAnchor.current)
    )
      readingAnchor.current = captureAnchor(node, [], false)
    else if (pinned.current) readingAnchor.current = null
    node.toggleAttribute("data-reading-anchor", !!readingAnchor.current?.exchangeId)
    const show = !pinned.current && !atBottom
    setShowJump((current) => (current === show ? current : show))
    // A reader scrolling again after a stalled request asks once more; the
    // edge observer alone stays silent while the edge never left view.
    if (userScrolling.current) wake.current()
    // The end followed as an answer grows is the transcript's own write, a frame apart for as long as it streams.
    if (ours && pinned.current) reportGrowth.current()
    else reportReading.current()
  }, [settleInput, displaceCorrection, settleCorrection])

  useEffect(() => {
    inputSettled.current = () => {
      innerWheel.current = false
      if (touching.current || pressing.current) return
      if (userScrolling.current || scrollMotion.current) onScroll()
      userScrolling.current = false
      scrollMotion.current = false
      reportReading.current()
    }
    return () => clearTimeout(settleTimer.current)
  }, [onScroll])

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      drawAll()
      // The Shiver card's list or a code block taking the wheel: it scrolls that, and the transcript is left as it was.
      if (viewport.current && wheelTakenInside(event.target, viewport.current, event.deltaY)) innerWheel.current = true
      if (innerWheel.current) return settleInput()
      if (viewport.current) endSeek(viewport.current)
      bookmarkRestore.current = undefined
      if (!awaitingEarlier.current) viewport.current?.removeAttribute("data-preserve-scroll")
      pendingJump.current = null
      restoringReader.current = null
      if (viewport.current && displaceCorrection(viewport.current)) settleCorrection()
      else readingAnchor.current = viewport.current ? captureAnchor(viewport.current, [], false) : null
      userScrolling.current = true
      direction.current = event.deltaY < 0 ? "up" : "down"
      stalled.current = false
      if (!awaitingEarlier.current) restore.current = null
      const node = viewport.current
      // Up leaves the end now: the scroll this wheel makes may come after the end's next write, which would swallow it.
      // Down into the end follows again, whichever of this event and its scroll comes first. Either takes a wheel that
      // means it: fingers resting on a trackpad send a few pixels each way.
      const net = wheelNet(wheelTravel.current, event, node?.clientHeight ?? 0)
      if (net <= -LEFT_END) pinned.current = false
      if (node && net >= LEFT_END && node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM) pinned.current = true
      node?.toggleAttribute("data-reading-anchor", !pinned.current && !!readingAnchor.current?.exchangeId)
      settleInput()
      // A wheel toward earlier turns asks for them even when it moves
      // nothing: at the top edge, or when the compositor applied this
      // (passive) wheel's scroll before it reached this handler, no scroll
      // event from the reader follows to wake the edge check, and the edge
      // observer stays silent while the edge never left view.
      if (event.deltaY < 0) wake.current()
      reportReading.current()
    },
    [endSeek, settleInput, displaceCorrection, settleCorrection, drawAll]
  )

  /** The last finger lifts: a glide may go on, and the end, if followed, is caught up with. */
  const lifted = useCallback((event: ReactTouchEvent<HTMLDivElement>) => {
    touching.current = event.touches.length > 0
    if (!touching.current) followEnd.current()
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    drawAll()
    // Preview controls may change layout without scrolling. Keep the media
    // anchor while a mouse click loads, folds, or starts a preview.
    if (event.pointerType === "mouse" && event.target instanceof Element &&
        event.target.closest("button,a,input,textarea,select,video,audio,[contenteditable=true]")) {
      const preview = event.target.closest("video,audio")?.closest("[data-inline-file-preview]")
      const turn = preview?.closest("[data-exchange]")
      const node = viewport.current
      if (node && preview && turn && !pinned.current) {
        readingAnchor.current = { ...captureAnchor(node, [], false, turn), block: {
          element: preview, offset: preview.getBoundingClientRect().top - node.getBoundingClientRect().top,
          preview: previewIdentity(preview),
        } }
        node.setAttribute("data-reading-anchor", "")
      }
      reportReading.current()
      return
    }
    bookmarkRestore.current = undefined
    if (!awaitingEarlier.current) viewport.current?.removeAttribute("data-preserve-scroll")
    if (viewport.current) endSeek(viewport.current)
    pendingJump.current = null
    restoringReader.current = null
    // A selection or scrollbar press can precede any scroll event. Keep a
    // position to correct in that interval; onScroll follows actual movement.
    const node = viewport.current
    const selected = event.target instanceof Element ? readingBlockAt(event.target) : undefined
    const turn = selected?.closest("[data-exchange]")
    if (node && displaceCorrection(node)) settleCorrection()
    else readingAnchor.current = node ? selected && turn && node.contains(turn)
      ? { ...captureAnchor(node, [], false, turn), block: {
          element: selected, offset: selected.getBoundingClientRect().top - node.getBoundingClientRect().top,
          preview: previewIdentity(selected),
        } }
      : captureAnchor(node, [], false) : null
    node?.toggleAttribute("data-reading-anchor", !pinned.current && !!readingAnchor.current?.exchangeId)
    userScrolling.current = true
    pressing.current = true
    stalled.current = false
    if (!awaitingEarlier.current) restore.current = null
    reportReading.current()
  }, [endSeek, displaceCorrection, settleCorrection, drawAll])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (
            entry.isIntersecting &&
            entry.target.hasAttribute("data-preserve-height")
          ) {
            requestAnimationFrame(() =>
              entry.target.removeAttribute("data-preserve-height")
            )
          }
        }
      },
      { root: node, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    )
    for (const element of node.querySelectorAll("[data-exchange]")) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [identity, shown.length, undrawn, mountedKeys])

  // One lease per pane and source while both hold. A stream renders the transcript again every batch, and a lease
  // made again each time has no reading until the next frame, which memory cleanup must read as "keep everything".
  const readingLease = useRef<ReturnType<typeof transcriptReaders.attach> | null>(null)
  useLayoutEffect(() => {
    const held = transcriptReaders.attach(readingSource, paneKey)
    readingLease.current = held
    return () => {
      held.release()
      if (readingLease.current === held) readingLease.current = null
    }
  }, [readingSource, paneKey])

  /** What a report reads of the last render, so the report itself is set up once per pane and source. */
  const reported = useRef({ exchanges, historyBlocks, historyBase, rowKey })
  reported.current = { exchanges, historyBlocks, historyBase, rowKey }
  /*
   * What the pane is reading, said to its lease: on the reader's scroll and input, a resize of the pane, a selection
   * or focus moving, and whenever the turns on the page change (the effect after this one). Never for each frame of a stream:
   * set up again for every paced frame, it made a resize observer and three listeners each time and then read every
   * mounted turn's box three times and hit-tested the pane's middle up to thirteen times, for a reading that had not
   * moved. While an answer grows under a reader following its end the report is paced to a second (`growth`), enough
   * for the navigator's mark to follow the answer past the pane's middle.
   */
  useLayoutEffect(() => {
    const node = viewport.current
    const lease = readingLease.current
    if (!node || !lease) return
    let frame = 0
    let paced: ReturnType<typeof setTimeout> | undefined
    /** When this transcript's measured rows were last kept (`keepMeasured`): every row is read for it. */
    let keptRowsAt = -KEEP_ROWS_MS
    /** Whether the last report said the end was followed: only then is the next one of the transcript's own doing. */
    let followed = false
    const report = () => {
      frame = 0
      clearTimeout(paced)
      paced = undefined
      const { exchanges, historyBlocks, historyBase } = reported.current
      const bounds = node.getBoundingClientRect()
      // A collapsed/covered pane hasn't proved a new reading location. The
      // lease remains conservative until the actual transcript is painted.
      if (!node.clientHeight || !node.clientWidth || !node.isConnected) return
      if (windowed && performance.now() - keptRowsAt >= KEEP_ROWS_MS) {
        keptRowsAt = performance.now()
        keepMeasured(readingSource, rows.itemSizeCache, exchanges, reported.current.rowKey)
      }
      const elements = Array.from(node.querySelectorAll<HTMLElement>("[data-exchange]"))
      const visible = elements.filter(element => {
        const rect = element.getBoundingClientRect()
        return rect.bottom > bounds.top && rect.top < bounds.bottom
      })
      for (const element of elements) {
        const id = element.getAttribute("data-exchange")
        if (id && !element.hasAttribute("data-unloaded")) heights.current.set(`${readingSource}:${id}`, element.getBoundingClientRect().height)
      }
      const ids = visible.flatMap(element => {
        const id = element.getAttribute("data-exchange")
        return id ? [id] : []
      })
      const held = readingAnchor.current
      // Reporting and layout correction use the same reading position. A
      // control click may have chosen a preview away from the pane's center.
      const snapshot = held?.exchangeId && elements.some(element => element.getAttribute("data-exchange") === held.exchangeId)
        ? held : captureAnchor(node, [], false)
      const anchorTurn = snapshot.exchangeId ?? ids[0]
      const anchorElement = anchorTurn ? elements.find(element => element.getAttribute("data-exchange") === anchorTurn) : undefined
      const block = snapshot.block && anchorElement ? snapshot.block.preview !== undefined
        ? { kind: "preview" as const, ...snapshot.block.preview, offset: snapshot.block.offset }
        : { index: Array.from(anchorElement.querySelectorAll(TEXT_BLOCKS)).indexOf(snapshot.block.element),
            text: (snapshot.block.element.textContent ?? "").slice(0, 160), offset: snapshot.block.offset }
        : undefined
      const first = exchanges.findIndex(exchange => exchange.id === ids[0])
      const last = exchanges.findIndex(exchange => exchange.id === ids.at(-1))
      const neighboring = first < 0 || last < 0 ? [] : exchanges.slice(
        Math.max(0, first - (direction.current === "up" ? 6 : 3)),
        last + (direction.current === "down" ? 7 : 4)).map(exchange => exchange.id)
      const nearby = [...new Set([...neighboring, ...elements.flatMap(element => {
        const rect = element.getBoundingClientRect()
        const id = element.getAttribute("data-exchange")
        return id && rect.bottom > bounds.top - LOAD_AHEAD && rect.top < bounds.bottom + LOAD_AHEAD ? [id] : []
      })])]
      const selection = document.getSelection()
      const selecting = !!selection && !selection.isCollapsed &&
        (node.contains(selection.anchorNode) || node.contains(selection.focusNode))
      // Focus resting in a turn keeps that turn; it isn't a reason to keep every other. A selection may span any of them.
      const focused = document.activeElement?.closest("[data-exchange]")
      const focusedTurn = focused && node.contains(focused) ? focused.getAttribute("data-exchange") : null
      const moving = userScrolling.current || scrollMotion.current || awaitingEarlier.current || !!pendingJump.current || !!bookmarkRestore.current
      followed = pinned.current && !moving
      // Nothing may come to say a jump or a page has since landed: what was said as moving is said again within a second.
      if (moving) paced = setTimeout(schedule, ROW_CHECK_MS)
      lease.report({ visible: ids, nearby: focusedTurn ? [...nearby, focusedTurn] : nearby,
        anchor: anchorTurn ? { turn: anchorTurn, offset: snapshot.exchangeOffset ?? 0, block } : undefined,
        following: pinned.current, moving,
        interacting: selecting, window: historyBlocks !== undefined && historyBase !== undefined ? { blocks: historyBlocks, base: historyBase } : undefined })
      if (anchorTurn) setActiveTurn(current => current === anchorTurn ? current : anchorTurn)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(report) }
    // Anything but a followed end growing is said at once: the reader left it, or nothing has been said yet.
    const growth = () => {
      if (!followed || !pinned.current) schedule()
      else paced ??= setTimeout(() => {
        paced = undefined
        schedule()
      }, ROW_CHECK_MS)
    }
    reportReading.current = schedule
    reportGrowth.current = growth
    const resize = new ResizeObserver((entries) => {
      // The pane's own size is the reader's doing or the window's; the column's is the transcript growing.
      if (entries.some((entry) => entry.target === node)) schedule()
      else growth()
    })
    resize.observe(node)
    if (node.firstElementChild) resize.observe(node.firstElementChild)
    document.addEventListener("selectionchange", schedule)
    node.addEventListener("focusin", schedule)
    node.addEventListener("focusout", schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(paced)
      reportReading.current = () => {}
      reportGrowth.current = () => {}
      resize.disconnect()
      document.removeEventListener("selectionchange", schedule)
      node.removeEventListener("focusin", schedule)
      node.removeEventListener("focusout", schedule)
    }
    // `identity` and `isEmpty`: the column observed is that conversation's, once it has turns.
  }, [readingSource, paneKey, windowed, rows, identity, isEmpty])

  // The answers of the turns about to mount are parsed ahead, in the prose worker: the ones waiting for an idle moment
  // after an open, nearest the end first, and the few either side of a window's mounted rows, nearest first.
  const firstRow = windowed ? virtualRows[0]?.index : undefined
  const lastRow = windowed ? virtualRows.at(-1)?.index : undefined
  useEffect(() => {
    const { exchanges } = reported.current
    const coming: number[] = []
    if (firstRow !== undefined && lastRow !== undefined)
      for (let step = 1; step <= PARSED_AHEAD; step += 1) coming.push(firstRow - step, lastRow + step)
    else for (let index = hidden + undrawn - 1; index >= hidden; index -= 1) coming.push(index)
    const texts = coming.flatMap((index) => drawnProse(exchanges[index]?.response ?? []))
    if (texts.length) warmSettledProse(texts)
  }, [firstRow, lastRow, hidden, undrawn])

  // The turns on the page changed, or what a report says of them did: a turn arrived or left, a stream began or
  // ended, rows mounted, more of the transcript drawn, the history's window moved.
  const turnCount = exchanges.length
  useLayoutEffect(() => {
    reportReading.current()
  }, [turnCount, streamingId, mountedKeys, undrawn, hidden, historyBlocks, historyBase])

  useEffect(() => {
    const pane = readerPane.current
    return () => transcriptReaders.forgetPane(pane)
  }, [])

  useLayoutEffect(() => {
    restore.current = null
    pendingJump.current = null
    userScrolling.current = false
    scrollMotion.current = false
    readingAnchor.current = null
    restoringReader.current = null
    pinned.current = true
    const bookmark = transcriptReaders.bookmark(readingSource, paneKey)
    bookmarkRestore.current = bookmark?.following ? undefined : bookmark?.anchor
    if (bookmarkRestore.current) pinned.current = false
    awaitingEarlier.current = false
    sawLoading.current = false
    stalled.current = false
    setTail({ limit: INITIAL_TURNS, last: undefined })
    setEverMore(false)
    setShowJump(false)
    viewport.current?.removeAttribute("data-preserve-scroll")
    viewport.current?.removeAttribute("data-reading-anchor")
  }, [identity, readingSource, paneKey])

  // Before the first paint of a conversation, and of its first turns when it
  // opened empty: the reader starts at the end, never among the first turns.
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node || isEmpty || !pinned.current) return
    const end = layOutEnd(node)
    endSpare.current = end.spare
    node.scrollTop = node.scrollHeight
    owned(node)
    return end.release
    // Again for each count raised before that paint (`stage.fills`): the end is laid out over the turns just drawn.
  }, [identity, isEmpty, owned, stage.fills])

  // Still before that paint: the turns drawn first fill the pane with a pane's worth above them, or more are drawn now
  // and the end laid out again. Painted short of that, the newest turn would move as the rest arrived above it.
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node || !staging || !pinned.current) return
    const want = Math.ceil(node.clientHeight / ESTIMATED_ROW)
    const spare = endSpare.current
    if (spare >= want) return
    const { shown, undrawn } = staged.current
    const to = Math.max(0, undrawn - (spare < 0 ? shown.length - undrawn : want - spare))
    setStage((current) => current.identity !== identity || current.first === null ? current
      : { ...current, first: to ? shown[to]!.id : null, fills: current.fills + 1 })
  }, [identity, isEmpty, staging, stage.fills])

  // The rest are drawn a few at a time while the page has nothing else to do. They arrive above the reader.
  useEffect(() => {
    if (!staging) return
    return whenIdle(() => setStage((current) => {
      if (current.identity !== identity || current.first === null) return current
      const { shown, undrawn } = staged.current
      const to = undrawn - IDLE_TURNS
      return { ...current, first: to > 0 ? shown[to]!.id : null }
    }))
  }, [identity, staging, stage.first])

  // In the commit that draws them, the end is followed again, or the reader's place kept: the column and its offset
  // agree before anything reads the page, so no frame, painted or measured, has the turns on screen moved down by the
  // ones that just arrived above. Under a finger the end waits for it to lift, as it does everywhere (`pin`).
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node || windowed || isEmpty) return
    if (!pinned.current) holdReader(node)
    else if (!touching.current) {
      node.scrollTop = node.scrollHeight
      owned(node)
    }
  }, [undrawn, windowed, isEmpty, owned, holdReader])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    let lastHeight = node.scrollHeight
    let shrinkFrame = 0
    const pin = () => {
      // The reader moved toward earlier turns and its scroll event is still to come (iOS moves the scroller first):
      // they're leaving the end, and following it now would take their move back.
      if (pinned.current && (userScrolling.current || scrollMotion.current || touching.current) && leftEnd(node, lastScrollTop.current) &&
        node.scrollHeight - node.scrollTop - node.clientHeight >= LEFT_END)
        pinned.current = false
      keepSendRoom(node)
      const column = node.firstElementChild
      const spacer = steadyEnd.current
      if (spacer && column instanceof HTMLElement) {
        if (pinned.current) {
          // A transcript followed at its end never moves back under the reader: a column that got shorter (a sending
          // row giving way to its turn's own) keeps its height as room at the end, which what it writes next fills.
          // At another width every line has flowed again (a phone turned sideways, a pane resized), and a height from
          // before says nothing of what's under the reader: kept, it would leave the end blank. Windowed rows take their
          // new sizes after this first reads the width, so the frame after it is that same reflow, and no shrink.
          // Rows still at their estimate aren't height the column had: one measured below it is no shrink.
          const natural = column.offsetHeight
          const measured = natural - estimated.current()
          const width = column.offsetWidth
          if (width !== highWaterWidth.current) reflow()
          highWater.current = reflowing.current ? measured : Math.max(highWater.current, measured)
          highWaterWidth.current = width
          spacer.style.height = `${highWater.current - measured}px`
        } else {
          // Away from the end, the room kept there goes: nothing the reader sees moves.
          highWater.current = column.offsetHeight - estimated.current()
          highWaterWidth.current = column.offsetWidth
          spacer.style.height = "0px"
        }
      }
      settleShrink()
      if (!pinned.current) {
        holdReader(node)
        // The end grows away from a reader resting just short of it, with no scroll of theirs to show the way back.
        const away = node.scrollHeight - node.scrollTop - node.clientHeight >= NEAR_BOTTOM
        setShowJump((current) => current || away)
        return
      }
      // Under a finger the end waits for it to lift, and is followed then.
      if (touching.current) return
      node.scrollTop = node.scrollHeight
      owned(node)
    }
    followEnd.current = pin
    // Safari leaves a scroller that just got shorter (a finished turn folding up) past its new end, blank under the last
    // message until the next touch, worst while it still glides. Stopping the scroll for a frame makes it take the end.
    const settleShrink = () => {
      const height = node.scrollHeight
      const shrank = height < lastHeight
      lastHeight = height
      const end = Math.max(0, height - node.clientHeight)
      // Safari may already read back the clamped offset while still drawing the old one, so a drop in height near the
      // end counts though the offset looks right; one far above the end leaves a reader's own glide alone.
      if (!(shrank && node.scrollTop > end - node.clientHeight) && node.scrollTop <= end) return
      // A scrollbar that takes width (Linux, Windows, a Mac set to always show them) gives that width back while the
      // scroll is stopped: the pane and every line in it resize inside the observer that called this, which Chromium
      // reports as a ResizeObserver loop, and the column flows twice in a frame. Its gutter is kept for that frame.
      if (node.offsetWidth > node.clientWidth) node.style.scrollbarGutter = "stable"
      node.style.overflowY = "hidden"
      node.scrollTop = Math.min(node.scrollTop, end)
      cancelAnimationFrame(shrinkFrame)
      shrinkFrame = requestAnimationFrame(() => {
        shrinkFrame = 0
        node.style.overflowY = ""
        node.style.scrollbarGutter = ""
      })
    }
    pin()
    // Observers run after layout and before paint. Turns revealed by
    // content-visibility in that same frame must not paint at a stale offset.
    const grown = new ResizeObserver(pin)
    grown.observe(node)
    if (node.firstElementChild) grown.observe(node.firstElementChild)
    // Two inline bodies can resize in opposite directions while the column
    // and even the turn keep the same height. Observe their actual flow boxes
    // as well; total transcript height alone cannot describe reading geometry.
    const boxes = new Set<Element>()
    const observeBodies = (body: Element) => {
      const next = [...body.querySelectorAll(INLINE_FLOW_BOXES)]
      if (body.matches(INLINE_FLOW_BOXES)) next.push(body)
      for (const box of next) if (!boxes.has(box)) { grown.observe(box); boxes.add(box) }
    }
    observeBodies(node)
    const structure = new MutationObserver((mutations) => {
      // Streaming/highlighting must not rescan the entire mounted transcript.
      // Discover only added subtrees and release observations of removed boxes.
      if (mutations.some(mutation => mutation.removedNodes.length > 0))
        for (const box of boxes) if (!node.contains(box)) { grown.unobserve(box); boxes.delete(box) }
      for (const mutation of mutations)
        for (const added of mutation.addedNodes) if (added instanceof Element) observeBodies(added)
      // Equal-height text replacements and body remounts can move content
      // without resizing any existing box. React batches these mutations.
      pin()
    })
    structure.observe(node, { childList: true, characterData: true, subtree: true })
    return () => { structure.disconnect(); grown.disconnect(); cancelAnimationFrame(shrinkFrame); node.style.overflowY = ""; node.style.scrollbarGutter = "" }
  }, [identity, isEmpty, owned, holdReader, keepSendRoom])

  // A turn arrived at the end, opened by a message the person just sent (the one the panel names, or one still in
  // this window's outbox, which no request says yet), under a reader following the end: it goes near the top.
  const endTurn = useRef({ identity, newest })
  useLayoutEffect(() => {
    const was = endTurn.current
    endTurn.current = { identity, newest }
    if (was.identity !== identity) {
      sentTurn.current = null
      if (sendRoom.current) sendRoom.current.style.height = "0px"
      return
    }
    if (was.newest === newest || was.newest === undefined || !pinned.current) return
    const turn = exchanges.at(-1)
    const request = turn?.prompt?.requestId
    if (!turn || !request || exchanges.at(-2)?.id !== was.newest) return
    if (turn.id !== sentId && (!askedAt || askedAt.has(request))) return
    sentTurn.current = turn.id
    followEnd.current()
  }, [identity, newest, exchanges, sentId, askedAt])

  /*
   * The rows are held against the virtualizer before a frame paints (`row-check.ts`): all of them when rows come or
   * go, when the reader scrolls, and each second; and when something changes inside rows, those rows alone. A stream
   * changes its one row a frame apart for as long as it runs, and holding every mounted row against the virtualizer
   * for each of those frames read all their boxes twice to learn about one. The end followed under that stream is the
   * transcript's own scroll, and checks nothing: a row it brings in is a change to the list.
   */
  useEffect(() => {
    const node = viewport.current
    const list = node?.querySelector("[data-virtual-transcript]")
    if (!windowed || !node || !list) return
    let frame = 0
    /** The rows changed since the last look, or every row. */
    let changed: Set<Element> | "all" = "all"
    const look = () => {
      frame = 0
      const only = changed === "all" ? undefined : changed
      changed = new Set()
      if (mountedRows.current(only)) soon("all")
    }
    const soon = (rows: Iterable<Element> | "all") => {
      if (rows === "all") changed = "all"
      else if (changed !== "all") for (const row of rows) changed.add(row)
      frame ||= requestAnimationFrame(look)
    }
    const changes = new MutationObserver((mutations) => {
      const rows = new Set<Element>()
      for (const mutation of mutations) {
        if (mutation.target === list) return soon("all")
        let row: Element | null = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement
        while (row && row.parentElement !== list) row = row.parentElement
        if (row) rows.add(row)
      }
      if (rows.size) soon(rows)
    })
    changes.observe(list, { childList: true, characterData: true, subtree: true })
    const scrolled = () => {
      if (pinned.current && node.scrollTop === lastOwnScrollTop.current) return
      soon("all")
    }
    node.addEventListener("scroll", scrolled, { passive: true })
    const steady = setInterval(() => soon("all"), ROW_CHECK_MS)
    soon("all")
    return () => {
      changes.disconnect()
      node.removeEventListener("scroll", scrolled)
      clearInterval(steady)
      cancelAnimationFrame(frame)
    }
  }, [windowed, identity, isEmpty])

  const endEarlier = useCallback((progressed: boolean) => {
    awaitingEarlier.current = false
    sawLoading.current = false
    if (!progressed) stalled.current = true
    const node = viewport.current
    if (node)
      requestAnimationFrame(() => {
        if (viewport.current !== node || awaitingEarlier.current) return
        node.removeAttribute("data-preserve-scroll")
        restore.current = null
        if (!pinned.current) readingAnchor.current = captureAnchor(node, [], false)
      })
  }, [])

  useLayoutEffect(() => {
    if (!awaitingEarlier.current || loadingEarlier) return
    const snapshot = restore.current
    const node = viewport.current
    if (!node) return
    if (!snapshot) {
      // The reader jumped elsewhere while the page was on its way; there is
      // no position left to hold.
      endEarlier(true)
      return
    }
    const progressed =
      snapshot.shown !== shown.length ||
      snapshot.hasEarlier !== hasEarlier ||
      snapshot.head !== headOf(shown)
    if (!progressed) return
    const settled: ScrollAnchor = {
      ...snapshot,
      shown: shown.length,
      hasEarlier,
      head: headOf(shown),
    }
    if (pinned.current) {
      // A short conversation filling its pane: the reader is at the end and
      // stays there while history arrives above.
      node.scrollTop = node.scrollHeight
      owned(node)
      endEarlier(true)
      return
    }
    if (windowed && snapshot.exchangeId) {
      const index = exchanges.findIndex(
        (exchange) => exchange.id === snapshot.exchangeId
      )
      if (index >= 0) seek(index)
      requestAnimationFrame(() => {
        if (restore.current !== snapshot || viewport.current !== node) return
        preserveScrollAnchor(node, snapshot)
        endSeek(node)
        owned(node)
        restore.current = settled
      })
      endEarlier(true)
      return
    }
    holdPrependedHeights(node, snapshot.exchangeId)
    preserveScrollAnchor(node, snapshot)
    owned(node)
    restore.current = settled
    endEarlier(true)
  }, [loadingEarlier, shown, hasEarlier, exchanges, windowed, seek, endSeek, endEarlier, owned])

  const requestEarlier = useCallback(() => {
    const node = viewport.current
    if (!node || awaitingEarlier.current || stalled.current || loadingEarlier)
      return
    if (!more) return
    const begin = () => {
      awaitingEarlier.current = true
      restore.current = captureAnchor(node, shown, hasEarlier)
      node.setAttribute("data-preserve-scroll", "")
    }
    if (hidden > 0) {
      begin()
      setTail((current) => ({ ...current, limit: current.limit + MORE_TURNS }))
      return
    }
    if (!onLoadEarlier) return
    begin()
    const id = ++flight.current
    void onLoadEarlier()
      .catch(() => {})
      .finally(() => {
        // The source answered without changing anything the transcript
        // shows — an empty page, a refused request — so nothing above will
        // settle this request; end it here, after any render it did cause.
        setTimeout(() => {
          if (awaitingEarlier.current && flight.current === id)
            endEarlier(false)
        }, 0)
      })
  }, [
    more,
    hidden,
    hasEarlier,
    loadingEarlier,
    onLoadEarlier,
    shown,
    endEarlier,
  ])

  const maybeLoadEarlier = useCallback(() => {
    const node = viewport.current
    const mark = edgeRow.current
    if (!node || !mark || isEmpty || !more) return
    // The top on screen isn't the top yet while turns already held are still being drawn above it.
    if (staging) return
    if (awaitingEarlier.current || stalled.current || loadingEarlier) return
    // A reader following the end of a transcript that fills the pane is not
    // near its top, whatever the edge measures: turns offscreen still stand
    // at placeholder heights, so a few long turns read as a short climb and
    // every open fetched a page nobody asked for.
    if (pinned.current && node.scrollHeight > node.clientHeight + 1) return
    const distance =
      node.getBoundingClientRect().top - mark.getBoundingClientRect().bottom
    if (distance > LOAD_AHEAD) return
    requestEarlier()
  }, [isEmpty, more, staging, loadingEarlier, requestEarlier])
  useEffect(() => {
    wake.current = maybeLoadEarlier
  })

  useEffect(() => {
    if (loadingEarlier) {
      sawLoading.current = true
      return
    }
    // The load finished and the layout pass above found nothing new.
    if (awaitingEarlier.current && sawLoading.current) endEarlier(false)
    maybeLoadEarlier()
  }, [
    loadingEarlier,
    shown.length,
    hasEarlier,
    exchanges,
    hidden,
    maybeLoadEarlier,
    endEarlier,
  ])

  useEffect(() => {
    const node = viewport.current
    const mark = edgeRow.current
    if (!node || !mark) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) wake.current()
      },
      { root: node, rootMargin: `${LOAD_AHEAD}px 0px 0px 0px`, threshold: 0 }
    )
    observer.observe(mark)
    return () => observer.disconnect()
  }, [identity, edge, isEmpty])

  /**
   * Put a turn at the top and make it the reading position, so the turns
   * around it taking their real sizes keep it there. Instant: a smooth
   * scroll aims at where placeholder heights put the turn, and lands short.
   */
  const land = useCallback((element: Element) => {
    const node = viewport.current
    if (!node) return
    element.scrollIntoView({ behavior: "auto", block: "start" })
    // Measurement reconciliation must no longer own the old index target.
    endSeek(node)
    readingAnchor.current = captureAnchor(node, [], false, element)
    node.setAttribute("data-reading-anchor", "")
    owned(node)
  }, [owned, endSeek])

  const jump = useCallback(
    (id: string, restoring = false) => {
      if (!restoring) {
        bookmarkRestore.current = undefined
        if (!awaitingEarlier.current) viewport.current?.removeAttribute("data-preserve-scroll")
      }
      restore.current = null
      readingAnchor.current = null
      restoringReader.current = null
      pendingJump.current = null
      userScrolling.current = false
      scrollMotion.current = false
      pinned.current = false
      const index = exchanges.findIndex((exchange) => exchange.id === id)
      if (index < 0) return
      if (windowed) {
        // The virtualizer owns reconciliation while rows are measured. A
        // second jump must replace that target even if its row is mounted.
        pendingJump.current = id
        seek(index)
        return
      }
      if (index < hidden) {
        pendingJump.current = id
        setTail((current) => ({ ...current, limit: exchanges.length - index }))
        return
      }
      // One of the turns still waiting to be drawn: they all are now, and the jump lands once it's there.
      if (index < hidden + undrawn) {
        pendingJump.current = id
        setStage((current) => current.identity === identity ? { ...current, first: null } : current)
        return
      }
      const element = viewport.current?.querySelector(
        `[data-exchange="${CSS.escape(id)}"]`
      )
      if (element) land(element)
    },
    [exchanges, hidden, undrawn, identity, windowed, seek, land]
  )

  useLayoutEffect(() => {
    const bookmark = bookmarkRestore.current
    if (!bookmark || pendingJump.current) return
    // Revealing earlier rows can change `jump` without changing the saved
    // turn. A second top-of-turn landing would erase the paragraph offset.
    if (readingAnchor.current?.exchangeId === bookmark.turn) return
    if (!exchanges.some(exchange => exchange.id === bookmark.turn)) {
      if (hasEarlier && !loadingEarlier) requestEarlier()
      else if (!hasEarlier && !loadingEarlier && !isEmpty) {
        // Its source removed the old turn. Retain reading mode at the nearest
        // available boundary; never silently resume following new output.
        bookmarkRestore.current = { turn: exchanges[0]!.id, offset: bookmark.offset }
        jump(exchanges[0]!.id, true)
      }
      return
    }
    jump(bookmark.turn, true)
    // `jump` may land synchronously; apply the saved in-turn offset below.
  }, [exchanges, jump, hasEarlier, loadingEarlier, isEmpty, requestEarlier])

  useLayoutEffect(() => {
    const id = pendingJump.current
    if (!id) return
    const element = viewport.current?.querySelector(
      `[data-exchange="${CSS.escape(id)}"]`
    )
    if (!element) return
    pendingJump.current = null
    land(element)
  }, [jump, land, mountedKeys])

  useLayoutEffect(() => {
    const bookmark = bookmarkRestore.current
    const node = viewport.current
    if (!bookmark || !node || pendingJump.current) return
    const exchange = exchanges.find(item => item.id === bookmark.turn)
    if (!exchange || exchange.unloaded !== undefined) return
    const element = node.querySelector(`[data-exchange="${CSS.escape(bookmark.turn)}"]`)
    if (!element) return
    // Measure the saved content after intrinsic placeholders have given
    // way to real layout, before choosing any offset.
    node.setAttribute("data-preserve-scroll", "")
    const blocks = Array.from(element.querySelectorAll(TEXT_BLOCKS))
    const saved = bookmark.block
    const text = saved?.kind !== "preview" ? saved : undefined
    const candidate = text ? blocks[text.index] : undefined
    const block = saved?.kind === "preview" ? element.querySelectorAll(previewSelector(saved))[saved.index]
      : text && (candidate?.textContent ?? "").slice(0, 160) === text.text ? candidate
      : text ? blocks.find(item => (item.textContent ?? "").slice(0, 160) === text.text) : undefined
    const target = block ?? element
    node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top -
      (block && saved ? saved.offset : bookmark.offset)
    endSeek(node)
    owned(node)
    readingAnchor.current = { ...captureAnchor(node, [], false), exchangeId: bookmark.turn,
      exchangeOffset: element.getBoundingClientRect().top - node.getBoundingClientRect().top,
      block: block && saved ? { element: block, offset: saved.offset,
        preview: saved.kind === "preview" ? { type: saved.type, path: saved.path, index: saved.index } : undefined } : undefined }
    node.setAttribute("data-reading-anchor", "")
    // This is a structural replacement, just like a prepend. Keep the saved
    // content anchored while intrinsic heights and row measurements settle.
    let remaining = 4
    const settle = () => {
      if (bookmarkRestore.current !== bookmark || viewport.current !== node) return
      holdReader(node)
      if (--remaining > 0) { requestAnimationFrame(settle); return }
      if (!awaitingEarlier.current) node.removeAttribute("data-preserve-scroll")
      holdReader(node)
      bookmarkRestore.current = undefined
      reportReading.current()
    }
    requestAnimationFrame(settle)
  }, [exchanges, hidden, mountedKeys, endSeek, owned, holdReader])

  // Registered once: a stream renders the transcript every batch, and registering again each time sets every
  // command's reader (the palette) to work through the whole list.
  const moving = useRef({ activeTurn, exchanges, jump })
  moving.current = { activeTurn, exchanges, jump }
  // The navigator's jump, the same function for the transcript's life: `jump` changes with every streamed batch, and the
  // navigator, memoized on its props, would otherwise draw again for each.
  const jumpTo = useCallback((id: string) => moving.current.jump(id), [])
  useEffect(() => {
    const move = (offset: number) => {
      const { activeTurn, exchanges, jump } = moving.current
      if (!exchanges.length) return
      const at = exchanges.findIndex((exchange) => exchange.id === activeTurn)
      const from = at < 0 ? exchanges.length - 1 : at
      const next = Math.min(exchanges.length - 1, Math.max(0, from + offset))
      jump(exchanges[next]!.id)
    }
    return registerCommands([
      {
        id: "transcript.previous-prompt",
        title: "Previous prompt",
        section: "View",
        keys: "mod+arrowup",
        run: () => move(-1),
      },
      {
        id: "transcript.next-prompt",
        title: "Next prompt",
        section: "View",
        keys: "mod+arrowdown",
        run: () => move(1),
      },
    ])
  }, [])

  const showNavigator = navigates && !isEmpty && exchanges.length >= 3
  const navigatorPrompts = useNavigatorPrompts(exchanges)
  // The same object for a turn that woke the same way: the turns change with every paced frame of a stream, and a new
  // object for each made every turn that followed a day's rest draw again with them.
  const wokeBefore = useRef<ReadonlyMap<string, WokeAfterRest>>(NO_WOKE)
  const woke = useMemo(() => {
    wokeBefore.current = keptEntries(wokeBefore.current, wokeAfterRest(exchanges, askedAt), sameWoke)
    return wokeBefore.current
  }, [exchanges, askedAt])
  const renderExchange = (exchange: ExchangeData) => exchange.unloaded !== undefined ? (
    <ReleasedExchange key={keys.get(exchange.id) ?? exchange.id} id={exchange.id} label={exchange.unloaded}
      height={heights.current.get(`${readingSource}:${exchange.id}`) ?? 360} viewport={viewport.current}
      load={() => source.liveId ? loadReleasedLiveTurn(source.liveId, exchange.id)
        : source.threadPath ? loadReleasedThreadTurn(source.threadPath, exchange.id) : Promise.resolve()} />
  ) : exchange.run ? (
    <ReportRun key={keys.get(exchange.id) ?? exchange.id} exchange={exchange} />
  ) : (
    <Exchange
      key={keys.get(exchange.id) ?? exchange.id}
      exchange={exchange}
      streaming={exchange.id === streamingId}
      // How the turn stands is its newest part's: a stop it went on from is over.
      interrupted={
        interruptedRequests?.get(turnRequest(exchange) ?? "") ??
        (exchange.id === interruptedId || exchangeInterrupted(exchange))
      }
      sentByMako={makoPrompts?.get(exchange.prompt?.requestId ?? "")}
      carried={carriedHistories?.get(exchange.prompt?.requestId ?? "")}
      woke={woke.get(exchange.id)}
      failed={exchange.id === failedId}
    />
  )

  return (
    <TranscriptSourceContext value={sourceValue}>
      <div
        ref={pane}
        className="scroll-fade-scope relative flex min-h-0 flex-1 flex-col"
      >
        <Slot name="transcript.overlay" conversationId={sourceValue.liveId} />
        <span ref={topFade} aria-hidden className="scroll-fade-top" />
        <div
          ref={viewport}
          data-transcript-viewport=""
          tabIndex={0}
          role="region"
          aria-label="Conversation transcript"
          data-virtualized={windowed ? "" : undefined}
          onPointerDown={onPointerDown}
          onPointerUp={(event) => {
            pressing.current = false
            if (event.pointerType === "mouse") userScrolling.current = false
            // A settle that came due during the press waited for this: with no `scrollend`, nothing else would end it.
            settleInput()
            reportReading.current()
          }}
          onPointerCancel={() => {
            pressing.current = false
            settleInput()
          }}
          onTouchStart={(event) => {
            // Before the finger counts as down: the end is still written for the turns this draws.
            drawAll()
            touching.current = event.touches.length > 0
          }}
          onTouchEnd={lifted}
          onTouchCancel={lifted}
          onScroll={onScroll}
          onScrollEnd={() => {
            if (touching.current) return
            if (userScrolling.current || scrollMotion.current) onScroll()
            userScrolling.current = false
            scrollMotion.current = false
            reportReading.current()
          }}
          onKeyUp={() => {
            if (userScrolling.current) onScroll()
            userScrolling.current = false
            reportReading.current()
          }}
          onKeyDown={(event) => {
            if (
              [
                "PageUp",
                "PageDown",
                "Home",
                "End",
                "ArrowUp",
                "ArrowDown",
                " ",
              ].includes(event.key) &&
              event.target instanceof HTMLElement &&
              !event.target.closest(
                "button,input,textarea,[contenteditable=true]"
              )
            ) {
              if (event.key === "End") {
                event.preventDefault()
                scrollToEnd()
                return
              }
              drawAll()
              if (viewport.current) endSeek(viewport.current)
              pendingJump.current = null
              bookmarkRestore.current = undefined
              if (!awaitingEarlier.current) viewport.current?.removeAttribute("data-preserve-scroll")
              restoringReader.current = null
              userScrolling.current = true
              stalled.current = false
              if (
                ["PageUp", "Home", "ArrowUp"].includes(event.key) ||
                (event.key === " " && event.shiftKey)
              )
                pinned.current = false
            }
          }}
          onWheel={onWheel}
          style={{ paddingInlineEnd: showNavigator ? NAVIGATOR_WIDTH : 0 }}
          className="scroll-fade-scroller group/transcript min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {isEmpty ? (
            empty
          ) : (
            <div
              key={identity}
              className={cn(
                entrance && "animate-thread",
                "mx-auto flex w-full max-w-content flex-col gap-7 px-6 py-6"
              )}
            >
              {edge ? (
                <HistoryEdge ref={edgeRow} state={edgeState} opening={opening} />
              ) : opening ? (
                <HistoryEdge state="start" opening={opening} />
              ) : null}
              {/* One tree either way: a turn on screen as the column crosses into a window is the same element after it. */}
              {windowed ? (
                <div ref={rows.containerRef} data-virtual-transcript style={{ position: "relative" }}>
                  {virtualRows.map((row) => (
                    <div
                      key={row.key}
                      data-index={row.index}
                      ref={measureRow}
                      style={{ position: "absolute", top: 0, left: 0, width: "100%" }}
                    >
                      {renderExchange(exchanges[row.index]!)}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ display: "contents" }}>
                  {drawn.map((exchange) => (
                    <div key={keys.get(exchange.id) ?? exchange.id} style={{ display: "contents" }}>
                      {renderExchange(exchange)}
                    </div>
                  ))}
                </div>
              )}
              {footer}
            </div>
          )}
          {isEmpty ? null : <div ref={sendRoom} aria-hidden data-send-room />}
          {transcriptEnd && !isEmpty ? <div ref={steadyEnd} aria-hidden data-steady-end /> : null}
        </div>
        {showNavigator ? (
          <TurnNavigator
            exchanges={navigatorPrompts}
            activeId={activeTurn}
            onJump={jumpTo}
            paneRef={pane}
          />
        ) : null}
        {transcriptEnd ? null : (
          <div
            data-transcript-jump
            inert={!showJump}
            style={{
              left: `calc(50% - ${showNavigator ? NAVIGATOR_WIDTH / 2 : 0}px)`,
            }}
            className={cn(
              "absolute bottom-3 flex -translate-x-1/2 items-end gap-2",
              "[transition:opacity_180ms_var(--ease-out),transform_180ms_var(--ease-out)]",
              showJump ? "pointer-events-auto opacity-100" : "pointer-events-none translate-y-1 opacity-0"
            )}
          >
            <button
              type="button"
              onClick={() => scrollToEnd("smooth")}
              aria-hidden={!showJump}
              tabIndex={showJump ? 0 : -1}
              className="pressable flex h-7 items-center gap-1.5 rounded-full bg-raised px-3 text-ui whitespace-nowrap text-muted-foreground ring-1 ring-hairline"
            >
              <ArrowDownIcon className="size-3" />
              Jump to latest
              {arrived > 0 ? <span data-jump-new={arrived} className="tabular text-foreground">· {arrived} new</span> : null}
            </button>
            {showJump ? beside : null}
          </div>
        )}
      </div>
    </TranscriptSourceContext>
  )
}

function sameWoke(left: WokeAfterRest, right: WokeAfterRest): boolean {
  return left.restedMs === right.restedMs && left.lastAt === right.lastAt && left.harness === right.harness
}

function exchangeInterrupted(exchange: ExchangeData): boolean {
  const from = continuedFrom(exchange)
  return exchange.system.some((note) => note.after >= from && isInterruptedNote(note.message))
}
