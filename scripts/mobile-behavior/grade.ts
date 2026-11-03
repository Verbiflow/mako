import { z } from "zod"
import { BUDGETS, type MetricId, type MobileCase } from "./cases.ts"

/** One frame the sampler took: when, how far the transcript is from its end, and each turn on screen (its ID and top). */
export interface Frame {
  at: number
  fromEnd: number
  rows: ReadonlyArray<readonly [string, number]>
}

/**
 * One reading the web client's probe said on the page (`mako:reading`, its detail), as the runner collected it, with
 * only the fields the grade reads.
 */
export const ReadingSchema = z.object({
  name: z.string(),
  props: z.object({ newestMs: z.number().optional(), step: z.string().optional(), ms: z.number().optional() }),
})
export type Reading = z.infer<typeof ReadingSchema>

/** A turn that moves this far in one frame wasn't scrolled, it was teleported. */
const TELEPORT_PX = 400
/** A frame slower than this is over budget: one and a half frames at 60 Hz. */
const SLOW_FRAME_MS = 25
/** The end is measured once the first half second has passed, after the case's own first move. */
const SETTLE_MS = 500

/** Each `MetricId`, when a case measured it. */
export interface Metrics {
  backwardPx?: number
  teleports?: number
  maxFromEndPx?: number
  slowFramePct?: number
  driftPx?: number
  shiftPx?: number
  keyboardFromEndPx?: number
  newestMs?: number
  dictationStopMs?: number
}

/** What was sampled, so a pass can be told from a page that never moved: frames, their span, how far the turns went. */
export interface Sampling {
  frames: number
  ms: number
  /** The most any one turn moved, summed over every frame. */
  travelPx: number
  /** How much farther the end is from view at the last frame than at the first: what streamed past a reader. */
  endGrewPx: number
}

function streamsWhileSampling(behavior: MobileCase): boolean {
  let sampling = false
  for (const step of behavior.steps) {
    if (step.do === "sample") sampling = step.on
    else if (step.do === "stream" && sampling) return true
  }
  return false
}

export function sampling(frames: readonly Frame[]): Sampling {
  let travelPx = 0
  for (let index = 1; index < frames.length; index++) {
    const before = new Map(frames[index - 1]?.rows)
    let most = 0
    for (const [id, top] of frames[index]?.rows ?? []) {
      const was = before.get(id)
      if (was !== undefined) most = Math.max(most, Math.abs(top - was))
    }
    travelPx += most
  }
  return { frames: frames.length, ms: Math.round((frames.at(-1)?.at ?? 0) - (frames[0]?.at ?? 0)), travelPx: Math.round(travelPx), endGrewPx: Math.round((frames.at(-1)?.fromEnd ?? 0) - (frames[0]?.fromEnd ?? 0)) }
}

/**
 * The measures from the frames: the most any turn moved down the screen in one frame (`backwardPx`), frames where one
 * jumped `TELEPORT_PX` (`teleports`), the end's farthest from view after the first half second (`maxFromEndPx`), the
 * share of frames over `SLOW_FRAME_MS` (`slowFramePct`), and how far the top turn moved from where it was at the first
 * frame (`driftPx`, the reader's place) or at all (`shiftPx`, for a page where nothing should move).
 */
export function gradeFrames(frames: readonly Frame[]): Metrics {
  if (frames.length < 2) return {}
  let backwardPx = 0
  let moved = 0
  let teleports = 0
  let maxFromEndPx = 0
  let slow = 0
  const start = frames[0]?.at ?? 0
  const anchor = new Map(frames[0]?.rows ?? [])
  let driftPx = 0
  for (let index = 1; index < frames.length; index++) {
    const frame = frames[index]
    const previous = frames[index - 1]
    if (!frame || !previous) continue
    if (frame.at - previous.at > SLOW_FRAME_MS) slow++
    const before = new Map(previous.rows)
    let teleported = false
    for (const [id, top] of frame.rows) {
      const was = before.get(id)
      if (was !== undefined) {
        const step = top - was
        backwardPx = Math.max(backwardPx, step)
        moved = Math.max(moved, Math.abs(step))
        if (Math.abs(step) >= TELEPORT_PX) teleported = true
      }
      const first = anchor.get(id)
      if (first !== undefined) driftPx = Math.max(driftPx, Math.abs(top - first))
    }
    if (teleported) teleports++
    if (frame.at - start > SETTLE_MS) maxFromEndPx = Math.max(maxFromEndPx, frame.fromEnd)
  }
  return {
    backwardPx: Math.round(backwardPx),
    teleports,
    maxFromEndPx: Math.round(maxFromEndPx),
    slowFramePct: Math.round((slow / (frames.length - 1)) * 1000) / 10,
    driftPx: Math.round(driftPx),
    shiftPx: Math.round(moved),
    keyboardFromEndPx: Math.round(frames.at(-1)?.fromEnd ?? 0),
  }
}

/** The measures from the web client's own readings: its newest turn's time, and dictation's stop. */
export function gradeReadings(readings: readonly Reading[]): Metrics {
  const metrics: Metrics = {}
  for (const reading of readings) {
    if (reading.name === "web.thread-open" && reading.props.newestMs !== undefined) metrics.newestMs = Math.max(metrics.newestMs ?? 0, reading.props.newestMs)
    if (reading.name === "web.dictation" && reading.props.step === "stopped" && reading.props.ms !== undefined) metrics.dictationStopMs = Math.max(metrics.dictationStopMs ?? 0, reading.props.ms)
  }
  return metrics
}

export interface Judged {
  metric: MetricId
  value: number | undefined
  budget: number
  pass: boolean
}

/** Each of the case's measures against its budget; one that wasn't measured fails, since nothing was shown to hold. */
export function judge(behavior: MobileCase, metrics: Metrics): Judged[] {
  return behavior.measures.map((metric) => {
    const budget = behavior.budgets?.[metric] ?? BUDGETS[metric]
    const value = metrics[metric]
    return { metric, value, budget, pass: value !== undefined && value <= budget }
  })
}

/** A guard or control that fails is a failure of the run; a bad case that fails is expected until its fix. */
export type Verdict = "pass" | "fail" | "expected-fail" | "fixed" | "unproven"

/**
 * A case streams while it samples, and nothing on screen moved and the end didn't grow: whatever held, nothing was
 * shown streaming past it, so the case proved nothing either way (`unproven`), and a guard that proves nothing fails.
 */
export function verdict(behavior: MobileCase, judged: readonly Judged[], sampled?: Sampling): Verdict {
  if (sampled && streamsWhileSampling(behavior) && sampled.travelPx === 0 && sampled.endGrewPx === 0) return "unproven"
  const passed = judged.every((entry) => entry.pass)
  if (behavior.kind === "bad") return passed ? "fixed" : "expected-fail"
  return passed ? "pass" : "fail"
}

/** What a case's samples say together: its verdict, or `incomplete` when more samples threw than were graded. */
export type CaseVerdict = Verdict | "incomplete"

/**
 * A case's samples on one form, each a verdict or an error, judged together as T3's suite does: errors are left out
 * of the grade, and a case with more errors than graded samples is `incomplete`. Otherwise it fails when half or more
 * of its graded samples fail (a `bad` case is then still `expected-fail`), so one noisy sample can't decide it either way.
 * Samples that all proved nothing are `unproven`; one that proved nothing among others counts as failing.
 */
export function caseVerdict(behavior: MobileCase, samples: readonly (Verdict | "error")[]): CaseVerdict {
  const graded = samples.filter((sample): sample is Verdict => sample !== "error")
  if (graded.length === 0 || samples.length - graded.length > graded.length) return "incomplete"
  if (graded.every((sample) => sample === "unproven")) return "unproven"
  const failing = graded.filter((sample) => sample === "fail" || sample === "expected-fail" || sample === "unproven").length
  const fails = failing * 2 >= graded.length
  if (behavior.kind === "bad") return fails ? "expected-fail" : "fixed"
  return fails ? "fail" : "pass"
}

/** Whether a case's verdict fails the run: a guard or control that fails, proves nothing or couldn't be graded. A bad case never does. */
export function failsRun(behavior: MobileCase, outcome: CaseVerdict): boolean {
  return behavior.kind !== "bad" && (outcome === "fail" || outcome === "incomplete" || outcome === "unproven")
}
