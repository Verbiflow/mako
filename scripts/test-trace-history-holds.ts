import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { beginTrace, TraceRefresh } from "@mako/host/workspaces/app-probe"
import type { FileHistory, HistoryOptions, HistoryRead } from "@mako/host/workspaces/watch-backend"

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
 */

const PATHS = 345_000
const FOLDERS = 50
const KEPT = 20
const HOLD_LIMIT_MS = Number(process.env.TRACE_HOLD_LIMIT_MS ?? 250)

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

function history(honours: boolean, asked: HistoryOptions[]): FileHistory {
  return {
    mark: async () => ({ id: "1", at: "1" }),
    since: async (_mark, _roots, options) => {
      asked.push(options ?? {})
      return honours && options?.perFolder !== undefined ? keptTo(every, options.perFolder) : { paths: every, lost: [], ignored: [] }
    },
  }
}

const TraceSchema = z.object({ changed: z.record(z.string(), z.object({ paths: z.array(z.string()), more: z.boolean().optional() })) })

/** The longest the loop went without a turn while `work` ran, by a timer due every millisecond. */
async function longestHold(work: () => Promise<void>): Promise<number> {
  let last = performance.now()
  let longest = 0
  const timer = setInterval(() => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
  }, 1)
  try {
    await work()
    await new Promise((resume) => setTimeout(resume, 5))
  } finally {
    clearInterval(timer)
  }
  return longest
}

try {
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
    const held = await longestHold(async () => { await new TraceRefresh().refresh(apps.map((folder) => ({ folder, pids: [] })), { history: reader, home }) })
    console.log(`${name}: ${PATHS} paths for ${apps.length} apps in ${Math.round(performance.now() - began)} ms, the loop held at most ${Math.round(held)} ms`)
    assert.ok(asked.some((options) => options.perFolder === KEPT), "the trace asks the child for a few paths of each folder")
    assert.ok(held < HOLD_LIMIT_MS, `${name}: the loop was held ${Math.round(held)} ms, over ${HOLD_LIMIT_MS} ms`)
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
