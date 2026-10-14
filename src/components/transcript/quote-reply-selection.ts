import type { DeskCommand } from "@/extend/commands"
import type { ContextInput } from "@/lib/context-detail"
import { quoteContext, quoteText, type QuoteBoundary } from "@/lib/quote-selection"
import { acpStore } from "@/state/acp-state"
import { addContext } from "@/state/composer-context"
import { quoteConversation, type QuoteSource } from "@/state/quote-reply"
import { threadsStore } from "@/state/threads"

/**
 * What the Quote in reply button and command read of the document's
 * selection (`quote-reply.tsx` draws the button).
 *
 * Selecting words inside an answer's prose (`Prose` with `answerId`, which
 * marks its root `data-answer`) makes them quotable; tool rows, reasoning and
 * the person's own prompt carry no mark, so a selection starting there is not.
 *
 * One `selectionchange` listener serves every transcript on screen and does
 * its work at most once a frame, only while something is selected: a token
 * streaming into an answer with nothing selected costs nothing here. The
 * quote's text is read only when it is taken.
 */

export const QUOTE_COMMAND_ID = "transcript.quote-selection"
export const QUOTE_KEYS = "mod+shift+'"
const ANSWER = "[data-answer]"
const TOOLBAR = "[data-quote-toolbar]"
/** The button's height and its distance from the selection, in pixels. */
const TOOLBAR_HEIGHT = 28
const TOOLBAR_GAP = 6
export const EDGE = 8

interface Selected {
  range: Range
  /** The answer the selection starts in. */
  answer: HTMLElement
}

/** Each mounted transcript pane and the conversation it shows, so a quote can say where it came from. */
const panes = new Map<HTMLElement, () => QuoteSource>()
const subscribers = new Set<() => void>()
let current: Selected | null = null
/**
 * The last quotable selection, kept while focus sits in a dialog: opening the
 * palette moves the document's selection into its search field, and the
 * command chosen there still means the words that were selected.
 */
let held: Selected | null = null
let pressing = false
let frame = 0
let installed: (() => void) | null = null

function elementOf(node: Node): Element | null {
  return node instanceof Element ? node : node.parentElement
}

/** The selection, when it starts in an answer's prose and ends within the same exchange. */
function selectedAnswer(range: Range): Selected | null {
  if (range.collapsed) return null
  const answer = elementOf(range.startContainer)?.closest<HTMLElement>(ANSWER)
  const exchange = answer?.closest("[data-exchange]")
  const end = elementOf(range.endContainer)
  if (!answer || !exchange || !end || !exchange.contains(end)) return null
  return { range, answer }
}

function liveSelection(): Selected | null {
  const selection = document.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null
  return selectedAnswer(selection.getRangeAt(0))
}

function inDialog(): boolean {
  return Boolean(document.activeElement?.closest('[role="dialog"]'))
}

function refresh() {
  frame = 0
  current = liveSelection()
  if (current) held = { range: current.range.cloneRange(), answer: current.answer }
  else if (!inDialog()) held = null
  for (const notify of subscribers) notify()
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(refresh)
}

/** Scrolling and resizing move a shown button; with nothing selected they do nothing. */
function follow() {
  if (current) schedule()
}

function press(event: PointerEvent) {
  if (event.target instanceof Element && event.target.closest(TOOLBAR)) return
  pressing = true
}

function release() {
  if (!pressing) return
  pressing = false
  schedule()
}

function install(): () => void {
  document.addEventListener("selectionchange", schedule)
  document.addEventListener("pointerdown", press, true)
  document.addEventListener("pointerup", release, true)
  document.addEventListener("pointercancel", release, true)
  document.addEventListener("scroll", follow, { capture: true, passive: true })
  window.addEventListener("resize", follow)
  return () => {
    cancelAnimationFrame(frame)
    frame = 0
    document.removeEventListener("selectionchange", schedule)
    document.removeEventListener("pointerdown", press, true)
    document.removeEventListener("pointerup", release, true)
    document.removeEventListener("pointercancel", release, true)
    document.removeEventListener("scroll", follow, true)
    window.removeEventListener("resize", follow)
    current = null
    held = null
  }
}

export function subscribe(notify: () => void): () => void {
  subscribers.add(notify)
  installed ??= install()
  return () => {
    subscribers.delete(notify)
    if (subscribers.size > 0) return
    installed?.()
    installed = null
  }
}

/** The boundary of `range` at `edge` when it falls inside `root`; outside, the walk runs to that edge of it. */
function boundaryIn(root: Element, range: Range, edge: "start" | "end"): QuoteBoundary | undefined {
  const node = edge === "start" ? range.startContainer : range.endContainer
  if (!root.contains(node)) return undefined
  return { node, offset: edge === "start" ? range.startOffset : range.endOffset }
}

/** What quoting `selected` would add: every answer it crosses in its exchange, tool rows and prompts left out. */
export function quoteInput(selected: Selected): ContextInput | null {
  const { range, answer } = selected
  if (!answer.isConnected) return null
  const exchange = answer.closest("[data-exchange]")
  const answers = exchange
    ? Array.from(exchange.querySelectorAll<HTMLElement>(ANSWER)).filter((element) => range.intersectsNode(element))
    : [answer]
  const text = answers
    .map((element) => quoteText(element, boundaryIn(element, range, "start"), boundaryIn(element, range, "end")))
    .filter(Boolean)
    .join("\n\n")
  const pane = [...panes.keys()].find((element) => element.contains(answer))
  const source = pane ? (panes.get(pane)?.() ?? {}) : {}
  return quoteContext(
    text,
    answer.getAttribute("data-answer") ?? undefined,
    quoteConversation(source, acpStore.get(), threadsStore.get())
  )
}

/** Quote what is selected, or what was selected before a dialog took focus. False when there was nothing to quote. */
export function quoteSelection(): boolean {
  const selected = liveSelection() ?? (held?.answer.isConnected ? held : null)
  const input = selected ? quoteInput(selected) : null
  held = null
  if (!input) return false
  addContext(input)
  document.getSelection()?.removeAllRanges()
  return true
}

export const quoteSelectionCommand: DeskCommand = {
  id: QUOTE_COMMAND_ID,
  title: "Quote selection in reply",
  section: "Session",
  keys: QUOTE_KEYS,
  keywords: "quote reply cite selection answer context chip",
  when: () => Boolean(liveSelection() ?? (held?.answer.isConnected ? held : null)),
  run: () => void quoteSelection(),
}

export interface Spot {
  /** The point the button centres on, from the pane's top left. */
  x: number
  y: number
  side: "top" | "bottom"
}

interface LineExtent {
  left: number
  right: number
}

/** The horizontal extent of the selected line that holds `edge`: every rect on that line, joined. */
function lineAround(rects: readonly DOMRect[], edge: DOMRect): LineExtent {
  const middle = edge.top + edge.height / 2
  const line = rects.filter((rect) => rect.top <= middle && rect.bottom >= middle)
  return { left: Math.min(...line.map((rect) => rect.left)), right: Math.max(...line.map((rect) => rect.right)) }
}

/** Where the button goes for a selection in `pane`: above its first line, or below its last when the top has no room. */
function spotFor(pane: HTMLElement, range: Range): Spot | null {
  // Slivers (a line's trailing newline, an empty inline box) would pull the button to a line's edge.
  const rects = Array.from(range.getClientRects()).filter((rect) => rect.width >= 2 && rect.height > 0)
  const first = rects[0]
  const last = rects.at(-1)
  if (!first || !last) return null
  const bounds = pane.getBoundingClientRect()
  // Gone past an edge of the pane: no button floating over nothing.
  if (last.bottom < bounds.top || first.top > bounds.bottom) return null
  const above = first.top - bounds.top - TOOLBAR_GAP - TOOLBAR_HEIGHT
  if (above >= EDGE) {
    const line = lineAround(rects, first)
    return { x: (line.left + line.right) / 2 - bounds.left, y: above, side: "top" }
  }
  const line = lineAround(rects, last)
  return {
    x: (line.left + line.right) / 2 - bounds.left,
    y: Math.min(Math.max(last.bottom - bounds.top + TOOLBAR_GAP, EDGE), bounds.height - TOOLBAR_HEIGHT - EDGE),
    side: "bottom",
  }
}

/** Say which conversation `pane` shows, for as long as it is mounted. */
export function registerPane(pane: HTMLElement, source: () => QuoteSource): () => void {
  panes.set(pane, source)
  return () => {
    panes.delete(pane)
  }
}

/** Where `pane` shows its button now: nowhere while a press is still selecting, or when the selection is elsewhere. */
export function placementIn(pane: HTMLElement): Spot | null {
  if (pressing || !current || !pane.contains(current.answer)) return null
  return spotFor(pane, current.range)
}

