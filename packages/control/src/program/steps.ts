import { z } from "zod"

/** The newest steps a running cell's progress names; older ones are counted in `total`. */
export const STEPS_KEPT = 12

/** A running cell's progress is sent at most this often, its newest state each time. */
export const STEPS_EVERY_MS = 250

/** The longest a step's name runs, so one long call can't make a progress frame large. */
const STEP_NAME_MAX = 80

/**
 * One call a running cell made, such as "click e12" or "screenshot", and
 * where it stands. The same call made again and again in a row is one step,
 * made `times` times, so a polling loop reads as one line, not a flood.
 */
export const ControlStepSchema = z.lazy(() => z.object({
  call: z.string().max(STEP_NAME_MAX),
  phase: z.enum(["running", "done", "failed"]),
  times: z.number().int().min(2).optional(),
}))
export type ControlStep = z.infer<typeof ControlStepSchema>

/**
 * A running cell's calls so far: the newest `STEPS_KEPT` steps, oldest
 * first, and how many calls it made in all. The whole state each time, so
 * the newest frame replaces every one before it and a lost frame loses
 * nothing.
 */
export const ControlStepsSchema = z.lazy(() => z.object({
  steps: z.array(ControlStepSchema).max(STEPS_KEPT),
  total: z.number().int().nonnegative(),
}))
export type ControlSteps = z.infer<typeof ControlStepsSchema>

/** Keeps a running cell's steps as its calls start and settle (`ControlProgramExecution.steps`). */
export class StepLog {
  private readonly steps: ControlStep[] = []
  private readonly open = new Map<number, ControlStep>()
  private total = 0

  start(id: number, name: string): void {
    const call = name.length > STEP_NAME_MAX ? `${name.slice(0, STEP_NAME_MAX - 1)}…` : name
    this.total += 1
    const last = this.steps.at(-1)
    // A call repeated once the one before it finished is the same step again.
    if (last && last.call === call && last.phase === "done" && !this.open.size) {
      last.times = (last.times ?? 1) + 1
      last.phase = "running"
      this.open.set(id, last)
      return
    }
    const step: ControlStep = { call, phase: "running" }
    this.steps.push(step)
    if (this.steps.length > STEPS_KEPT) this.steps.shift()
    this.open.set(id, step)
  }

  settle(id: number, ok: boolean): void {
    const step = this.open.get(id)
    if (!step) return
    this.open.delete(id)
    step.phase = ok ? "done" : "failed"
  }

  snapshot(): ControlSteps {
    return { steps: this.steps.map((step) => ({ ...step })), total: this.total }
  }
}

/**
 * Calls `send` with the newest steps at most once per `every` ms: the first
 * at once, the rest trailing, so a burst of calls costs one frame. `flush`
 * sends what's pending now, and `stop` drops it.
 */
export function throttledSteps(send: (steps: ControlSteps) => void, every = STEPS_EVERY_MS) {
  let pending: ControlSteps | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let last = -Infinity
  const fire = () => {
    timer = undefined
    if (!pending) return
    const steps = pending
    pending = undefined
    last = Date.now()
    send(steps)
  }
  return {
    push(steps: ControlSteps): void {
      pending = steps
      if (timer) return
      const wait = last + every - Date.now()
      if (wait <= 0) fire()
      else timer = setTimeout(fire, wait)
    },
    flush(): void {
      clearTimeout(timer)
      fire()
    },
    stop(): void {
      clearTimeout(timer)
      timer = undefined
      pending = undefined
    },
  }
}
