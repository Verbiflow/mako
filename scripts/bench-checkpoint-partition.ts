import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { parseArgs } from "node:util"
import { JournalReader } from "@mako/host/attribution/journal-reader"
import { JournalStore } from "@mako/host/attribution/journal-store"
import { hunks, partition, storedView, type JournalView } from "@mako/host/attribution/queries"
import { threadFingerprint } from "@mako/host/workspaces/thread-checkpoint"

/*
 * What a Thread's checkpoint holds the host's loop for on a real journal: `partition()` and `threadFingerprint()` run
 * synchronously, so each one's time is a hold. Reads the device's shared journal read-only, as `npm run attribution`
 * does beside a running host, and never writes it. For each checkout given, takes the Threads that last wrote its
 * uncommitted changes, and times each one `--runs` times, cold first: `partition()` on this thread, and on the
 * journal's reader worker (`JournalReader.partition`, what a checkpoint reads), with the longest the event loop was
 * held during each; and `threadFingerprint()` of the partition. Prints the journal's size and, per checkout and Thread,
 * its changed files and the times. Paths and timings only.
 *
 *   npx tsx scripts/bench-checkpoint-partition.ts --checkout <folder> [--checkout <folder>] [--runs 5] [--journal <file>]
 */

const { values } = parseArgs({ options: { checkout: { type: "string", multiple: true }, runs: { type: "string", default: "5" }, journal: { type: "string" }, threads: { type: "string", default: "4" } } })
const journal = values.journal ?? (() => {
  const root = join(homedir(), ".mako", "attribution")
  const { readdirSync } = process.getBuiltinModule("fs")
  const found = readdirSync(root).map((name) => join(root, name, "journal.sqlite")).find((path) => existsSync(path))
  if (!found) throw new Error("no shared journal under ~/.mako/attribution; pass --journal")
  return found
})()
const runs = Number(values.runs)
const opened = performance.now()
const store = JournalStore.open(journal, { device: "", readOnly: true })
const viewStarted = performance.now()
const view: JournalView = storedView(store)
const viewMs = performance.now() - viewStarted
const { statSync } = process.getBuiltinModule("fs")
console.log(JSON.stringify({ journalBytes: statSync(journal).size, openMs: Math.round(viewStarted - opened), viewMs: Math.round(viewMs) }))

const stats = (times: number[]) => {
  const sorted = [...times].sort((a, b) => a - b)
  return { cold: Math.round(times[0]!), median: Math.round(sorted[Math.floor(sorted.length / 2)]!), max: Math.round(sorted.at(-1)!) }
}

for (const checkout of values.checkout ?? []) {
  const listed = hunks(view, checkout)
  const counts = new Map<string, number>()
  for (const hunk of listed) for (const writer of hunk.writers) if (writer.thread) counts.set(writer.thread, (counts.get(writer.thread) ?? 0) + 1)
  const threads = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(values.threads)).map(([thread]) => thread)
  const files = new Set(listed.map((hunk) => `${hunk.root}\0${hunk.path}`)).size
  const head = [...view.roots()].find((state) => state.root.path === checkout)?.root.head
  for (const thread of threads) {
    const partitions: number[] = []
    const fingerprints: number[] = []
    const offLoop: number[] = []
    const offLoopHeld: number[] = []
    let taken = 0
    for (let run = 0; run < runs; run++) {
      let at = performance.now()
      const read = partition(view, checkout, thread)
      taken = read.files.length
      partitions.push(performance.now() - at)
      at = performance.now()
      threadFingerprint(head, read, checkout)
      fingerprints.push(performance.now() - at)
      // The same read on the reader's worker, a fresh one each run (cold), with the loop's longest hold meanwhile.
      const reader = new JournalReader(journal)
      const held = monitorEventLoopDelay({ resolution: 5 })
      held.enable()
      at = performance.now()
      const answered = await reader.partition(checkout, thread)
      offLoop.push(performance.now() - at)
      held.disable()
      offLoopHeld.push(held.max / 1e6)
      reader.close()
      if (answered.files.length !== taken) throw new Error(`the worker's partition has ${answered.files.length} files, this thread's ${taken}`)
    }
    console.log(JSON.stringify({ checkout, changedFiles: files, thread: thread.slice(0, 8), threadFiles: taken, partitionOnLoopMs: stats(partitions), partitionOnWorkerMs: stats(offLoop), loopHeldDuringWorkerMs: stats(offLoopHeld), fingerprintMs: stats(fingerprints) }))
  }
}
store.close()
