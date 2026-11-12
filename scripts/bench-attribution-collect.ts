import { execFileSync } from "node:child_process"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { collectPlanOffThread } from "@mako/host/attribution/journal-reader"
import { COLLECT_MOST, JournalStore } from "@mako/host/attribution/journal-store"
import { makeSyntheticJournal } from "./lib/synthetic-journal.ts"

/*
 * The hourly collection of kept content, on the host's thread and on a worker, on a journal the size of the person's
 * (`npx tsx scripts/bench-attribution-collect.ts [--journal <file>]`). Each runs on its own clone of the same journal
 * while this process writes activity every 10 ms, as an owner's live batches do: prints how long it took, the longest
 * the loop went without turning, the slowest of those writes (one waiting on the worker's write lock), and what each
 * dropped. On the person's host the collection on its thread held the loop 2.4 to 3.9 s every hour.
 */
const { values } = parseArgs({ options: { journal: { type: "string" }, days: { type: "string", default: "14" } } })
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-collect-")))
const source = values.journal ?? join(scratch, "made.sqlite")
if (!values.journal) makeSyntheticJournal(source, { log: (line) => console.log(`  made ${line}`) })
const retainAfter = Date.now() - Number(values.days) * 86_400_000
const budget = 2 * 1024 ** 3
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function run(mode: "here" | "worker") {
  const file = join(scratch, `${mode}.sqlite`)
  execFileSync("cp", ["-c", source, file])
  const store = JournalStore.open(file, { device: "bench" })
  let longest = 0
  let slowestWrite = 0
  let writes = 0
  let last = performance.now()
  let running = true
  const tick = () => {
    const now = performance.now()
    longest = Math.max(longest, now - last)
    last = now
    if (!running) return
    // A live batch's activity, as the owner writes it.
    const started = performance.now()
    store.saveActivity({ kind: "call", id: `bench-${writes++}`, session: "bench-session", thread: "bench-thread", named: [], start: Date.now(), end: null })
    slowestWrite = Math.max(slowestWrite, performance.now() - started)
    setTimeout(tick, 10)
  }
  setTimeout(tick, 10)
  await pause(50)
  const started = performance.now()
  // The worker's way, as `LaptopTracker.collectOffThread` runs it: read there, dropped here 200 at a time.
  const offThread = async () => {
    store.touching()
    try {
      const plan = await collectPlanOffThread(file, retainAfter, budget)
      let dropped = 0
      let bytes = 0
      for (let first = 0; first < plan.refs.length; first += 200) {
        if (first) await new Promise<void>((resolve) => setImmediate(resolve))
        const batch = store.dropPlanned(plan.refs.slice(first, first + 200))
        dropped += batch.dropped
        bytes += batch.bytes
      }
      store.dropOld(retainAfter)
      return { dropped, bytes }
    } finally {
      store.untouched()
    }
  }
  const collected = mode === "here" ? store.collect(retainAfter, budget) : await offThread()
  const ms = performance.now() - started
  await pause(50)
  running = false
  store.close()
  rmSync(file, { force: true })
  return { mode, ms: Math.round(ms), loopHeldMs: Math.round(longest), slowestWriteMs: Math.round(slowestWrite), writes, dropped: collected.dropped, droppedMb: Math.round(collected.bytes / 1024 / 1024) }
}

const results = [await run("here"), await run("worker")]
console.table(results)
console.log(`a worker's pass drops at most ${COLLECT_MOST} blobs; the rest go on the next hour's`)
rmSync(scratch, { recursive: true, force: true })
