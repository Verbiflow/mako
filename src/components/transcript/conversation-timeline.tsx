import { Slot } from "@/extend/slot"
import { elementScroll, useVirtualizer } from "@tanstack/react-virtual"
import { registerCommands } from "@/extend/commands"
import {
  TranscriptSourceContext,
  type TranscriptSource,
} from "./source-context"
import type { ReactNode, Ref, WheelEvent as ReactWheelEvent } from "react"
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
import {
  NAVIGATOR_WIDTH,
  TurnNavigator,
} from "@/components/transcript/turn-navigator"
import {
  LEAD_EXCHANGE_ID,
  isInterruptedNote,
  renamedExchanges,
  type Exchange as ExchangeData,
} from "@/lib/exchanges"
import type { MakoPrompt, TurnStop } from "@/state/prompt-delivery"
import { cn } from "@/lib/utils"
import { ArrowDownIcon } from "lucide-react"
import { Orb } from "@/components/ui/orb/orb"
import { liveReadingSource, nativeReadingSource, transcriptReaders, type TranscriptReading } from "@/state/transcript-reading"
import { loadReleasedLiveTurn } from "@/state/live-history"
import { loadReleasedThreadTurn } from "@/state/thread-viewing"
import { toast } from "sonner"
import { TranscriptPaneContext } from "@/state/conversation-scope"

const NEAR_BOTTOM = 96

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
  /** A mounted text block holds a position inside a turn, not just between turns. */
  block?: { element: Element; offset: number }
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

/**
 * The reading position, as a painted text block and its turn (or the turn
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
    document.elementFromPoint(viewport.left + viewport.width / 2, y)
      ?.closest("p,pre,li,td,h1,h2,h3,h4,h5,h6")
  let block = painted?.closest("p,pre,li,td,h1,h2,h3,h4,h5,h6")
  // The middle of the pane can land in a paragraph's margin. Nearby painted
  // text is a better anchor than the container of an entire long answer.
  for (
    let offset = 8;
    !block && offset <= Math.min(48, viewport.height / 2);
    offset += 8
  )
    block = blockAt(viewport.top + viewport.height / 2 + offset) ??
      blockAt(viewport.top + viewport.height / 2 - offset)
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
      ? { element: readingBlock, offset: readingBlock.getBoundingClientRect().top - viewportTop }
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
function layOutEnd(node: HTMLDivElement): () => void {
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
  return () => {
    cancelAnimationFrame(frame)
    for (const turn of settling) turn.removeAttribute("data-settling")
  }
}

function holdPrependedHeights(node: HTMLDivElement, exchangeId?: string) {
  if (!exchangeId) return
  for (const element of node.querySelectorAll("[data-exchange]")) {
    if (element.getAttribute("data-exchange") === exchangeId) break
    element.setAttribute("data-preserve-height", "")
  }
}

function preserveScrollAnchor(node: HTMLDivElement, snapshot: ScrollAnchor) {
  const block = snapshot.block
  if (block?.element.isConnected && node.contains(block.element)) {
    node.scrollTop += block.element.getBoundingClientRect().top -
      node.getBoundingClientRect().top - block.offset
    return
  }
  const anchor = snapshot.exchangeId
    ? node.querySelector(`[data-exchange="${CSS.escape(snapshot.exchangeId)}"]`)
    : null
  if (anchor && snapshot.exchangeOffset !== undefined) {
    const offset =
      anchor.getBoundingClientRect().top - node.getBoundingClientRect().top
    node.scrollTop += offset - snapshot.exchangeOffset
  } else {
    node.scrollTop =
      snapshot.scrollTop + (node.scrollHeight - snapshot.scrollHeight)
  }
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
    void load().catch(error => {
      setFailed(true)
      toast.error(error instanceof Error ? error.message : String(error))
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
  exchanges,
  streamingId,
  interruptedId,
  interruptedRequests,
  makoPrompts,
  failedId,
  empty,
  footer,
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
  failedId?: string
  empty: ReactNode
  footer?: ReactNode
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
  const sourceValue = useMemo(
    () => ({ threadPath: source.threadPath, liveId: source.liveId }),
    [source.threadPath, source.liveId]
  )
  const pane = useRef<HTMLDivElement>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const topFade = useRef<HTMLSpanElement>(null)
  const edgeRow = useRef<HTMLDivElement>(null)
  const windowed = exchanges.length > 200
  const pinned = useRef(true)
  const userScrolling = useRef(false)
  // Pointer/key release ends input ownership, but scroll motion can continue.
  // Cleanup waits for the browser's scrollend rather than that earlier release.
  const scrollMotion = useRef(false)
  const lastScrollTop = useRef(0)
  /**
   * The offset the timeline last scrolled to itself. Any other scroll — the
   * reader's, the virtualizer's, the browser's for focus or find — moves the
   * reading position, which must follow it.
   */
  const ownScrollTop = useRef<number | null>(null)
  const owned = useCallback((node: HTMLDivElement) => {
    lastScrollTop.current = node.scrollTop
    ownScrollTop.current = node.scrollTop
  }, [])
  const restore = useRef<ScrollAnchor | null>(null)
  const readingAnchor = useRef<ScrollAnchor | null>(null)
  const restoringReader = useRef<ScrollAnchor | null>(null)
  const pendingJump = useRef<string | null>(null)
  const readerPane = useRef(Symbol("transcript pane"))
  const persistentPane = useContext(TranscriptPaneContext)
  const paneKey = persistentPane ?? readerPane.current
  const bookmarkRestore = useRef<TranscriptReading["anchor"]>(undefined)
  const reportReading = useRef<() => void>(() => {})
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
  const isEmpty = exchanges.length === 0
  const more = hidden > 0 || hasEarlier
  const edge = more || everMore || exchanges.length > INITIAL_TURNS
  const edgeState: HistoryEdgeState = loadingEarlier
    ? "loading"
    : more
      ? "more"
      : "start"
  const rows = useVirtualizer({
    count: exchanges.length,
    enabled: windowed,
    getScrollElement: () => viewport.current,
    estimateSize: () => 360,
    getItemKey: (index) => keys.get(exchanges[index]!.id) ?? exchanges[index]!.id,
    overscan: 6,
    scrollMargin: edge ? 80 : 24,
    useAnimationFrameWithResizeObserver: true,
    scrollToFn: (offset, options, instance) => {
      elementScroll(offset, options, instance)
      if (viewport.current) owned(viewport.current)
    },
  })
  /** Virtual rows and page insertion need explicit anchoring; normal flow uses the browser. */
  const holdReader = useCallback(
    (node: HTMLDivElement) => {
      if (!windowed && !awaitingEarlier.current && !bookmarkRestore.current) return
      const snapshot = restore.current ?? readingAnchor.current
      if (
        userScrolling.current || scrollMotion.current ||
        !snapshot?.exchangeId ||
        !node.querySelector(
          `[data-exchange="${CSS.escape(snapshot.exchangeId)}"]`
        )
      )
        return
      preserveScrollAnchor(node, snapshot)
      // Replace the virtualizer's outstanding target so it cannot undo the
      // offset just restored inside the answer.
      if (windowed) rows.scrollToOffset(node.scrollTop, { behavior: "auto" })
      owned(node)
    },
    [owned, windowed, rows]
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
  }, [identity, exchanges, keys, renamed, holdReader])
  const previousWindowed = useRef(windowed)
  useLayoutEffect(() => {
    if (previousWindowed.current === windowed) return
    previousWindowed.current = windowed
    const node = viewport.current,
      snapshot = readingAnchor.current
    if (!node || awaitingEarlier.current) return
    if (pinned.current) {
      if (windowed) rows.scrollToEnd({ behavior: "auto" })
      else node.scrollTop = node.scrollHeight
      return
    }
    if (!snapshot?.exchangeId) return
    const index = exchanges.findIndex(
      (exchange) => exchange.id === snapshot.exchangeId
    )
    if (index < 0) return
    if (windowed)
      rows.scrollToIndex(index, { align: "start", behavior: "auto" })
    else if (index < hidden)
      setTail((current) => ({ ...current, limit: exchanges.length - index }))
    restoringReader.current = snapshot
  }, [windowed, rows, exchanges, hidden])
  const virtualRows = rows.getVirtualItems()
  const mountedKeys = windowed
    ? virtualRows.map((row) => row.key).join("\0")
    : ""

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
    if (windowed) rows.scrollToOffset(node.scrollTop, { behavior: "auto" })
    owned(node)
    readingAnchor.current = snapshot
    restoringReader.current = null
  }, [mountedKeys, shown.length, rows, windowed, owned])

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
      restoringReader.current = null
      pinned.current = true
      if (windowed) rows.scrollToEnd({ behavior: "auto" })
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
    [rows, windowed, owned]
  )

  const onScroll = useCallback(() => {
    const node = viewport.current
    if (!node) return
    topFade.current?.toggleAttribute("data-scrolled", node.scrollTop > 0.5)
    const movingUp = node.scrollTop < lastScrollTop.current - 0.5
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const atBottom = distance < NEAR_BOTTOM
    // Layout/virtualizer adjustments are not reader intent. Keyboard input
    // participates through the same explicit input handlers below.
    lastScrollTop.current = node.scrollTop
    const ours =
      ownScrollTop.current !== null &&
      Math.abs(node.scrollTop - ownScrollTop.current) < 1
    if (userScrolling.current && !ours) scrollMotion.current = true
    ownScrollTop.current = null
    if ((userScrolling.current || scrollMotion.current) && !ours) pinned.current = !movingUp && atBottom
    // A reader who keeps scrolling while a page is on its way moves the
    // position that page must be placed around.
    if (awaitingEarlier.current && restore.current && !pinned.current) {
      const { shown, hasEarlier, head } = restore.current
      restore.current = { ...captureAnchor(node, [], hasEarlier), shown, head }
    }
    if (
      !pinned.current &&
      !awaitingEarlier.current &&
      !pendingJump.current &&
      !bookmarkRestore.current &&
      !restoringReader.current &&
      (userScrolling.current || !ours || !readingAnchor.current)
    )
      readingAnchor.current = captureAnchor(node, [], false)
    else if (pinned.current) readingAnchor.current = null
    const show = !pinned.current && !atBottom
    setShowJump((current) => (current === show ? current : show))
    // A reader scrolling again after a stalled request asks once more; the
    // edge observer alone stays silent while the edge never left view.
    if (userScrolling.current) wake.current()
    reportReading.current()
  }, [])

  const onWheel = useCallback(
    (event: ReactWheelEvent<HTMLDivElement>) => {
      if (windowed && viewport.current)
        rows.scrollToOffset(viewport.current.scrollTop, { behavior: "auto" })
      bookmarkRestore.current = undefined
      if (!awaitingEarlier.current) viewport.current?.removeAttribute("data-preserve-scroll")
      pendingJump.current = null
      restoringReader.current = null
      readingAnchor.current = null
      userScrolling.current = true
      direction.current = event.deltaY < 0 ? "up" : "down"
      stalled.current = false
      if (!awaitingEarlier.current) restore.current = null
      if (event.deltaY < 0) pinned.current = false
      const node = viewport.current
      if (
        node &&
        ((event.deltaY < 0 && node.scrollTop <= 0) ||
          (event.deltaY > 0 &&
            node.scrollTop + node.clientHeight >= node.scrollHeight))
      )
        userScrolling.current = false
      reportReading.current()
    },
    [rows, windowed]
  )

  const onPointerDown = useCallback(() => {
    bookmarkRestore.current = undefined
    if (!awaitingEarlier.current) viewport.current?.removeAttribute("data-preserve-scroll")
    if (windowed && viewport.current)
      rows.scrollToOffset(viewport.current.scrollTop, { behavior: "auto" })
    pendingJump.current = null
    restoringReader.current = null
    readingAnchor.current = null
    userScrolling.current = true
    stalled.current = false
    if (!awaitingEarlier.current) restore.current = null
    reportReading.current()
  }, [rows, windowed])

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
  }, [identity, shown.length, mountedKeys])

  useLayoutEffect(() => {
    const node = viewport.current
    if (!node) return
    const lease = transcriptReaders.attach(readingSource, paneKey)
    let frame = 0
    const report = () => {
      frame = 0
      const bounds = node.getBoundingClientRect()
      // A collapsed/covered pane hasn't proved a new reading location. The
      // lease remains conservative until the actual transcript is painted.
      if (!node.clientHeight || !node.clientWidth || !node.isConnected) return
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
      const snapshot = captureAnchor(node, [], false)
      const anchorTurn = snapshot.exchangeId ?? ids[0]
      const anchorElement = anchorTurn ? elements.find(element => element.getAttribute("data-exchange") === anchorTurn) : undefined
      const block = snapshot.block && anchorElement ? {
        index: Array.from(anchorElement.querySelectorAll("p,pre,li,td,h1,h2,h3,h4,h5,h6")).indexOf(snapshot.block.element),
        text: (snapshot.block.element.textContent ?? "").slice(0, 160),
        offset: snapshot.block.offset,
      } : undefined
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
      const focus = document.activeElement
      const interacting = selecting || !!focus && focus !== node && node.contains(focus)
      lease.report({ visible: ids, nearby,
        anchor: anchorTurn ? { turn: anchorTurn, offset: snapshot.exchangeOffset ?? 0, block } : undefined,
        following: pinned.current, moving: userScrolling.current || scrollMotion.current || awaitingEarlier.current || !!pendingJump.current || !!bookmarkRestore.current,
        interacting, window: historyBlocks !== undefined && historyBase !== undefined ? { blocks: historyBlocks, base: historyBase } : undefined })
      if (anchorTurn) setActiveTurn(current => current === anchorTurn ? current : anchorTurn)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(report) }
    reportReading.current = schedule
    const resize = new ResizeObserver(schedule)
    resize.observe(node)
    if (node.firstElementChild) resize.observe(node.firstElementChild)
    document.addEventListener("selectionchange", schedule)
    node.addEventListener("focusin", schedule)
    node.addEventListener("focusout", schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      document.removeEventListener("selectionchange", schedule)
      node.removeEventListener("focusin", schedule)
      node.removeEventListener("focusout", schedule)
      lease.release()
    }
  }, [readingSource, exchanges, mountedKeys, paneKey, historyBlocks, historyBase])

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
  }, [identity, readingSource, paneKey])

  // Before the first paint of a conversation, and of its first turns when it
  // opened empty: the reader starts at the end, never among the first turns.
  useLayoutEffect(() => {
    const node = viewport.current
    if (!node || isEmpty || !pinned.current) return
    const release = layOutEnd(node)
    node.scrollTop = node.scrollHeight
    owned(node)
    return release
  }, [identity, isEmpty, owned])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const pin = () => {
      if (!pinned.current) {
        holdReader(node)
        return
      }
      node.scrollTop = node.scrollHeight
      owned(node)
    }
    pin()
    // Observers run after layout and before paint. Turns revealed by
    // content-visibility in that same frame must not paint at a stale offset.
    const grown = new ResizeObserver(pin)
    grown.observe(node)
    if (node.firstElementChild) grown.observe(node.firstElementChild)
    return () => grown.disconnect()
  }, [identity, isEmpty, owned, holdReader])

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
      if (index >= 0) rows.scrollToIndex(index, { align: "start" })
      requestAnimationFrame(() => {
        if (restore.current !== snapshot || viewport.current !== node) return
        preserveScrollAnchor(node, snapshot)
        rows.scrollToOffset(node.scrollTop, { behavior: "auto" })
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
  }, [loadingEarlier, shown, hasEarlier, exchanges, windowed, rows, endEarlier, owned])

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
  }, [isEmpty, more, loadingEarlier, requestEarlier])
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
    if (windowed) rows.scrollToOffset(node.scrollTop, { behavior: "auto" })
    readingAnchor.current = captureAnchor(node, [], false, element)
    owned(node)
  }, [owned, windowed, rows])

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
        rows.scrollToIndex(index, { align: "start", behavior: "auto" })
        return
      }
      if (index < hidden) {
        pendingJump.current = id
        setTail((current) => ({ ...current, limit: exchanges.length - index }))
        return
      }
      const element = viewport.current?.querySelector(
        `[data-exchange="${CSS.escape(id)}"]`
      )
      if (element) land(element)
    },
    [exchanges, hidden, windowed, rows, land]
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
    // Measure the saved paragraph after intrinsic placeholders have given
    // way to real layout, before choosing any offset.
    node.setAttribute("data-preserve-scroll", "")
    const blocks = Array.from(element.querySelectorAll("p,pre,li,td,h1,h2,h3,h4,h5,h6"))
    const saved = bookmark.block
    const candidate = saved ? blocks[saved.index] : undefined
    const block = saved && (candidate?.textContent ?? "").slice(0, 160) === saved.text ? candidate
      : saved ? blocks.find(item => (item.textContent ?? "").slice(0, 160) === saved.text) : undefined
    const target = block ?? element
    node.scrollTop += target.getBoundingClientRect().top - node.getBoundingClientRect().top -
      (block && saved ? saved.offset : bookmark.offset)
    if (windowed) rows.scrollToOffset(node.scrollTop, { behavior: "auto" })
    owned(node)
    readingAnchor.current = { ...captureAnchor(node, [], false), exchangeId: bookmark.turn,
      exchangeOffset: element.getBoundingClientRect().top - node.getBoundingClientRect().top,
      block: block && saved ? { element: block, offset: saved.offset } : undefined }
    // This is a structural replacement, just like a prepend. Keep the
    // semantic block anchored through measurement before native anchoring
    // takes over; releasing it in this layout pass let the browser choose
    // a different paragraph while intrinsic heights settled.
    node.setAttribute("data-preserve-scroll", "")
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
  }, [exchanges, hidden, mountedKeys, windowed, rows, owned, holdReader])

  useEffect(() => {
    const move = (offset: number) => {
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
  }, [activeTurn, exchanges, jump])

  const showNavigator = !isEmpty && exchanges.length >= 3
  const renderExchange = (exchange: ExchangeData) => exchange.unloaded !== undefined ? (
    <ReleasedExchange key={keys.get(exchange.id) ?? exchange.id} id={exchange.id} label={exchange.unloaded}
      height={heights.current.get(`${readingSource}:${exchange.id}`) ?? 360} viewport={viewport.current}
      load={() => source.liveId ? loadReleasedLiveTurn(source.liveId, exchange.id)
        : source.threadPath ? loadReleasedThreadTurn(source.threadPath, exchange.id) : Promise.resolve()} />
  ) : (
    <Exchange
      key={keys.get(exchange.id) ?? exchange.id}
      exchange={exchange}
      streaming={exchange.id === streamingId}
      interrupted={
        interruptedRequests?.get(exchange.prompt?.requestId ?? "") ??
        (exchange.id === interruptedId || exchangeInterrupted(exchange))
      }
      sentByMako={makoPrompts?.get(exchange.prompt?.requestId ?? "")}
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
          tabIndex={0}
          role="region"
          aria-label="Conversation transcript"
          data-virtualized={windowed ? "" : undefined}
          onPointerDown={onPointerDown}
          onPointerUp={(event) => {
            if (event.pointerType === "mouse") userScrolling.current = false
            reportReading.current()
          }}
          onScroll={onScroll}
          onScrollEnd={() => {
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
              if (windowed && viewport.current)
                rows.scrollToOffset(viewport.current.scrollTop, {
                  behavior: "auto",
                })
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
              {windowed ? (
                <div
                  data-virtual-transcript
                  style={{ height: rows.getTotalSize(), position: "relative" }}
                >
                  {virtualRows.map((row) => (
                    <div
                      key={row.key}
                      data-index={row.index}
                      ref={rows.measureElement}
                      style={{
                        position: "absolute",
                        top: 0,
                        left: 0,
                        width: "100%",
                        transform: `translateY(${row.start - rows.options.scrollMargin}px)`,
                        paddingBottom:
                          row.index < exchanges.length - 1 ? 28 : 0,
                      }}
                    >
                      {renderExchange(exchanges[row.index]!)}
                    </div>
                  ))}
                </div>
              ) : (
                shown.map(renderExchange)
              )}
              {footer}
            </div>
          )}
        </div>
        {showNavigator ? (
          <TurnNavigator
            exchanges={exchanges}
            activeId={activeTurn}
            onJump={jump}
            paneRef={pane}
          />
        ) : null}
        <button
          type="button"
          onClick={() => scrollToEnd("smooth")}
          aria-hidden={!showJump}
          tabIndex={showJump ? 0 : -1}
          style={{
            left: `calc(50% - ${showNavigator ? NAVIGATOR_WIDTH / 2 : 0}px)`,
          }}
          className={cn(
            "pressable absolute bottom-3 flex h-7 -translate-x-1/2 items-center gap-1.5 rounded-full",
            "bg-raised px-3 text-ui text-muted-foreground ring-1 ring-hairline",
            "[transition:opacity_180ms_var(--ease-out),transform_180ms_var(--ease-out)]",
            showJump
              ? "pointer-events-auto opacity-100"
              : "pointer-events-none translate-y-1 opacity-0"
          )}
        >
          <ArrowDownIcon className="size-3" />
          Jump to latest
        </button>
      </div>
    </TranscriptSourceContext>
  )
}

function exchangeInterrupted(exchange: ExchangeData): boolean {
  return exchange.system.some((note) => isInterruptedNote(note.message))
}
