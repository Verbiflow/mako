import type { MoveSent } from "@mako/host/contracts/cloud-threads"

/**
 * How far a move between a Mac and the cloud is, as a bar that only moves forward. Each step of the owner's has a span
 * of its own; within it an upload fills by its bytes, and a wait creeps across with its time so far, slower and slower,
 * never reaching the next step's start. Its words are the desk's own (`thread-move-notice.tsx`).
 */

/** Where a move goes: up to the cloud, or back to a Mac. */
export type MoveWay = "cloud" | "device"

/**
 * One step's span of the bar, and how long its wait usually takes. `asking` is the phone's own: asked, before the Mac's
 * first step is heard. `bytes`: how much of the span an upload's bytes can fill; the rest is waited for.
 */
type Span = { from: number; to: number; typicalMs: number; bytes?: number }

const SPANS = {
  cloud: new Map<string, Span>([
    ["asking", { from: 0, to: 0.04, typicalMs: 3_000 }],
    ["own-branch", { from: 0.04, to: 0.1, typicalMs: 8_000 }],
    // Its checkout and records go ahead while its machine starts: the upload fills most of the span, the machine the rest.
    ["packing", { from: 0.1, to: 0.62, typicalMs: 45_000, bytes: 0.7 }],
    ["pausing", { from: 0.62, to: 0.68, typicalMs: 8_000 }],
    ["handing-over", { from: 0.68, to: 0.84, typicalMs: 15_000 }],
    // The row says `moving` without a step once the Thread is in transit: as far as the hand-over.
    ["moving", { from: 0.68, to: 0.84, typicalMs: 15_000 }],
    ["resuming", { from: 0.84, to: 0.98, typicalMs: 20_000 }],
  ]),
  device: new Map<string, Span>([
    ["asking", { from: 0, to: 0.04, typicalMs: 3_000 }],
    ["packing", { from: 0.04, to: 0.4, typicalMs: 30_000 }],
    ["moving", { from: 0.4, to: 0.9, typicalMs: 30_000 }],
    ["bringing", { from: 0.4, to: 0.96, typicalMs: 30_000 }],
  ]),
} satisfies Record<MoveWay, ReadonlyMap<string, Span>>

/** A wait goes this far across its span at most: the next step's start is the next step's to reach. */
const WAIT_REACHES = 0.95

/**
 * How far the bar stands for a step `elapsedMs` in, with what its upload sent, 0..1; undefined for a step it has no
 * span for (an end, an unsettled answer), where it stays as it was.
 */
export function stepFraction(way: MoveWay, step: string, elapsedMs: number, sent?: MoveSent): number | undefined {
  const span = SPANS[way].get(step)
  if (!span) return undefined
  const waited = WAIT_REACHES * (1 - Math.exp(-Math.max(0, elapsedMs) / span.typicalMs))
  const uploaded = span.bytes !== undefined && sent && sent.of > 0 ? span.bytes * Math.min(1, sent.bytes / sent.of) : 0
  return span.from + (span.to - span.from) * Math.min(WAIT_REACHES, Math.max(waited, uploaded))
}

/** The bar's next place: never behind where it stood. */
export function forward(previous: number, next: number | undefined): number {
  return Math.max(previous, next ?? previous)
}

/** How far a bar stands, 0..1, for which move. */
export type MoveBar = { move: string | undefined; fraction: number }

/**
 * Where a bar starts as the move it draws is named: the list's word on a move (no ID yet) turning out to be the move
 * whose steps are heard goes on from where it stood; another move (a retry) starts a bar of its own.
 */
export function barFrom(bar: MoveBar, move: string | undefined): MoveBar {
  if (bar.move !== undefined && move !== undefined && bar.move !== move) return { move, fraction: 0 }
  return { move: bar.move ?? move, fraction: bar.fraction }
}

/** A percentage as the card says it, with its noun: "42% done". Never 100 before the move ends. */
export function percentWords(fraction: number, done: boolean): string {
  return `${done ? 100 : Math.min(99, Math.floor(fraction * 100))}% done`
}

/** Megabytes as an upload says them: "3.2 of 14 MB", whole megabytes past ten. */
export function sentWords(sent: MoveSent): string {
  const mb = (bytes: number) => {
    const value = bytes / 1_000_000
    return value >= 10 ? String(Math.round(value)) : value.toFixed(1)
  }
  return `${mb(sent.bytes)} of ${mb(sent.of)} MB`
}

/** A step in words, as the desk says it, with where it goes. */
export function stepWords(way: MoveWay, step: string, mac: string, handOff: boolean): string {
  if (way === "cloud")
    switch (step) {
      case "asking":
        return `Asking ${mac}…`
      case "own-branch":
        return "Onto its own branch"
      case "packing":
        return handOff ? "Sending ahead while it works" : "Sending its work ahead"
      case "pausing":
        return "Pausing the turn"
      case "handing-over":
      case "moving":
        return "Handing over"
      case "resuming":
        return handOff ? "Continuing in the cloud" : "Resuming in the cloud"
      case "unsettled":
        return "Waiting for the cloud's answer"
      default:
        return "Moving"
    }
  switch (step) {
    case "asking":
      return `Asking ${mac}…`
    case "packing":
      return "Packing in the cloud"
    case "bringing":
    case "moving":
      return `Bringing it to ${mac}`
    case "unsettled":
      return "Waiting for the cloud's answer"
    default:
      return "Coming back"
  }
}
