import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { declareStoreFormat, inspectStoreFormat, readStoreFormat, storeAccess } from "@mako/sessions/store-format"
import { SessionMemory } from "@mako/host/threads/session-memory"
import { ThreadStore } from "@mako/host/threads/store"
import { storeFormats } from "@mako/host/threads/store-formats"

/**
 * What the shared-store format check costs on open, in a scratch root:
 * the check alone (`readStoreFormat` and `storeAccess` on an open
 * connection, and `inspectStoreFormat`'s read-only open beside a host's),
 * against opening the Thread store and the session ledger whole, and the
 * Diagnostics report of every store. Medians of many runs.
 *
 *   npm run bench:store-formats [-- --runs 400]
 */

const runs = Number(process.argv[process.argv.indexOf("--runs") + 1]) || 400
const root = mkdtempSync(join(tmpdir(), "mako-bench-store-formats-"))

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function time(work: () => void): number {
  const samples: number[] = []
  for (let run = 0; run < runs; run++) {
    const start = performance.now()
    work()
    samples.push(performance.now() - start)
  }
  return median(samples)
}

try {
  const threadsPath = join(root, "threads.sqlite")
  const ledgerPath = join(root, "session-memory.sqlite")
  const host = { pid: process.pid, startedAt: 1, label: "bench" }
  new ThreadStore(threadsPath, { realPath: (path) => path }).close()
  new SessionMemory(ledgerPath, host).close()
  const open = new DatabaseSync(threadsPath)
  const rows: [string, number][] = [
    ["check on an open connection (readStoreFormat + storeAccess)", time(() => void storeAccess(readStoreFormat(open, "store_meta"), 1))],
    ["declareStoreFormat on an open connection", time(() => declareStoreFormat(open, 1))],
    ["inspectStoreFormat: a read-only open of the file (the ledger's first look)", time(() => void inspectStoreFormat(ledgerPath, "store_meta"))],
    ["Thread store open, whole", time(() => new ThreadStore(threadsPath, { realPath: (path) => path }).close())],
    ["session ledger open, whole", time(() => new SessionMemory(ledgerPath, host).close())],
  ]
  open.close()
  const threads = new ThreadStore(threadsPath, { realPath: (path) => path })
  const memory = new SessionMemory(ledgerPath, host)
  const mako = join(root, "home", ".mako")
  rows.push(["Diagnostics report of every shared store", time(() => void storeFormats({ threads, threadsPath, memory, memoryPath: ledgerPath, records: join(mako, "records"), views: join(mako, "views"), archive: join(mako, "archive") }))])
  rows.push(["Thread store standing (in memory, the follower's tick)", time(() => void threads.standing())])
  rows.push(["session ledger standing (one PRAGMA data_version)", time(() => void memory.standing())])
  threads.close()
  memory.close()
  for (const [what, ms] of rows) console.log(`${(ms * 1000).toFixed(1).padStart(9)} µs  ${what}`)
  console.log(`median of ${runs} runs each`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
