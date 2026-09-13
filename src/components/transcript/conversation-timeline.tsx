import { Slot } from "@/extend/slot"
import { useVirtualizer } from "@tanstack/react-virtual"
import { registerCommands } from "@/extend/commands"
import {
  TranscriptSourceContext,
  type TranscriptSource,
} from "./source-context"
import type { ReactNode, Ref, WheelEvent as ReactWheelEvent } from "react"
import {
  useCallback,
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
import { useOrbTheme } from "@/components/ui/use-orb-theme"
import { LEAD_EXCHANGE_ID, type Exchange as ExchangeData } from "@/lib/exchanges"
import type { TurnStop } from "@/state/prompt-delivery"
import { cn } from "@/lib/utils"
import { ArrowDownIcon } from "lucide-react"
import { ThinkingOrb } from "thinking-orbs"

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

interface ScrollAnchor {
  exchangeId?: string
  exchangeOffset?: number
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
 * The reading position, as the first exchange still on screen and its offset
 * from the top of the scrollport. The lead exchange cannot serve: history
 * prepended to an agent-first session lands inside it, so its top moves.
 */
function captureAnchor(
  node: HTMLDivElement,
  shown: ExchangeData[],
  hasEarlier: boolean
): ScrollAnchor {
  const viewportTop = node.getBoundingClientRect().top
  const anchor = Array.from(node.querySelectorAll("[data-exchange]")).find(
    (element) =>
      element.getAttribute("data-exchange") !== LEAD_EXCHANGE_ID &&
      element.getBoundingClientRect().bottom > viewportTop + 1
  )
  return {
    exchangeId: anchor?.getAttribute("data-exchange") ?? undefined,
    exchangeOffset: anchor
      ? anchor.getBoundingClientRect().top - viewportTop
      : undefined,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop,
    shown: shown.length,
    hasEarlier,
    head: headOf(shown),
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
  ref,
}: {
  state: HistoryEdgeState
  ref: Ref<HTMLDivElement>
}) {
  const theme = useOrbTheme()
  return (
    <div
      ref={ref}
      data-earlier={state}
      role={state === "loading" ? "status" : undefined}
      className="flex h-7 shrink-0 items-center gap-3 text-label text-faint"
    >
      {state === "loading" ? (
        <span className="animate-enter mx-auto flex items-center gap-2">
          <ThinkingOrb
            state="breathing"
            size={20}
            theme={theme}
            aria-hidden
            className="activity-orb shrink-0"
          />
          <span>Loading earlier turns…</span>
        </span>
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
  failedId,
  empty,
  footer,
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
  failedId?: string
  empty: ReactNode
  footer?: ReactNode
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
  const pinned = useRef(true)
  const userScrolling = useRef(false)
  const lastScrollTop = useRef(0)
  const restore = useRef<ScrollAnchor | null>(null)
  const pendingJump = useRef<string | null>(null)
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
  const [limit, setLimit] = useState(INITIAL_TURNS)
  const [everMore, setEverMore] = useState(false)
  const windowed = exchanges.length > 200
  const hidden = windowed ? 0 : Math.max(0, exchanges.length - limit)
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
    getItemKey: (index) => exchanges[index]!.id,
    overscan: 6,
    scrollMargin: edge ? 80 : 24,
    useAnimationFrameWithResizeObserver: true,
  })
  const virtualRows = rows.getVirtualItems()
  const mountedKeys = windowed
    ? virtualRows.map((row) => row.key).join("\0")
    : ""

  useEffect(() => {
    if (more) setEverMore(true)
  }, [more, identity])

  const scrollToEnd = useCallback((behavior: ScrollBehavior = "auto") => {
    const node = viewport.current
    if (!node) return
    restore.current = null
    userScrolling.current = false
    pinned.current = true
    node.scrollTo({ top: node.scrollHeight, behavior })
    lastScrollTop.current = node.scrollTop
    setShowJump(false)
  }, [])

  const onScroll = useCallback(() => {
    const node = viewport.current
    if (!node) return
    topFade.current?.toggleAttribute("data-scrolled", node.scrollTop > 0.5)
    const movingUp = node.scrollTop < lastScrollTop.current - 0.5
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    const atBottom = distance < NEAR_BOTTOM
    if (userScrolling.current) pinned.current = !movingUp && atBottom
    lastScrollTop.current = node.scrollTop
    // A reader who keeps scrolling while a page is on its way moves the
    // position that page must be placed around.
    if (awaitingEarlier.current && restore.current && !pinned.current) {
      const { shown, hasEarlier, head } = restore.current
      restore.current = { ...captureAnchor(node, [], hasEarlier), shown, head }
    }
    const show = !pinned.current && !atBottom
    setShowJump((current) => (current === show ? current : show))
    // A reader scrolling again after a stalled request asks once more; the
    // edge observer alone stays silent while the edge never left view.
    if (userScrolling.current) wake.current()
  }, [])

  const onWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    userScrolling.current = true
    stalled.current = false
    if (!awaitingEarlier.current) restore.current = null
    if (event.deltaY < 0) pinned.current = false
  }, [])

  const onPointerDown = useCallback(() => {
    userScrolling.current = true
    stalled.current = false
    if (!awaitingEarlier.current) restore.current = null
  }, [])

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
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort(
            (left, right) =>
              left.boundingClientRect.top - right.boundingClientRect.top
          )[0]
        const id = visible?.target.getAttribute("data-exchange")
        if (id) setActiveTurn(id)
      },
      { root: node, rootMargin: "-10% 0px -70% 0px", threshold: 0 }
    )
    for (const element of node.querySelectorAll("[data-exchange]")) {
      observer.observe(element)
    }
    return () => observer.disconnect()
  }, [shown.length, mountedKeys])

  useLayoutEffect(() => {
    restore.current = null
    pendingJump.current = null
    userScrolling.current = false
    pinned.current = true
    awaitingEarlier.current = false
    sawLoading.current = false
    stalled.current = false
    setLimit(INITIAL_TURNS)
    setEverMore(false)
    setShowJump(false)
    const node = viewport.current
    if (!node) return
    node.removeAttribute("data-preserve-scroll")
    node.scrollTop = node.scrollHeight
    lastScrollTop.current = node.scrollTop
  }, [identity])

  useEffect(() => {
    const node = viewport.current
    if (!node) return
    const pin = () => {
      if (!pinned.current) {
        if (restore.current) {
          preserveScrollAnchor(node, restore.current)
          lastScrollTop.current = node.scrollTop
        }
        return
      }
      node.scrollTop = node.scrollHeight
      lastScrollTop.current = node.scrollTop
    }
    pin()
    let frame: number | null = null
    const grown = new ResizeObserver(() => {
      frame ??= requestAnimationFrame(() => {
        frame = null
        pin()
      })
    })
    grown.observe(node)
    if (node.firstElementChild) grown.observe(node.firstElementChild)
    return () => {
      grown.disconnect()
      if (frame !== null) cancelAnimationFrame(frame)
    }
  }, [identity, isEmpty])

  const endEarlier = useCallback((progressed: boolean) => {
    awaitingEarlier.current = false
    sawLoading.current = false
    if (!progressed) stalled.current = true
    const node = viewport.current
    if (node)
      requestAnimationFrame(() => node.removeAttribute("data-preserve-scroll"))
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
      lastScrollTop.current = node.scrollTop
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
        lastScrollTop.current = node.scrollTop
        restore.current = settled
      })
      endEarlier(true)
      return
    }
    holdPrependedHeights(node, snapshot.exchangeId)
    preserveScrollAnchor(node, snapshot)
    lastScrollTop.current = node.scrollTop
    restore.current = settled
    endEarlier(true)
  }, [
    loadingEarlier,
    shown,
    hasEarlier,
    exchanges,
    windowed,
    rows,
    endEarlier,
  ])

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
      setLimit((current) => current + MORE_TURNS)
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
  }, [more, hidden, hasEarlier, loadingEarlier, onLoadEarlier, shown, endEarlier])

  const maybeLoadEarlier = useCallback(() => {
    const node = viewport.current
    const mark = edgeRow.current
    if (!node || !mark || isEmpty || !more) return
    if (awaitingEarlier.current || stalled.current || loadingEarlier) return
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

  const jump = useCallback(
    (id: string, behavior: ScrollBehavior = "smooth") => {
      restore.current = null
      userScrolling.current = false
      pinned.current = false
      const index = exchanges.findIndex((exchange) => exchange.id === id)
      if (index < 0) return
      if (windowed) {
        const element = viewport.current?.querySelector(
          `[data-exchange="${CSS.escape(id)}"]`
        )
        if (element)
          element.scrollIntoView({ behavior: "auto", block: "start" })
        else {
          pendingJump.current = id
          rows.scrollToIndex(index, { align: "start", behavior: "auto" })
        }
        return
      }
      if (index < hidden) {
        pendingJump.current = id
        setLimit(exchanges.length - index)
        return
      }
      viewport.current
        ?.querySelector(`[data-exchange="${CSS.escape(id)}"]`)
        ?.scrollIntoView({
          behavior: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? "auto"
            : behavior,
          block: "start",
        })
    },
    [exchanges, hidden, windowed, rows]
  )

  useLayoutEffect(() => {
    const id = pendingJump.current
    if (!id) return
    const element = viewport.current?.querySelector(
      `[data-exchange="${CSS.escape(id)}"]`
    )
    if (!element) return
    pendingJump.current = null
    element.scrollIntoView({ behavior: "auto", block: "start" })
  }, [jump, mountedKeys])

  useEffect(() => {
    const move = (offset: number) => {
      if (!exchanges.length) return
      const at = exchanges.findIndex((exchange) => exchange.id === activeTurn)
      const from = at < 0 ? exchanges.length - 1 : at
      const next = Math.min(exchanges.length - 1, Math.max(0, from + offset))
      jump(exchanges[next]!.id, "auto")
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
  const renderExchange = (exchange: ExchangeData) => (
    <Exchange
      key={exchange.id}
      exchange={exchange}
      streaming={exchange.id === streamingId}
      interrupted={
        interruptedRequests?.get(exchange.prompt?.requestId ?? "") ??
        (exchange.id === interruptedId || exchangeInterrupted(exchange))
      }
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
          onPointerDown={onPointerDown}
          onPointerUp={(event) => {
            if (event.pointerType === "mouse") userScrolling.current = false
          }}
          onScroll={onScroll}
          onScrollEnd={() => {
            userScrolling.current = false
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
              userScrolling.current = true
              stalled.current = false
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
              {edge ? <HistoryEdge ref={edgeRow} state={edgeState} /> : null}
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
  return exchange.system.some((message) =>
    message.blocks.some((block) => {
      const text = block.type === "text" ? block.text : undefined
      return text ? /^Interrupted(?:\s|$)/i.test(text.trim()) : false
    })
  )
}
