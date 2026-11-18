import { readFileSync } from "node:fs"
import { z } from "zod"
import { CpuProfileSchema, ownFrame, type CpuProfile } from "@mako/host/base/loop-profile"

/*
 * What held the host's main thread over a recorded run (`bench:host-load --record`): each gap the recorder kept
 * between two of its ticks (`host-load-recorder.mjs`), set against the samples of the run's CPU profile in that gap,
 * so every stretch has its length, the host's function nearest the top of its stacks, and the named work open then.
 * The same is said per stretch of the run (start, baseline, steady, burst), with the loop's delay, how busy it was,
 * its collections and its memory, each beside the yardstick's delay over the same stretch.
 */

export const RecordingSchema = z.object({
  pid: z.number(), tickMs: z.number(), holdMs: z.number(),
  mark: z.object({ at: z.number(), name: z.string() }),
  ticks: z.object({ at: z.array(z.number()), late: z.array(z.number()) }),
  holds: z.array(z.object({ from: z.number(), to: z.number(), cpuMs: z.number().optional(), during: z.array(z.string()) })),
  samples: z.array(z.object({ at: z.number(), activeMs: z.number(), idleMs: z.number(), rssMb: z.number(), heapUsedMb: z.number(), heapTotalMb: z.number(), externalMb: z.number(), cpuMs: z.number() })),
  collections: z.array(z.tuple([z.number(), z.number(), z.number()])),
  /** Journal commits: every one summed by part, and each slow one as `[at, begin, rows, commit, background]`. */
  commits: z.object({ count: z.number(), beginMs: z.number(), rowsMs: z.number(), commitMs: z.number(), foreground: z.number(), slow: z.array(z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.string(), z.number()])) }).optional(),
})
export type Recording = z.infer<typeof RecordingSchema>

export const ThreadRecordingSchema = z.object({
  pid: z.number(), threadId: z.number(), since: z.number(), at: z.number(), activeMs: z.number(), idleMs: z.number(),
  delayMs: z.object({ p50: z.number(), p99: z.number(), max: z.number() }),
})

export const SeriesSchema = z.object({ at: z.array(z.number()), late: z.array(z.number()) })
export type Series = z.infer<typeof SeriesSchema>

export interface Phase {
  name: string
  from: number
  to: number
}

/** One stretch the thread was held: when, the gap between the ticks around it, and the milliseconds of it the thread ran. */
export interface Hold {
  at: number
  phase: string
  gapMs: number
  ms: number
  /** The host's function nearest the leaf on most of its samples, and the outermost one. */
  top: string
  entry: string
  /** The host's functions on its stacks with each one's milliseconds, and the leaf functions (Node's and V8's included). */
  frames: { frame: string; ms: number }[]
  leaves: { frame: string; ms: number }[]
  gcMs: number
  /** The thread's own CPU time in the gap, where the recorder kept it: the rest of the gap it waited, or wasn't run. */
  cpuMs?: number
  /** The yardstick's worst lateness over the same moments: a machine that stopped every process stops it too. */
  yardstickMs?: number
  during: string[]
}

const NONE = "(no host function)"
const round = (ms: number) => Math.round(ms * 10) / 10

function percentiles(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0
  return { n: sorted.length, p50: round(at(0.5)), p95: round(at(0.95)), p99: round(at(0.99)), max: round(sorted.at(-1) ?? 0) }
}

/** The profile's samples on the recorder's clock, each with what its stack says. */
export function timeline(profile: CpuProfile, recording: Recording) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const stacks = new Map<number, { own: string[]; leaf: string; idle: boolean; mark: boolean }>()
  const stackOf = (id: number) => {
    const known = stacks.get(id)
    if (known) return known
    const own: string[] = []
    let mark = false
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) {
      const frame = byId.get(at)!.callFrame
      if (frame.functionName === recording.mark.name) mark = true
      const named = ownFrame(frame)
      if (named && !own.includes(named)) own.push(named)
    }
    const leafFrame = byId.get(id)!.callFrame
    const file = leafFrame.url.split("/").at(-1)
    const made = { own, leaf: ownFrame(leafFrame) ?? `${leafFrame.functionName || "(anonymous)"}${file ? ` ${file}` : ""}`, idle: leafFrame.functionName === "(idle)", mark }
    stacks.set(id, made)
    return made
  }
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  const times = new Float64Array(samples.length + 1)
  let time = profile.startTime
  let markAt: number | undefined
  for (let index = 0; index < samples.length; index += 1) {
    time += deltas[index] ?? 0
    times[index] = time / 1000
    if (markAt === undefined && stackOf(samples[index]!).mark) markAt = time / 1000
  }
  times[samples.length] = time / 1000
  if (markAt === undefined) throw new Error("The profile holds no sample of the recorder's clock mark")
  // The mark began at `recording.mark.at` on the recorder's clock and at `markAt` on the profile's.
  const offset = recording.mark.at - markAt
  for (let index = 0; index <= samples.length; index += 1) times[index]! += offset
  /** The first sample at or after `at`. */
  const firstFrom = (at: number) => {
    let low = 0, high = samples.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (times[middle]! < at) low = middle + 1
      else high = middle
    }
    return low
  }
  /** Each sample between `from` and `to` that wasn't idle, with the milliseconds it stands for. */
  const each = (from: number, to: number, take: (stack: { own: string[]; leaf: string }, ms: number) => void) => {
    for (let index = Math.max(0, firstFrom(from) - 1); index < samples.length && times[index]! < to; index += 1) {
      const ms = Math.min(to, times[index + 1]!) - Math.max(from, times[index]!)
      if (ms <= 0) continue
      const stack = stackOf(samples[index]!)
      if (!stack.idle) take(stack, ms)
    }
  }
  return { each }
}

/** The yardstick's worst lateness in the ticks from just before `from` to just after `to`. */
function yardstickOver(series: Series, from: number, to: number): number {
  let low = 0, high = series.at.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (series.at[middle]! < from - 25) low = middle + 1
    else high = middle
  }
  let worst = 0
  for (let at = low; at < series.at.length && series.at[at]! <= to + 25; at += 1) worst = Math.max(worst, series.late[at]!)
  return round(worst)
}

const most = (totals: Map<string, number>, top: number) => [...totals].sort((a, b) => b[1] - a[1]).slice(0, top).map(([frame, ms]) => ({ frame, ms: round(ms) }))
const add = (totals: Map<string, number>, key: string, ms: number) => totals.set(key, (totals.get(key) ?? 0) + ms)

export interface RecordedRun {
  recording: string
  profile: string
  phases: Phase[]
  yardstick?: Series
  /** A stretch the thread ran this long between two ticks is listed. */
  minMs?: number
}

/** Everything a recorded run says: each stretch's numbers, every hold, and the holds grouped by the host's function. */
export function recordedRun(run: RecordedRun) {
  const minMs = run.minMs ?? 20
  const recording = RecordingSchema.parse(JSON.parse(readFileSync(run.recording, "utf8")))
  const samples = timeline(CpuProfileSchema.parse(JSON.parse(readFileSync(run.profile, "utf8"))), recording)
  const phaseOf = (at: number) => run.phases.find((phase) => at >= phase.from && at < phase.to)?.name ?? "between"

  const holds: Hold[] = []
  for (const gap of recording.holds) {
    const own = new Map<string, number>(), tops = new Map<string, number>(), entries = new Map<string, number>(), leaves = new Map<string, number>()
    let ms = 0
    samples.each(gap.from, gap.to, (stack, each) => {
      ms += each
      for (const frame of stack.own) add(own, frame, each)
      add(tops, stack.own[0] ?? NONE, each)
      add(entries, stack.own.at(-1) ?? NONE, each)
      add(leaves, stack.leaf, each)
    })
    if (ms < minMs) continue
    holds.push({
      at: Math.round(gap.from), phase: phaseOf(gap.from), gapMs: round(gap.to - gap.from), ms: round(ms),
      top: most(tops, 1)[0]?.frame ?? NONE, entry: most(entries, 1)[0]?.frame ?? NONE,
      frames: most(own, 6), leaves: most(leaves, 3), gcMs: round(leaves.get("(garbage collector)") ?? 0),
      ...gap.cpuMs !== undefined && { cpuMs: gap.cpuMs }, ...run.yardstick && { yardstickMs: yardstickOver(run.yardstick, gap.from, gap.to) }, during: gap.during,
    })
  }

  const grouped = (of: Hold[], key: (hold: Hold) => string) => {
    const groups = new Map<string, { count: number; totalMs: number; worstMs: number; phases: Map<string, number>; entries: Map<string, number>; during: Map<string, number>; leaves: Map<string, number> }>()
    for (const hold of of) {
      const name = key(hold)
      const group = groups.get(name) ?? { count: 0, totalMs: 0, worstMs: 0, phases: new Map(), entries: new Map(), during: new Map(), leaves: new Map() }
      group.count += 1
      group.totalMs += hold.ms
      group.worstMs = Math.max(group.worstMs, hold.ms)
      add(group.phases, hold.phase, hold.ms)
      add(group.entries, hold.entry, hold.ms)
      for (const leaf of hold.leaves) add(group.leaves, leaf.frame, leaf.ms)
      for (const work of hold.during) add(group.during, work.replace(/ \(\d+ ms\)$/, ""), 1)
      groups.set(name, group)
    }
    return [...groups].map(([name, group]) => ({
      top: name, count: group.count, totalMs: round(group.totalMs), worstMs: round(group.worstMs),
      phases: Object.fromEntries([...group.phases].map(([phase, ms]) => [phase, round(ms)])),
      entries: most(group.entries, 3), leaves: most(group.leaves, 3),
      during: [...group.during].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([work, count]) => `${work} x${count}`),
    }))
  }
  const byTop = grouped(holds, (hold) => hold.top)

  const phases = run.phases.map((phase) => {
    const within = <Value>(values: Value[], at: (value: Value) => number) => values.filter((value) => at(value) >= phase.from && at(value) < phase.to)
    const late: number[] = []
    for (let index = 0; index < recording.ticks.at.length; index += 1)
      if (recording.ticks.at[index]! >= phase.from && recording.ticks.at[index]! < phase.to) late.push(recording.ticks.late[index]!)
    const yard: number[] = []
    if (run.yardstick)
      for (let index = 0; index < run.yardstick.at.length; index += 1)
        if (run.yardstick.at[index]! >= phase.from && run.yardstick.at[index]! < phase.to) yard.push(run.yardstick.late[index]!)
    const seconds = within(recording.samples, (sample) => sample.at)
    const active = seconds.reduce((sum, sample) => sum + sample.activeMs, 0)
    const idle = seconds.reduce((sum, sample) => sum + sample.idleMs, 0)
    const collections = within(recording.collections, (collection) => collection[0])
    const major = collections.filter((collection) => collection[2] !== 1)
    const spread = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return sorted.length ? { min: sorted[0]!, median: sorted[Math.floor(sorted.length / 2)]!, max: sorted.at(-1)! } : null
    }
    const self = new Map<string, number>(), leaves = new Map<string, number>(), entries = new Map<string, number>()
    let ran = 0
    samples.each(phase.from, phase.to, (stack, ms) => {
      ran += ms
      add(self, stack.own[0] ?? NONE, ms)
      add(entries, stack.own.at(-1) ?? NONE, ms)
      add(leaves, stack.leaf, ms)
    })
    const held = holds.filter((hold) => hold.phase === phase.name)
    return {
      name: phase.name, seconds: round((phase.to - phase.from) / 1000),
      // From the profile's samples; the loop's own utilization reads high under the sampler, so it is said apart.
      busyShare: Math.round((ran / Math.max(1, phase.to - phase.from)) * 1000) / 1000,
      loopUtilization: active + idle ? Math.round((active / (active + idle)) * 1000) / 1000 : null,
      processCpuShare: seconds.length ? Math.round((seconds.reduce((sum, sample) => sum + sample.cpuMs, 0) / (seconds.length * 1000)) * 1000) / 1000 : null,
      loopLateMs: percentiles(late), yardstickLateMs: run.yardstick ? percentiles(yard) : null,
      holds: { count: held.length, totalMs: round(held.reduce((sum, hold) => sum + hold.ms, 0)), worstMs: round(Math.max(0, ...held.map((hold) => hold.ms))), over50: held.filter((hold) => hold.ms >= 50).length, over100: held.filter((hold) => hold.ms >= 100).length },
      gc: {
        count: collections.length, totalMs: round(collections.reduce((sum, collection) => sum + collection[1], 0)), maxMs: round(Math.max(0, ...collections.map((collection) => collection[1]))),
        major: major.length, majorMs: round(major.reduce((sum, collection) => sum + collection[1], 0)),
      },
      rssMb: spread(seconds.map((sample) => sample.rssMb)), heapUsedMb: spread(seconds.map((sample) => sample.heapUsedMb)), externalMb: spread(seconds.map((sample) => sample.externalMb)),
      profile: { ranMs: Math.round(ran), bySelf: most(self, 30), byEntry: most(entries, 20), byLeaf: most(leaves, 20) },
      heldBy: grouped(held, (hold) => hold.top).sort((a, b) => b.totalMs - a.totalMs).slice(0, 15).map((group) => ({ top: group.top, count: group.count, totalMs: group.totalMs, worstMs: group.worstMs })),
    }
  })

  const slow = recording.commits?.slow ?? []
  const part = (at: 1 | 2 | 3, of: typeof slow) => round(of.reduce((sum, commit) => sum + commit[at], 0))
  const over = (ms: number, of: typeof slow) => of.filter((commit) => commit[1] + commit[2] + commit[3] >= ms)
  const commits = recording.commits && {
    count: recording.commits.count, foreground: recording.commits.foreground,
    beginMs: round(recording.commits.beginMs), rowsMs: round(recording.commits.rowsMs), commitMs: round(recording.commits.commitMs),
    meanMicros: Math.round(((recording.commits.beginMs + recording.commits.rowsMs + recording.commits.commitMs) / Math.max(1, recording.commits.count)) * 1000),
    slow: [5, 20, 100].map((ms) => {
      const these = over(ms, slow)
      return { overMs: ms, count: these.length, beginMs: part(1, these), rowsMs: part(2, these), commitMs: part(3, these), foreground: these.filter((commit) => commit[4] === 0).length }
    }),
    worst: [...slow].sort((a, b) => b[1] + b[2] + b[3] - (a[1] + a[2] + a[3])).slice(0, 8).map(([at, beginMs, rowsMs, commitMs, background]) => ({ phase: phaseOf(at), beginMs, rowsMs, commitMs, background: background === 1 })),
    /** Each commit of 20 ms or more: whose it was, whether its turn ran and a worker checkpointed it, and its milliseconds. */
    slowOnes: over(20, slow).map(([at, beginMs, rowsMs, commitMs, background, conversation, running]) => ({ phase: phaseOf(at), conversation, running: running === 1, background: background === 1, ms: round(beginMs + rowsMs + commitMs) })),
  }

  return {
    minMs, tickMs: recording.tickMs,
    ...commits && { commits },
    phases,
    holds: { count: holds.length, totalMs: round(holds.reduce((sum, hold) => sum + hold.ms, 0)) },
    byTotal: [...byTop].sort((a, b) => b.totalMs - a.totalMs),
    byWorst: [...byTop].sort((a, b) => b.worstMs - a.worstMs).slice(0, 25).map((group) => ({ top: group.top, worstMs: group.worstMs, count: group.count, totalMs: group.totalMs })),
    series: recording.samples.filter((_, index) => index % 5 === 0).map((sample) => [sample.at, sample.rssMb, sample.heapUsedMb, Math.round((sample.activeMs / Math.max(1, sample.activeMs + sample.idleMs)) * 100)]),
    every: holds,
  }
}

/** A worker thread's own profile: how long it ran, and the host's files it ran in. */
export function threadProfile(path: string) {
  const profile = CpuProfileSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  const byId = new Map(profile.nodes.map((node) => [node.id, node]))
  const parent = new Map<number, number>()
  for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id)
  const entryOf = (id: number) => {
    let entry: string | undefined
    for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) entry = ownFrame(byId.get(at)!.callFrame) ?? entry
    return entry ?? NONE
  }
  const entries = new Map<string, number>()
  let ran = 0, whole = 0
  const samples = profile.samples ?? []
  for (let index = 0; index < samples.length; index += 1) {
    const ms = ((profile.timeDeltas ?? [])[index + 1] ?? 0) / 1000
    whole += ms
    if (byId.get(samples[index]!)!.callFrame.functionName === "(idle)") continue
    ran += ms
    add(entries, entryOf(samples[index]!), ms)
  }
  return { ranMs: Math.round(ran), ofMs: Math.round(whole), byEntry: most(entries, 4) }
}
