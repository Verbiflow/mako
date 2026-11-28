import { createContext, use, useCallback, useLayoutEffect, useRef, type RefCallback, type RefObject } from "react"
import { EASE_OUT, EASE_SWIFT, motionMs, reducedMotion } from "@/lib/motion"

/**
 * What leaves the screen goes the way it came, quicker and quieter: a fade with a few pixels of travel (`--duration-menu-out`,
 * `--ease-swift`), and what stood beside it glides into the room it leaves (`--duration-panel-out`) instead of jumping.
 *
 * React takes an element out at once. Just before it does, the element's ref lets go (`useExit`), and a copy of it is put
 * in its place: a drawing, inert and hidden from assistive tech, with nothing of React's in it, so whatever the element
 * read from a store, it shows what it last showed. Before the frame paints (a microtask), every copy made in that commit
 * is lifted out of the flow at once, over where it stood; what moved because of it is read once, and starts from where
 * it was by `translate` alone, so nothing lays out frame by frame, however long the list. A transcript held at its end
 * under a prompt that leaves glides down with it, the viewport itself carried, never its rows, so the virtualizer
 * measures nothing new and keeps its anchor.
 *
 * Nothing leaves this way when the person didn't see it go: on another view of the same place (`ExitScene`, or a
 * `scene` that changed), when what held it leaves too (navigation, a reload), with the page hidden, under reduced
 * motion, off screen, or when a whole list goes at once. One that comes back while it leaves turns around from where
 * it's drawn (`key`).
 */

/** The copy's own travel: a row or card sinking a little (`sink`), a menu shrinking toward its corner (`shrink`), a floating card dropping (`drop`). */
export type ExitMotion = "sink" | "shrink" | "drop"

export interface ExitOptions {
  motion?: ExitMotion
  /**
   * Floats over the page (a menu over its button): when what held it goes in the same moment, the copy is drawn over
   * the page where it stood rather than going with it.
   */
  float?: boolean
  /** Sits under a transcript (a prompt, the queue): a transcript held at its end glides down into the room it leaves. */
  transcript?: boolean
  /** For an element that stays mounted while what it shows changes: the view it belongs to. Another one, and it doesn't play. */
  scene?: string | undefined
}

/** The glide of what stood beside a leaving element. `use-row-flip.ts` reads places only once these have settled. */
export const EXIT_GLIDE = "exit-glide"
/** On screen for less than this, it was a page settling (a load, a view filling in), not something to watch go. */
const SEEN_MS = 300
/** More leaving at once than this is a list replaced, not rows leaving. */
const MOST_AT_ONCE = 24
/** How far up the tree what moves beside a leaving element is looked for. */
const NEIGHBOUR_DEPTH = 5
const TRAVEL = { sink: "translateY(4px)", shrink: "scale(0.97)", drop: "translateY(8px)" } satisfies Record<ExitMotion, string>

/**
 * A view of a place, as its layout effects say it, which run after the commit's removals and before those removals'
 * copies are drawn (`flush`): a copy made in a commit that changed the view, or took the place away, is dropped.
 */
export interface View {
  scene: string | undefined
  /** This commit brings another view; said until the copies of its removals have been looked at. */
  switched: boolean
  live: boolean
  /** Rows that come and go by themselves (a virtualized window scrolling): none of them leaves with motion. */
  quiet: boolean
}

export function newView(scene: string | undefined, quiet = false): View {
  return { scene, switched: false, live: true, quiet }
}

/** In a layout effect: the view now `scene`. Another than before, and what this commit removed doesn't leave. */
export function viewIs(view: View, scene: string | undefined, quiet = false): void {
  view.quiet = quiet
  view.live = true
  if (view.scene === scene) return
  view.scene = scene
  view.switched = true
  // After this commit's copies are looked at: `flush` was queued while the commit removed them, before this.
  queueMicrotask(() => {
    view.switched = false
  })
}

/** The view a leaving element belongs to (`ExitScene` in `exit.tsx`). */
export const SceneContext = createContext<RefObject<View> | null>(null)

interface Leaving {
  key: string
  /** The views it was drawn in: one switched or gone by the time it's looked at, and it doesn't leave. */
  views: View[]
  node: HTMLElement
  ghost: HTMLElement
  motion: ExitMotion
  float: boolean
  transcript: boolean
  /** Hidden rather than taken out (`useExit`'s `hidden`): it stays only if it shows again. */
  hide: boolean
  /** Where a floating copy stood, read as it let go. */
  rect?: DOMRect | undefined
}

interface Glide {
  node: HTMLElement
  /** Where it rests once the copy is out of the flow, in the viewport. */
  rest: { x: number; y: number }
  animation: Animation
}

interface Ghost {
  ghost: HTMLElement
  animation: Animation
  glides: Glide[]
  transcript?: Carry | undefined
}

interface Carry {
  stop(): void
}

const leaving: Leaving[] = []
const arriving: Array<{ key: string; node: HTMLElement }> = []
const ghosts = new Map<string, Ghost>()
let flushing = false

function schedule() {
  if (flushing) return
  flushing = true
  queueMicrotask(flush)
}

/**
 * The ref for an element that should leave with motion. `key` names it among its kind, so one coming back while its
 * copy leaves turns that around; `hidden` is for an element kept mounted but hidden (`<div hidden>`), which leaves
 * when it hides and comes back when it shows.
 */
export function useExit<T extends HTMLElement = HTMLElement>(key: string | undefined, options: ExitOptions & { hidden?: boolean } = {}): RefCallback<T> {
  const scene = use(SceneContext)
  const { motion = "sink", float = false, transcript = false, hidden = false } = options
  // This element's own view, for one that stays mounted while what it shows changes.
  const local = useRef<View>(newView(options.scene))
  const node = useRef<T | null>(null)
  const born = useRef(0)
  const ref = useCallback(
    (element: T | null) => {
      node.current = element
      if (!element || key === undefined) return
      arrive(key, element)
      const views = scene ? [local.current, scene.current] : [local.current]
      const mounted = performance.now()
      born.current = mounted
      return () => {
        node.current = null
        if (performance.now() - mounted >= SEEN_MS) leave({ key, node: element, views, motion, float, transcript, hide: false })
      }
    },
    [key, scene, motion, float, transcript]
  )
  useLayoutEffect(() => {
    viewIs(local.current, options.scene)
  }, [options.scene])
  const shown = useRef(!hidden)
  useLayoutEffect(() => {
    const was = shown.current
    shown.current = !hidden
    const element = node.current
    if (was === !hidden || !element || key === undefined) return
    if (!hidden) arrive(key, element)
    else if (performance.now() - born.current >= SEEN_MS) leave({ key, node: element, views: scene ? [local.current, scene.current] : [local.current], motion, float, transcript, hide: true })
  }, [hidden, key, scene, motion, float, transcript])
  return ref
}

function arrive(key: string, node: HTMLElement) {
  // Put back in the same commit it was taken out (a remount, a key moved): nothing left, so nothing leaves.
  const pending = leaving.findIndex((entry) => entry.key === key)
  if (pending >= 0) {
    leaving[pending]!.ghost.remove()
    leaving.splice(pending, 1)
    return
  }
  if (!ghosts.has(key)) return
  arriving.push({ key, node })
  schedule()
}

function leave(entry: Omit<Leaving, "ghost" | "rect">) {
  if (document.hidden || reducedMotion()) return
  if (entry.views.some((view) => view.quiet || !view.live)) return
  const { node } = entry
  if (ghosts.has(entry.key) || leaving.some((each) => each.key === entry.key)) return
  // Inside something hidden, or already gone from the page, there's nothing on screen to leave.
  if (!node.isConnected || (entry.hide ? node.parentElement?.closest("[hidden]") : node.closest("[hidden]"))) return
  const parent = node.parentNode
  if (!parent) return
  // SAFETY: a deep clone of an element is an element of the same kind; `cloneNode` is only typed as returning a Node.
  const ghost = node.cloneNode(true) as HTMLElement
  // A field's words are its state, not its markup.
  const fields = node.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")
  if (fields.length) {
    const copies = ghost.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")
    fields.forEach((field, index) => {
      const copy = copies[index]
      if (copy) copy.value = field.value
    })
  }
  for (const named of ghost.querySelectorAll("[id]")) named.removeAttribute("id")
  ghost.removeAttribute("id")
  if (entry.hide) ghost.hidden = false
  ghost.setAttribute("data-exit-ghost", "")
  ghost.setAttribute("aria-hidden", "true")
  ghost.inert = true
  // A floating element's place is read now, while what holds it still stands.
  const rect = entry.float ? node.getBoundingClientRect() : undefined
  parent.insertBefore(ghost, node)
  leaving.push({ ...entry, ghost, rect })
  schedule()
}

function flush() {
  flushing = false
  const back = arriving.splice(0)
  const batch = leaving.splice(0)
  if (back.length) turnAround(back)
  if (!batch.length) return
  const going: Leaving[] = []
  for (const entry of batch) {
    // Taken out by another view of its place, or with its place: put away at once, as it always was.
    if (entry.views.some((view) => view.switched || !view.live || view.quiet)) {
      entry.ghost.remove()
      continue
    }
    const stayed = entry.hide ? !entry.node.hidden && entry.node.isConnected : entry.node.isConnected
    if (stayed) {
      entry.ghost.remove()
      continue
    }
    if (!entry.ghost.isConnected) {
      // What held a floating element went in the same moment (the send button turning into Stop): it's drawn over the page.
      if (!entry.float || !entry.rect) continue
      document.body.append(entry.ghost)
      Object.assign(entry.ghost.style, {
        position: "fixed",
        top: `${entry.rect.top}px`,
        left: `${entry.rect.left}px`,
        right: "auto",
        bottom: "auto",
        width: `${entry.rect.width}px`,
        height: `${entry.rect.height}px`,
        margin: "0",
        zIndex: "60",
      })
    }
    going.push(entry)
  }
  if (!going.length) return
  if (going.length > MOST_AT_ONCE) {
    for (const entry of going) entry.ghost.remove()
    return
  }

  // Read: where each copy stands, in the flow still, and what's around it.
  const view = { width: innerWidth, height: innerHeight }
  const plans = going.flatMap((entry) => {
    const { ghost } = entry
    const before = ghost.getBoundingClientRect()
    const onScreen = before.width > 0 && before.height > 0 && before.bottom > 0 && before.top < view.height && before.right > 0 && before.left < view.width
    if (!onScreen) {
      ghost.remove()
      return []
    }
    const style = getComputedStyle(ghost)
    const floating = style.position === "absolute" || style.position === "fixed"
    return [{ entry, before, floating, transform: style.transform, visible: visibleArea(ghost.parentElement) }]
  })
  const inFlow = plans.filter((plan) => !plan.floating)
  const neighbours = new Set<HTMLElement>()
  for (const plan of inFlow) for (const each of neighboursOf(plan.entry.ghost)) neighbours.add(each)
  for (const plan of plans) neighbours.delete(plan.entry.ghost)
  const around = [...neighbours].flatMap((node) => {
    const style = getComputedStyle(node)
    // Something already carried by `translate` is someone else's motion; something fixed doesn't follow the flow.
    if (style.position === "fixed" || style.display === "contents" || (style.translate !== "none" && !node.getAnimations().some((running) => running.id === EXIT_GLIDE))) return []
    const box = node.getBoundingClientRect()
    if (!box.width && !box.height) return []
    return [{ node, box }]
  })
  const transcripts = new Map<HTMLElement, { top: number; atEnd: boolean; drawn: number; anchor: Element; anchorTop: number }>()
  for (const plan of inFlow) {
    if (!plan.entry.transcript) continue
    const viewport = transcriptOf(plan.entry.ghost)
    if (!viewport || transcripts.has(viewport)) continue
    const top = viewport.scrollTop
    // What the reader's eye is on at the end: the newest turn, drawn where it is now (a glide from an exit just before
    // included), which the glide starts from.
    const turns = viewport.querySelectorAll("[data-exchange]")
    const anchor = turns[turns.length - 1] ?? viewport.firstElementChild ?? viewport
    transcripts.set(viewport, { top, atEnd: viewport.scrollHeight - viewport.clientHeight - top <= 2, drawn: translateOf(viewport).y, anchor, anchorTop: anchor.getBoundingClientRect().top })
  }

  // Write: each copy out of the flow, at its container's corner; what still glides from an earlier exit, let go.
  for (const plan of inFlow)
    Object.assign(plan.entry.ghost.style, {
      position: "absolute",
      top: "0px",
      left: "0px",
      right: "auto",
      bottom: "auto",
      width: `${plan.before.width}px`,
      height: `${plan.before.height}px`,
      margin: "0",
      boxSizing: "border-box",
      pointerEvents: "none",
    })
  for (const { node } of around) for (const running of node.getAnimations()) if (running.id === EXIT_GLIDE) running.cancel()
  for (const viewport of transcripts.keys()) carries.get(viewport)?.stop()

  // Read again, once: where the corner is, and where everything around came to rest.
  const corners = inFlow.map((plan) => plan.entry.ghost.getBoundingClientRect())
  const rests = around.map(({ node }) => node.getBoundingClientRect())
  const shifts = [...transcripts].map(([viewport, held]) => {
    const end = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
    const top = held.atEnd ? end : Math.min(held.top, end)
    return { viewport, held, shift: held.top - top - held.drawn }
  })

  // Write: the copies over where they stood, leaving; what moved, from where it was.
  inFlow.forEach((plan, index) => {
    const corner = corners[index]!
    const { ghost } = plan.entry
    ghost.style.top = `${plan.before.top - corner.top}px`
    ghost.style.left = `${plan.before.left - corner.left}px`
    // Out of the flow, its box may be placed by something outside the scroller it stood in: it's clipped as it was.
    const { before, visible } = plan
    const inset = [visible.top - before.top, before.right - visible.right, before.bottom - visible.bottom, visible.left - before.left].map((side) => Math.max(0, side))
    if (inset.some((side) => side > 0.5)) ghost.style.clipPath = `inset(${inset.map((side) => `${side}px`).join(" ")})`
  })
  const glideMs = motionMs("panel-out")
  const glides: Glide[] = []
  around.forEach(({ node, box }, index) => {
    const rest = rests[index]!
    const x = box.left - rest.left
    const y = box.top - rest.top
    if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return
    if (!nearView(box, view) && !nearView(rest, view)) return
    const animation = node.animate([{ translate: `${x}px ${y}px` }, { translate: "0 0" }], { id: EXIT_GLIDE, duration: glideMs, easing: EASE_SWIFT })
    glides.push({ node, rest: { x: rest.left, y: rest.top }, animation })
  })
  const carried = shifts.filter(({ shift }) => shift > 0.5).map(({ viewport, held, shift }) => carryTranscript(viewport, shift, glideMs, held.anchor, held.anchorTop))
  const outMs = motionMs("menu-out")
  for (const plan of plans) {
    const { entry } = plan
    const base = plan.transform === "none" ? "" : plan.transform
    const animation = entry.ghost.animate(
      [
        { opacity: 1, transform: base || "none" },
        { opacity: 0, transform: `${base} ${TRAVEL[entry.motion]}`.trim() },
      ],
      { duration: outMs, easing: EASE_SWIFT, fill: "forwards" }
    )
    const held: Ghost = { ghost: entry.ghost, animation, glides: plan.floating ? [] : glides, transcript: plan.floating ? undefined : carried[0] }
    ghosts.set(entry.key, held)
    animation.onfinish = () => {
      if (ghosts.get(entry.key) === held) ghosts.delete(entry.key)
      entry.ghost.remove()
    }
    animation.oncancel = animation.onfinish
  }
}

/**
 * Those that came back while their copy left: the copy goes, the element takes over from where it was drawn, and what
 * glided out of its way glides back from where it is.
 */
function turnAround(back: Array<{ key: string; node: HTMLElement }>) {
  const turns = back.flatMap(({ key, node }) => {
    const held = ghosts.get(key)
    if (!held || !node.isConnected) return []
    ghosts.delete(key)
    const style = getComputedStyle(held.ghost)
    // Where everything is drawn now, the copy's fade and each glide's offset from its rest.
    const glides = held.glides
      .filter((glide) => glide.node.isConnected && glide.animation.playState === "running")
      .map((glide) => {
        const { x, y } = translateOf(glide.node)
        return { node: glide.node, drawn: { x: glide.rest.x + x, y: glide.rest.y + y } }
      })
    return [{ node, held, opacity: Number(style.opacity), transform: style.transform, glides }]
  })
  for (const turn of turns) {
    turn.held.animation.onfinish = null
    turn.held.animation.oncancel = null
    turn.held.ghost.remove()
    turn.held.transcript?.stop()
    for (const glide of turn.glides) for (const running of glide.node.getAnimations()) if (running.id === EXIT_GLIDE) running.cancel()
  }
  const rests = turns.map((turn) => turn.glides.map((glide) => glide.node.getBoundingClientRect()))
  const inMs = motionMs("menu")
  turns.forEach((turn, index) => {
    turn.node.animate(
      [
        { opacity: turn.opacity, transform: turn.transform === "none" ? "none" : turn.transform },
        { opacity: 1, transform: "none" },
      ],
      { duration: inMs, easing: EASE_OUT }
    )
    turn.glides.forEach((glide, at) => {
      const rest = rests[index]![at]!
      const x = glide.drawn.x - rest.left
      const y = glide.drawn.y - rest.top
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) return
      glide.node.animate([{ translate: `${x}px ${y}px` }, { translate: "0 0" }], { id: EXIT_GLIDE, duration: inMs, easing: EASE_OUT })
    })
  })
}

/**
 * The transcript's viewport, held at its end, came down `shift` pixels as the room under it grew: it starts where it
 * was and glides down, drawn by `translate` on the viewport as a whole, its pane clipping what rises past its top.
 *
 * The transcript settles its end itself as the room changes (`conversation-timeline.tsx` follows the end and keeps room
 * there), sometimes over a frame or two. Observed after it (an observer made later is told later), the glide keeps the
 * newest turn drawn where it was in the first frame, and takes each later move of the transcript's own into the glide
 * instead of showing it as a step.
 */
function carryTranscript(viewport: HTMLElement, shift: number, duration: number, anchor: Element, anchorTop: number): Carry {
  carries.get(viewport)?.stop()
  const pane = viewport.parentElement
  if (pane && !unclipped.has(pane)) unclipped.set(pane, pane.style.overflow)
  if (pane) pane.style.overflow = "clip"
  const started = performance.now()
  const play = (from: number, ms: number) =>
    viewport.animate([{ translate: `0 ${from}px` }, { translate: "0 0" }], { id: EXIT_GLIDE, duration: ms, easing: EASE_SWIFT })
  let animation = play(-shift, duration)
  let layout: number | undefined
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    observer.disconnect()
    animation.cancel()
    if (carries.get(viewport) === carry) carries.delete(viewport)
    if (pane) {
      pane.style.overflow = unclipped.get(pane) ?? ""
      unclipped.delete(pane)
    }
  }
  const settled = () => {
    if (animation.playState === "finished") stop()
  }
  animation.addEventListener("finish", settled)
  const observer = new ResizeObserver(() => {
    if (stopped || !anchor.isConnected) return
    const drawn = translateOf(viewport).y
    const now = anchor.getBoundingClientRect().top - drawn
    // First: the newest turn where it was drawn before anything moved; then: the transcript's own moves, taken in.
    const want = layout === undefined ? anchorTop - now : drawn - (now - layout)
    layout = now
    const left = duration - (performance.now() - started)
    if (Math.abs(want - drawn) < 0.5 || left < 16) return
    const next = play(want, left)
    next.addEventListener("finish", settled)
    animation.cancel()
    animation = next
  })
  observer.observe(viewport)
  if (viewport.firstElementChild) observer.observe(viewport.firstElementChild)
  const carry: Carry = { stop }
  carries.set(viewport, carry)
  return carry
}

const unclipped = new WeakMap<HTMLElement, string>()
const carries = new WeakMap<HTMLElement, Carry>()

/** What of the page an element's ancestors let show: the intersection of every one that clips what overflows it. */
interface Area {
  top: number
  right: number
  bottom: number
  left: number
}

function visibleArea(from: HTMLElement | null): Area {
  const area: Area = { top: -Infinity, right: Infinity, bottom: Infinity, left: -Infinity }
  for (let at = from; at && at !== document.body; at = at.parentElement) {
    const style = getComputedStyle(at)
    if (style.overflowX === "visible" && style.overflowY === "visible") continue
    const box = at.getBoundingClientRect()
    area.top = Math.max(area.top, box.top)
    area.right = Math.min(area.right, box.right)
    area.bottom = Math.min(area.bottom, box.bottom)
    area.left = Math.max(area.left, box.left)
  }
  return area
}

/** The `translate` an element is drawn with now, in pixels. */
interface Offset {
  x: number
  y: number
}

function translateOf(node: HTMLElement): Offset {
  const value = getComputedStyle(node).translate
  if (!value || value === "none") return { x: 0, y: 0 }
  const [x = 0, y = 0] = value.split(" ").map((part) => Number.parseFloat(part) || 0)
  return { x, y }
}

/** What can move when an element leaves the flow: its siblings, and its ancestors' siblings, a few levels up. */
function neighboursOf(ghost: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = []
  let child: Element = ghost
  let parent = ghost.parentElement
  for (let depth = 0; parent && parent !== document.body && depth < NEIGHBOUR_DEPTH; depth += 1) {
    for (const sibling of parent.children)
      if (sibling !== child && sibling instanceof HTMLElement && !sibling.hasAttribute("data-exit-ghost")) found.push(sibling)
    if (parent.hasAttribute("data-exit-bound")) break
    child = parent
    parent = parent.parentElement
  }
  return found
}

/** The transcript a prompt or the queue sits under: the nearest one up the tree. */
function transcriptOf(ghost: HTMLElement): HTMLElement | null {
  let at = ghost.parentElement
  for (let depth = 0; at && depth < 8; depth += 1) {
    const found = at.querySelector<HTMLElement>("[data-transcript-viewport]")
    if (found) return found
    at = at.parentElement
  }
  return null
}

function nearView(box: { top: number; bottom?: number; height?: number }, view: { height: number }): boolean {
  const bottom = box.bottom ?? box.top + (box.height ?? 0)
  return bottom > -80 && box.top < view.height + 80
}

