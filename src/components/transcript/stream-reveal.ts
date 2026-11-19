import { useEffect, useLayoutEffect, useRef, type RefObject } from "react"
import { RevealPace } from "@/lib/reveal-pace"

/**
 * A streaming answer's newest words fade in at a steady pace (`RevealPace`), with nothing added to the page for it.
 * The text is in the document as soon as it's painted, parsed at the pace it always was; what isn't revealed yet is
 * drawn transparent, and what just was, at a few steps of the way to its colour, through the CSS Custom Highlight
 * API: ranges over the text nodes already there, restyled each frame. No element per word, no parse per frame, and a
 * row's height is what it would be without the reveal. A browser without the API shows the text as it lands.
 *
 * The highlights are named `mako-reveal-*` (index.css), apart from any other use of the registry: one for what's
 * still hidden, and `FADE_STEPS` for what was revealed in each of the last few slices of `FADE_STEP_MS`.
 */
const FADE_STEPS = 4
const FADE_STEP_MS = 45
const HIDDEN = "mako-reveal-hidden"
const fadeName = (step: number) => `mako-reveal-${step}`

/** One streaming answer's ranges: what's hidden, then each fade step from the newest. */
interface Reveal {
  ranges: Range[]
}

const reveals = new Set<Reveal>()
let registered: Highlight[] | undefined

function registry(): Highlight[] | undefined {
  if (registered) return registered
  if (!globalThis.CSS?.highlights || !globalThis.Highlight) return undefined
  registered = [HIDDEN, ...Array.from({ length: FADE_STEPS }, (_, step) => fadeName(step))].map((name) => {
    const highlight = new Highlight()
    CSS.highlights.set(name, highlight)
    return highlight
  })
  return registered
}

function attach(reveal: Reveal): void {
  const highlights = registry()
  if (!highlights) return
  reveals.add(reveal)
  for (const [index, range] of reveal.ranges.entries()) highlights[index]!.add(range)
}

function detach(reveal: Reveal): void {
  if (!reveals.delete(reveal) || !registered) return
  for (const [index, range] of reveal.ranges.entries()) registered[index]!.delete(range)
}

/** The text nodes the reveal runs over, the last first, as far back as `chars` characters. */
function tail(root: Element, chars: number): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  let node = walker.lastChild()
  let held = 0
  while (node && held < chars) {
    // SAFETY: the walker shows text nodes only.
    const text = node as Text
    nodes.push(text)
    held += text.length
    node = walker.previousNode()
  }
  return nodes
}

/** Where `fromEnd` characters before the end of the text is, among `nodes` (the last first). */
function place(nodes: readonly Text[], fromEnd: number): [Text, number] | undefined {
  let left = fromEnd
  for (const node of nodes) {
    if (left <= node.length) return [node, node.length - left]
    left -= node.length
  }
  const first = nodes.at(-1)
  return first ? [first, 0] : undefined
}

interface Revealing {
  pace: RevealPace
  reveal: Reveal
  frame: number
  /** The characters of text under the root, as of its last paint. */
  length: number
  /** How much was shown, and when, over the last fade: where each step of it begins. */
  shown: { at: number; length: number }[]
  /** Whether the answer still streams: once it doesn't, the reveal ends when everything is shown. */
  streaming: boolean
  /** When the ranges were last moved, and where to: a frame that would move none is left alone. */
  drawnAt: number
  edges: number[]
}

/** The reveal moves at most this often: a 120 Hz display's every frame is more than a fade's steps can show. */
const DRAW_EVERY_MS = 14

/**
 * Reveals the text under `root` as it grows while `streaming`. `chars` changes with each paint of new text, which is
 * what wakes it: the length it paces by is the document's own.
 */
export function useStreamReveal(root: RefObject<HTMLElement | null>, streaming: boolean, chars: number): void {
  const state = useRef<Revealing | null>(null)

  // Before the paint that brings new text: it's hidden from its first frame, and the frames after reveal it.
  useLayoutEffect(() => {
    const node = root.current
    if (!node) return
    let held = state.current
    if (!held) {
      if (!streaming || !registry() || document.hidden || matchMedia("(prefers-reduced-motion: reduce)").matches) return
      const reveal = { ranges: Array.from({ length: FADE_STEPS + 1 }, () => new Range()) }
      held = state.current = { pace: new RevealPace(), reveal, frame: 0, length: 0, shown: [], streaming, drawnAt: 0, edges: [] }
      attach(reveal)
    }
    const length = node.textContent?.length ?? 0
    const now = performance.now()
    // What was already there when the stream was first seen is shown: only what comes after is revealed.
    if (!held.shown.length) held.pace.showAll(length, now)
    else held.pace.arrived(length, now)
    held.length = length
    held.streaming = streaming
    // The turn settled: what's left is shown within the drain, then the ranges go.
    if (!streaming) held.pace.drain(now)
    draw(node, held, now)
    const next = () => {
      const current = state.current
      const element = root.current
      if (!current || !element) return
      current.frame = 0
      const at = performance.now()
      if (at - current.drawnAt >= DRAW_EVERY_MS) draw(element, current, at)
      // Until everything is shown and its fade has run out.
      if (!current.pace.caughtUp || current.shown.length > 1) current.frame = requestAnimationFrame(next)
      else if (!current.streaming) state.current = ended(current)
    }
    if (!held.frame) held.frame = requestAnimationFrame(next)
  }, [root, streaming, chars])

  // Unmounted, or a tab gone to the background: everything shows.
  useEffect(() => {
    const hidden = () => {
      if (document.hidden && state.current) state.current = ended(state.current)
    }
    document.addEventListener("visibilitychange", hidden)
    return () => {
      document.removeEventListener("visibilitychange", hidden)
      if (state.current) state.current = ended(state.current)
    }
  }, [])
}

/** The reveal is over: its ranges leave the highlights, and everything under its root shows. */
function ended(held: Revealing): null {
  cancelAnimationFrame(held.frame)
  detach(held.reveal)
  return null
}

function draw(root: HTMLElement, held: Revealing, now: number): void {
  let shown = held.pace.step(now)
  const hidden = held.length - shown
  const last = held.shown.at(-1)?.length ?? shown
  const nodes = tail(root, held.length - Math.min(shown, held.shown[0]?.length ?? shown) + 64)
  // Whole words: the reveal runs on to the next space, so no word is drawn half there.
  if (hidden > 0) {
    let run = ""
    let left = hidden
    for (const node of nodes) {
      const take = Math.min(left, node.length)
      run = node.data.slice(node.length - take) + run
      left -= take
      if (!left) break
    }
    const space = run.search(/\s/)
    shown = space < 0 ? held.length : shown + space
  }
  shown = Math.min(held.length, Math.max(shown, last))
  if (held.shown.at(-1)?.length !== shown) held.shown.push({ at: now, length: shown })
  // The newest sample older than each step's age is where that step begins.
  while (held.shown.length > 1 && now - held.shown[1]!.at >= FADE_STEPS * FADE_STEP_MS) held.shown.shift()
  if (held.shown.length === 1 && now - held.shown[0]!.at >= FADE_STEPS * FADE_STEP_MS) held.shown[0] = { at: now, length: shown }
  const edges = [held.length, shown]
  for (let step = 1; step <= FADE_STEPS; step += 1) {
    const before = held.shown.findLast((sample) => now - sample.at >= step * FADE_STEP_MS) ?? held.shown[0]!
    edges.push(Math.min(edges.at(-1)!, before.length))
  }
  held.drawnAt = now
  // The length is among them: the same edges over a text that grew are other places.
  const moved = edges.length !== held.edges.length || edges.some((edge, index) => edge !== held.edges[index])
  held.edges = edges
  if (!moved && held.reveal.ranges[0]!.endContainer.isConnected) return
  for (const [index, range] of held.reveal.ranges.entries()) {
    const end = place(nodes, held.length - edges[index]!)
    const start = place(nodes, held.length - edges[index + 1]!)
    if (!start || !end) continue
    range.setStart(start[0], start[1])
    range.setEnd(end[0], end[1])
  }
}
