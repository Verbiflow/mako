import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { beginTrace, TraceRefresh } from "@mako/host/workspaces/app-probe"
import type { FileHistory, HistoryOptions, HistoryRead } from "@mako/host/workspaces/watch-backend"
import { longestHold } from "./lib/loop-hold.ts"

/**
 * "trace running thread apps" against a busy day's history: on 2026-11-12 a read of the file system's history since a
 * running app's mark held 211,905 and then 344,999 paths, and the host placed every one of them, once per app, on its
 * own thread, while the job stayed open for 13 s and sends waited behind it. A trace keeps 20 paths of a folder; the
 * rest only say there were more. So the watcher child sends at most that many of each folder (`perFolder`), and the
 * host places what it's sent between turns of its loop, once for every app sharing the read.
 *
 * Two histories: one that sends every path (as a child from before `perFolder` would), which the host must still place
 * without holding its loop, and one that keeps to `perFolder` as the child does. Both must leave the same trace: every
 * folder named, 20 of its paths, and `more` where it had more.
 *
 * A hold is judged by the CPU the loop's thread used in its busiest gap (`longestHold`), against this run's own
 * yardstick: the CPU the whole placing of every path took, which is what the loop would be held for were it placed at
 * once. No gap may use a `TIMES`th of it: over 50 runs on two cores, half of them beside four busy processes, the
 * busiest gap used 2.0% to 4.3% of the whole, and slices of 100 ms in place of 8 use 40%. By the clock a gap says how
 * busy the runner is, not what the host did: on 2026-11-20 this failed main at 272 ms of a 250 ms limit while the gate
 * installed packages and compiled beside it, and beside those four processes the same placing reads 73 to 89 ms by
 * the clock with 4 to 25 ms of CPU in it, where alone it reads 17 to 40. The clock keeps a loose bound (`WALL_MS`).
 */

const PATHS = 345_000
const FOLDERS = 50
const KEPT = 20
/** How many times shorter than the whole placing its busiest gap must be, by CPU. */
const TIMES = 8
/** The longest gap by the clock: a sanity bound for a runner that preempts the process, well under the 13 s it was. */
const WALL_MS = 3_000

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-trace-holds-")))
const home = join(root, "home")
const caches = join(home, "Library", "Caches")
mkdirSync(caches, { recursive: true })
const folderOfIndex = (index: number) => join(caches, `app-${index % FOLDERS}`)
const every = Array.from({ length: PATHS }, (_, index) => join(folderOfIndex(index), "blobs", `${index}.bin`))

/** What the child sends with `perFolder`: a folder's first paths, the rest counted. */
function keptTo(paths: string[], perFolder: number): HistoryRead {
  const sent = new Map<string, number>()
  const capped = new Set<string>()
  const kept: string[] = []
  for (const path of paths) {
    const folder = path.slice(0, path.indexOf("/", caches.length + 1))
    const count = sent.get(folder) ?? 0
    if (count >= perFolder) capped.add(folder)
    else {
      sent.set(folder, count + 1)
      kept.push(path)
    }
  }
  return { paths: kept, lost: [], ignored: [], capped: [...capped] }
}

/**
 * What the child that keeps to `perFolder` sends, made before any hold is timed: the child's work is its own process's.
 * Made as it was asked for, going through 345,000 paths here was the longest gap of that history's refresh, 63 to
 * 67 ms of the test's own, and up to 199 ms beside other work.
 */
const keptRead = keptTo(every, KEPT)

function history(honours: boolean, asked: HistoryOptions[]): FileHistory {
  return {
    mark: async () => ({ id: "1", at: "1" }),
    since: async (_mark, _roots, options) => {
      asked.push(options ?? {})
      if (!honours || options?.perFolder === undefined) return { paths: every, lost: [], ignored: [] }
      assert.equal(options.perFolder, KEPT, "the trace asks for as many paths of a folder as it keeps")
      return keptRead
    },
  }
}

const TraceSchema = z.object({ changed: z.record(z.string(), z.object({ paths: z.array(z.string()), more: z.boolean().optional() })) })

/** `work`'s longest gaps (`longestHold`), and the CPU the loop's thread used from its start to its end. */
async function timed(work: () => Promise<void>): Promise<{ wallMs: number; busiestCpuMs: number; wholeCpuMs: number }> {
  const before = process.threadCpuUsage()
  let wholeCpuMs = 0
  const hold = await longestHold(async () => {
    await work()
    const used = process.threadCpuUsage(before)
    wholeCpuMs = (used.user + used.system) / 1_000
  })
  return { wallMs: hold.ms, busiestCpuMs: hold.busiest.cpuMs, wholeCpuMs }
}

try {
  // The yardstick: what placing every path costs this run, set by the first history.
  let limitCpuMs = Number.POSITIVE_INFINITY
  for (const honours of [false, true]) {
    const name = honours ? "a child that keeps to perFolder" : "a child that sends every path"
    const apps = Array.from({ length: 3 }, (_, index) => join(root, `${honours ? "kept" : "every"}-${index}`))
    const asked: HistoryOptions[] = []
    const reader = history(honours, asked)
    for (const folder of apps) {
      mkdirSync(folder, { recursive: true })
      writeFileSync(join(folder, "up"), "1000")
      await beginTrace(folder, 1000, reader, home)
    }
    const began = performance.now()
    const held = await timed(async () => { await new TraceRefresh().refresh(apps.map((folder) => ({ folder, pids: [] })), { history: reader, home }) })
    if (!honours) limitCpuMs = held.wholeCpuMs / TIMES
    console.log(`${name}: ${PATHS} paths for ${apps.length} apps in ${Math.round(performance.now() - began)} ms, ${Math.round(held.wholeCpuMs)} ms of CPU; its busiest gap used ${held.busiestCpuMs.toFixed(1)} ms of CPU (limit ${limitCpuMs.toFixed(1)} ms, 1/${TIMES} of placing every path), its longest was ${Math.round(held.wallMs)} ms by the clock (limit ${WALL_MS})`)
    assert.ok(asked.some((options) => options.perFolder === KEPT), "the trace asks the child for a few paths of each folder")
    assert.ok(held.busiestCpuMs < limitCpuMs, `${name}: the loop's busiest gap used ${held.busiestCpuMs.toFixed(1)} ms of CPU, not under ${limitCpuMs.toFixed(1)} ms, 1/${TIMES} of the ${Math.round(limitCpuMs * TIMES)} ms placing every path took`)
    assert.ok(held.wallMs < WALL_MS, `${name}: the loop was held ${Math.round(held.wallMs)} ms by the clock, not under ${WALL_MS} ms`)
    for (const folder of apps) {
      const trace = TraceSchema.parse(JSON.parse(readFileSync(join(folder, "probe.json"), "utf8")))
      const changed = Object.entries(trace.changed).filter(([at]) => at.startsWith(caches))
      assert.equal(changed.length, FOLDERS, `${name}: every folder that changed is named`)
      for (const [at, entry] of changed) {
        assert.equal(entry.paths.length, KEPT, `${name}: ${at} keeps ${KEPT} paths`)
        assert.ok(entry.paths.every((inner) => inner.startsWith("blobs/")), `${name}: ${at}'s paths are inside it`)
        assert.equal(entry.more, true, `${name}: ${at} says it had more`)
      }
    }
  }
  console.log("trace history holds: a busy day's history is placed without holding the loop, the child sends a few paths of each folder, and both leave the same trace")
} finally {
  rmSync(root, { recursive: true, force: true })
}
