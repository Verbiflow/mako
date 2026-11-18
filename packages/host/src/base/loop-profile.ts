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
  /**
   * What ran with none of the host's functions on its stack, by the innermost frame, most first: garbage collection
   * (`(gc)`), V8's own work (`(program)`), a native call (`name (native)`), Node's (`name node:module`) or a
   * dependency's (`name package`). Slices the person's host held for 7 s at a time named no frame at all.
   */
  outside: { frame: string; ms: number }[]
}

/** `function package/file:line` for a frame of Mako's own packages; undefined for a dependency's, Node's or V8's. */
function ownFrame(frame: CpuProfile["nodes"][number]["callFrame"]): string | undefined {
  // The installed app runs the host bundled into `dist-electron/<program>/` (`bundle-main.mjs`), which holds Mako's
  // packages alone, every other package staying external: each frame there is Mako's, named by its chunk. Unmatched,
  // every slice of the installed host's profile named nothing ("7288 ms:"), on a day its loop was held 97% of a launch.
  const bundled = /\/dist-electron\/([^/]+)\/([^/]+\.js)$/.exec(frame.url)
  if (bundled) return `${frame.functionName || "(anonymous)"} ${bundled[1]}/${bundled[2]}:${frame.lineNumber + 1}`
  // In a checkout under `packages/`; under `node_modules/@mako/`, which is the host's own too.
  const own = /\/(?:packages|node_modules\/@mako)\/([^/]+)\/(?:(?:dist|src)\/)?(.+)$/.exec(frame.url)
  if (!own || /\/node_modules\/(?!@mako\/)/.test(frame.url.slice(own.index))) return undefined
  return `${frame.functionName || "(anonymous)"} ${own[1]}/${own[2]}:${frame.lineNumber + 1}`
}

/** The innermost frame of a stack with none of the host's on it, as `LoopSlice.outside` names it. */
function outsideFrame(frame: CpuProfile["nodes"][number]["callFrame"]): string {
  const name = frame.functionName || "(anonymous)"
  if (name === "(garbage collector)") return "(gc)"
  if (name === "(program)" || name === "(root)") return name
  if (!frame.url) return `${name} (native)`
  if (frame.url.startsWith("node:")) return `${name} ${frame.url}`
  const dependency = /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(frame.url)
  return `${name} ${dependency?.[1] ?? frame.url.split("/").slice(-2).join("/")}`
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
  let open: { at: number; ms: number; frames: Map<string, number>; outside: Map<string, number> } | undefined
  const busiest = (counted: Map<string, number>, top: number) =>
    [...counted].sort((a, b) => b[1] - a[1]).slice(0, top).map(([frame, ms]) => ({ frame, ms: Math.round(ms) }))
  const close = () => {
    if (open && open.ms >= minMs)
      found.push({ at: Math.round(open.at), ms: Math.round(open.ms), frames: busiest(open.frames, frames), outside: busiest(open.outside, 4) })
    open = undefined
  }
  for (let index = 0; index < samples.length; index += 1) {
    // A sample's time runs to the next one.
    const ms = (deltas[index + 1] ?? 0) / 1000
    const node = byId.get(samples[index]!)!
    if (node.callFrame.functionName === "(idle)") {
      close()
    } else {
      open ??= { at: time, ms: 0, frames: new Map(), outside: new Map() }
      open.ms += ms
      const own = stackOf(node.id)
      for (const frame of own) open.frames.set(frame, (open.frames.get(frame) ?? 0) + ms)
      if (!own.length) {
        const outside = outsideFrame(node.callFrame)
        open.outside.set(outside, (open.outside.get(outside) ?? 0) + ms)
      }
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
