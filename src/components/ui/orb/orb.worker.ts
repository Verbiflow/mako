import { z } from "zod"
import {
  MODE_FRAMES,
  resolvePreset,
  type ModeOpts,
  type OrbFrame,
  type OrbSize,
  type OrbState,
} from "thinking-orbs/engine"
import { ORB_SIZES, ORB_STATES } from "./orb-protocol"

/*
 * Every thinking orb in the window, drawn off the main thread. A transcript
 * that is streaming, parsing markdown or measuring rows keeps the renderer
 * busy for tens of milliseconds at a time; an orb painted there skips those
 * frames and, because its clock is wall time, jumps. Here one loop paints
 * them all at 60 frames a second whatever the page is doing.
 */

const FRAME_MS = 1000 / 60
const CROSSFADE_MS = 320
const ENTER_MS = 220

const tint = z.object({ r: z.number(), g: z.number(), b: z.number() })
const command = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add"),
    id: z.number(),
    canvas: z.instanceof(OffscreenCanvas),
    size: z.literal(ORB_SIZES),
    state: z.enum(ORB_STATES),
    dark: z.boolean(),
    tint: tint.optional(),
    dpr: z.number(),
    paused: z.boolean(),
  }),
  z.object({
    type: z.literal("update"),
    id: z.number(),
    state: z.enum(ORB_STATES),
    dark: z.boolean(),
    tint: tint.optional(),
    paused: z.boolean(),
  }),
  z.object({ type: z.literal("visible"), id: z.number(), visible: z.boolean() }),
  z.object({ type: z.literal("remove"), id: z.number() }),
  z.object({ type: z.literal("page"), hidden: z.boolean(), reduced: z.boolean() }),
])

interface Motion {
  frame: (size: number, t: number, opts: ModeOpts) => OrbFrame
  opts: ModeOpts
  speed: number
}

interface Orb {
  ctx: OffscreenCanvasRenderingContext2D
  size: OrbSize
  dpr: number
  motion: Motion
  /** The state being faded out, and when the fade began. */
  leaving?: { motion: Motion; since: number }
  entered: number
  dark: boolean
  tint?: z.infer<typeof tint>
  paused: boolean
  /** The moment a paused orb holds, so its frame stays still while it fades. */
  heldAt: number
  /** Whether the last paint was part of an entrance or crossfade. */
  settling: boolean
  visible: boolean
  state: OrbState
}

const orbs = new Map<number, Orb>()
let pageHidden = false
let reduced = false
let scheduled = false
let last = 0

function motionOf(state: OrbState, size: OrbSize): Motion {
  const preset = resolvePreset(state, size)
  return { frame: MODE_FRAMES[preset.mode], opts: preset.opts, speed: preset.speed }
}

function ink(white: number, alpha: number, orb: Orb): string {
  const w = Math.min(1, Math.max(0, white))
  const t = orb.tint
  if (!t) {
    const g = Math.round((orb.dark ? 1 - w : w) * 255)
    return `rgba(${g},${g},${g},${alpha})`
  }
  const ramp = (c: number) => Math.round(orb.dark ? c * (1 - w) : c + (255 - c) * w)
  return `rgba(${ramp(t.r)},${ramp(t.g)},${ramp(t.b)},${alpha})`
}

function paint(orb: Orb, frame: OrbFrame, opacity: number) {
  const { ctx } = orb
  for (const line of frame.lines) {
    ctx.strokeStyle = ink(line.white, (line.a ?? 1) * opacity, orb)
    ctx.lineWidth = line.w
    ctx.beginPath()
    ctx.moveTo(line.x1, line.y1)
    ctx.lineTo(line.x2, line.y2)
    ctx.stroke()
  }
  for (const dot of frame.dots) {
    ctx.fillStyle = ink(dot.white, (dot.a ?? 1) * opacity, orb)
    ctx.beginPath()
    ctx.arc(dot.x, dot.y, dot.r, 0, Math.PI * 2)
    ctx.fill()
  }
}

const easeOut = (p: number) => 1 - (1 - p) ** 3

function draw(orb: Orb, now: number) {
  const t = reduced ? 0.6 : (orb.paused ? orb.heldAt : now) / 1000
  const { ctx, size, dpr } = orb
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, size, size)
  const enter = reduced ? 1 : easeOut(Math.min(1, (now - orb.entered) / ENTER_MS))
  orb.settling = enter < 1
  if (orb.leaving) {
    const p = reduced ? 1 : Math.min(1, (now - orb.leaving.since) / CROSSFADE_MS)
    if (p >= 1) orb.leaving = undefined
    else {
      const out = orb.leaving.motion
      paint(orb, out.frame(size, t * out.speed, out.opts), (1 - easeOut(p)) * enter)
      paint(orb, orb.motion.frame(size, t * orb.motion.speed, orb.motion.opts), easeOut(p) * enter)
      orb.settling = true
      return
    }
  }
  paint(orb, orb.motion.frame(size, t * orb.motion.speed, orb.motion.opts), enter)
}

// A paused orb still paints until its entrance or crossfade finishes;
// otherwise its only frame is the first one, drawn at zero opacity.
function animating(orb: Orb): boolean {
  return orb.visible && !pageHidden && (orb.settling || (!orb.paused && !reduced))
}

function tick(now: number) {
  scheduled = false
  let any = false
  if (now - last >= FRAME_MS - 1) {
    last = now
    for (const orb of orbs.values()) {
      if (!animating(orb)) continue
      any = true
      draw(orb, now)
    }
  } else any = [...orbs.values()].some(animating)
  if (any) schedule()
}

function schedule() {
  if (scheduled) return
  scheduled = true
  if ("requestAnimationFrame" in globalThis) requestAnimationFrame(tick)
  else setTimeout(() => tick(performance.now()), FRAME_MS)
}

globalThis.addEventListener("message", (event: MessageEvent<unknown>) => {
  const parsed = command.safeParse(event.data)
  if (!parsed.success) return
  const message = parsed.data
  const now = performance.now()
  if (message.type === "page") {
    pageHidden = message.hidden
    reduced = message.reduced
    for (const orb of orbs.values()) draw(orb, now)
  } else if (message.type === "add") {
    const ctx = message.canvas.getContext("2d")
    if (!ctx) return
    message.canvas.width = Math.round(message.size * message.dpr)
    message.canvas.height = Math.round(message.size * message.dpr)
    const orb: Orb = {
      ctx,
      size: message.size,
      dpr: message.dpr,
      motion: motionOf(message.state, message.size),
      entered: now,
      dark: message.dark,
      tint: message.tint,
      paused: message.paused,
      heldAt: now,
      settling: true,
      visible: true,
      state: message.state,
    }
    orbs.set(message.id, orb)
    draw(orb, now)
  } else if (message.type === "update") {
    const orb = orbs.get(message.id)
    if (!orb) return
    if (message.state !== orb.state) {
      orb.leaving = { motion: orb.motion, since: now }
      orb.motion = motionOf(message.state, orb.size)
      orb.state = message.state
    }
    orb.dark = message.dark
    orb.tint = message.tint
    if (message.paused && !orb.paused) orb.heldAt = now
    orb.paused = message.paused
    draw(orb, now)
  } else if (message.type === "visible") {
    const orb = orbs.get(message.id)
    if (orb) orb.visible = message.visible
  } else orbs.delete(message.id)
  schedule()
})
