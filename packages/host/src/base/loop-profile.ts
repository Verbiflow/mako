import { Session } from "node:inspector/promises"
import { z } from "zod"

/*
 * What held the event loop, from V8's sampling profiler: a slice is a run of
 * samples that never went idle, so its length is how long the loop was held,
 * and the host's own functions on its stacks say by what. The loop watch's
 * `during` names every piece of work open at a hold, most of them waiting on
 * a process; this names the one on the thread.
 */

export const CpuProfileSchema = z.object({
  nodes: z.array(z.object({
    id: z.number(),
    callFrame: z.object({ functionName: z.string(), url: z.string(), lineNumber: z.number() }),
    children: z.array(z.number()).optional(),
  })),
  startTime: z.number(),
  samples: z.array(z.number()).optional(),
  timeDeltas: z.array(z.number()).optional(),
})
export type CpuProfile = z.infer<typeof CpuProfileSchema>

export interface LoopSlice {
  /** Milliseconds since the profile began, and how long the loop was held. */
  at: number
  ms: number
  /** The host's functions on the slice's stacks, with the milliseconds each was on them, most first. */
  frames: { frame: string; ms: number }[]
}

/** `function package/file:line` for a frame of Mako's own packages; undefined for a dependency's, Node's or V8's. */
function ownFrame(frame: CpuProfile["nodes"][number]["callFrame"]): string | undefined {
  // In a checkout under `packages/`; in the installed app, under `node_modules/@mako/`, which is the host's own too.
  const own = /\/(?:packages|node_modules\/@mako)\/([^/]+)\/(?:(?:dist|src)\/)?(.+)$/.exec(frame.url)
  if (!own || /\/node_modules\/(?!@mako\/)/.test(frame.url.slice(own.index))) return undefined
  return `${frame.functionName || "(anonymous)"} ${own[1]}/${own[2]}:${frame.lineNumber + 1}`
}

/** Every slice of at least `minMs`, in order, each with its `frames` busiest frames. */
export function loopSlices(profile: CpuProfile, minMs: number, frames = 8): LoopSlice[] {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const stacks = new Map<number, string[]>()
  const stackOf = (id: number) => {
    let known = stacks.get(id)
    if (known) return known
    const own = new Set<string>()
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const frame = ownFrame(byId.get(at)!.callFrame)
      if (frame) own.add(frame)
    }
    known = [...own]
    stacks.set(id, known)
    return known
  }
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const found: LoopSlice[] = []
  let time = 0
  let open: { at: number; ms: number; frames: Map<string, number> } | undefined
  const close = () => {
    if (open && open.ms >= minMs)
      found.push({ at: Math.round(open.at), ms: Math.round(open.ms), frames: [...open.frames].sort((a, b) => b[1] - a[1]).slice(0, frames).map(([frame, ms]) => ({ frame, ms: Math.round(ms) })) })
    open = undefined
  }
  for (let index = 0; index < samples.length; index += 1) {
    // A sample's time runs to the next one.
    const ms = (deltas[index + 1] ?? 0) / 1000
    const node = byId.get(samples[index]!)!
    if (node.callFrame.functionName === "(idle)") {
      close()
    } else {
      open ??= { at: time, ms: 0, frames: new Map() }
      open.ms += ms
      for (const frame of stackOf(node.id)) open.frames.set(frame, (open.frames.get(frame) ?? 0) + ms)
    }
    time += ms
  }
  close()
  return found
}

/** Each frame's milliseconds across `slices`, most first: what held the loop, all told. */
export function heldBy(slices: readonly LoopSlice[], top = 25): { frame: string; ms: number; slices: number }[] {
  const total = new Map<string, { ms: number; slices: number }>()
  for (const slice of slices)
    for (const { frame, ms } of slice.frames) {
      const known = total.get(frame) ?? { ms: 0, slices: 0 }
      total.set(frame, { ms: known.ms + ms, slices: known.slices + 1 })
    }
  return [...total].sort((a, b) => b[1].ms - a[1].ms).slice(0, top).map(([frame, { ms, slices }]) => ({ frame, ms, slices }))
}

/** Samples a millisecond apart: fine enough to name a 100 ms slice, light enough for a window of seconds. */
const SAMPLE_US = 1_000

/**
 * A window of the host's own profile once its loop has been held, in this
 * process (`node:inspector`, no port opened), at most one at a time and one
 * per `restMs`: what a held loop's log line can't say, said the next time it
 * happens.
 */
export class HeldLoopProfiler {
  private readonly windowMs: number
  private readonly restMs: number
  private readonly report: (slices: LoopSlice[], ms: number) => void
  private session: Session | undefined
  private lastAt = Number.NEGATIVE_INFINITY

  constructor(options: { windowMs: number; restMs: number; report: (slices: LoopSlice[], ms: number) => void }) {
    this.windowMs = options.windowMs
    this.restMs = options.restMs
    this.report = options.report
  }

  /** A hold was seen: a window starts unless one runs or ran within `restMs`. */
  held(): void {
    const now = performance.now()
    if (this.session || now - this.lastAt < this.restMs) return
    this.lastAt = now
    void this.window().catch(() => undefined)
  }

  stop(): void {
    this.session?.disconnect()
    this.session = undefined
  }

  private async window(): Promise<void> {
    const session = new Session()
    this.session = session
    try {
      session.connect()
      await session.post("Profiler.enable")
      await session.post("Profiler.setSamplingInterval", { interval: SAMPLE_US })
      await session.post("Profiler.start")
      await new Promise<void>((resolve) => setTimeout(resolve, this.windowMs).unref())
      if (this.session !== session) return
      const { profile } = z.object({ profile: CpuProfileSchema }).parse(await session.post("Profiler.stop"))
      this.report(loopSlices(profile, 100, 4), this.windowMs)
    } finally {
      session.disconnect()
      if (this.session === session) this.session = undefined
    }
  }
}
