import { readFileSync } from "node:fs"
import { CpuProfileSchema } from "@mako/host/base/loop-profile"
import { RecordingSchema, timeline, type Phase } from "./host-load-holds.ts"

/*
 * A recorded run's thread time by where it came from (`bench:host-load --record`): each sample goes to the first
 * source below whose functions are on its stack, so a flush's time is split among what the flush calls, and what
 * shares the thread with it is told apart. Grouped by the host's function nearest the top of the stack alone, 473 s of
 * a run's 525 s held read as one SQLite pragma that six different walks were calling.
 */

/** Each source, most specific first: a sample is the first one's whose every listed function is on its stack. */
const SOURCES: readonly (readonly [string, readonly (readonly string[])[]])[] = [
  ["A working Threads counted from every conversation (workingThreads)", [["workingThreads"]]],
  ["A' working Threads kept as conversations change (WorkingSet)", [["conversations/cloud-handoffs"]]],
  ["B1 flush > SessionPublisher.own/#sawBatch (what a list shows of the batch's conversation)", [["#sawBatch"]]],
  ["B2 SessionPublisher's reports (reportedRows, ownedSessions)", [["host/conversations/session-report.js"]]],
  ["C flush > relocations.changed > Agents.moved/childMoved (a Fin's entry, its Apex's roster)", [["changed host/conversations/live-relocations"]]],
  ["D1 flush > LiveJournal.commit (SQLite)", [["commit host/conversations/live-journal"]]],
  ["D2 flush > sharedFields (whether whole fields changed)", [["sharedFields"]]],
  ["D3 flush > the batch's forms, deliverLiveUpdates, syncMemory, the rest of write()", [["write host/conversations/live-conversations", "!emit host/core"]]],
  ["D4 flush > emit > encoding and the windows' sockets", [["host/transport/server"], ["encodeRuntimeEvent"]]],
  ["D5 flush > emit > other listeners (attribution, spend, keep-awake)", [["write host/conversations/live-conversations"]]],
  ["E harness output > decoder > live engine > LiveEvents.accept (each token)", [["host/harnesses/"]]],
  ["F1 SessionUploads", [["session-uploads"]]],
  ["F2 the Fins' engine besides (list, start, reports, wakes)", [["host/conversations/agents.js"], ["agent-tools"]]],
  ["G journals opened, read, closed and paged; history reads", [["live-journal"], ["live-history-reader"], ["live-records"], ["live-sources"]]],
  ["H the host's start (modules, openCore)", [["CORE_IMPORTS"], ["host-domains"], ["openCore"], ["mako-host.js"]]],
  ["I1 Git (spawns, index lock, repositories)", [[" git/"]]],
  ["I2 file events, watchers, worktrees, Thread apps", [["host/workspaces/"]]],
  ["J the catalog's frames and the Thread store besides", [["sessions/daemon"], ["host/threads/"]]],
  ["K the held-loop profiler's own window", [["loop-profile"]]],
  ["L calls from windows and the prober", [["host/transport/"]]],
]
const OTHER = "Z other host code"
const NO_HOST = "Z0 Node and V8 with no host function (garbage collection included)"

function sourceOf(own: readonly string[]): string {
  if (!own.length) return NO_HOST
  const on = (name: string) => name.startsWith("!") ? !own.some((frame) => frame.includes(name.slice(1))) : own.some((frame) => frame.includes(name))
  return SOURCES.find(([, any]) => any.some((all) => all.every(on)))?.[0] ?? OTHER
}

/** Per source: the milliseconds the thread ran for it in each stretch, and of its holds the count it led and the worst. */
export function bySource(recordingPath: string, profilePath: string, phases: readonly Phase[], minMs = 20) {
  const recording = RecordingSchema.parse(JSON.parse(readFileSync(recordingPath, "utf8")))
  const samples = timeline(CpuProfileSchema.parse(JSON.parse(readFileSync(profilePath, "utf8"))), recording)
  const kept = new Map<string, { ran: Map<string, number>; held: number; holds: number; worst: number }>()
  const of = (source: string) => kept.get(source) ?? kept.set(source, { ran: new Map(), held: 0, holds: 0, worst: 0 }).get(source)!
  for (const phase of phases)
    samples.each(phase.from, phase.to, (stack, ms) => {
      const source = of(sourceOf(stack.own))
      source.ran.set(phase.name, (source.ran.get(phase.name) ?? 0) + ms)
    })
  for (const gap of recording.holds) {
    const mine = new Map<string, number>()
    let all = 0
    samples.each(gap.from, gap.to, (stack, ms) => {
      all += ms
      const source = sourceOf(stack.own)
      mine.set(source, (mine.get(source) ?? 0) + ms)
    })
    if (all < minMs) continue
    for (const [source, ms] of mine) of(source).held += ms
    const lead = of([...mine].sort((a, b) => b[1] - a[1])[0]![0])
    lead.holds += 1
    lead.worst = Math.max(lead.worst, all)
  }
  const seconds = new Map(phases.map((phase) => [phase.name, (phase.to - phase.from) / 1000]))
  return [...kept].map(([source, { ran, held, holds, worst }]) => ({
    source,
    ranMs: Object.fromEntries([...ran].map(([phase, ms]) => [phase, Math.round(ms)])),
    share: Object.fromEntries([...ran].map(([phase, ms]) => [phase, Math.round(ms / (seconds.get(phase) ?? 1)) / 10])),
    heldMs: Math.round(held), holdsLed: holds, worstMs: Math.round(worst),
  })).sort((a, b) => (b.ranMs.steady ?? 0) - (a.ranMs.steady ?? 0))
}
