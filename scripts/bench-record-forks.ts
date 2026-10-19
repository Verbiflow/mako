import { appendFile, mkdir, open, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { recordChunks } from "../packages/sessions/src/record-files.ts"
import { RecordStore, type RestoreReport } from "../packages/sessions/src/record-store.ts"
import { storeReader } from "./decode-compare.ts"

/**
 * What a restore that forks costs on a large session: time and peak memory
 * of the restore that writes the fork, and of the second one that finds it.
 * The session is captured read-only from this machine's own store into a
 * scratch record store; the destination is a scratch home whose copy went on
 * without Mako, and is removed afterwards.
 *
 *   tsx --tsconfig tsconfig.app.json scripts/bench-record-forks.ts codex <rollout> [prefix MiB]
 *   tsx --tsconfig tsconfig.app.json scripts/bench-record-forks.ts cursor <agent store.db>
 *
 * Codex: the destination holds the rollout's first `prefix` MiB (64 by
 * default) and a line of its own, so the fork shares that much and is the
 * whole arriving rollout. Cursor: the destination holds the whole session,
 * restored, with the agent's index row changed there.
 */

const [harness = "", path = "", prefixArgument] = process.argv.slice(2)
if (!["codex", "cursor"].includes(harness) || !path) throw new Error("Usage: bench-record-forks.ts codex <rollout> [prefix MiB] | cursor <agent store.db>")
const data = process.env["MAKO_THREAD_DATA_DIR"] ?? "/tmp"
const root = join(data, "bench-record-forks")
const home = homedir()
const destination = join(root, "destination")
await rm(destination, { recursive: true, force: true })
const nativeStores = new NativeStores(false)
const store = new RecordStore(join(root, "store"), nativeStores)

async function measured<T>(label: string, work: () => Promise<T>): Promise<T> {
  let peak = process.memoryUsage().rss
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss)
  }, 20)
  const started = performance.now()
  try {
    return await work()
  } finally {
    clearInterval(sampler)
    peak = Math.max(peak, process.memoryUsage().rss)
    console.log(`${label}: ${((performance.now() - started) / 1000).toFixed(2)} s, peak RSS ${(peak / 1024 / 1024).toFixed(0)} MiB`)
  }
}

const summary = (report: RestoreReport) => ({
  diverged: report.diverged.length,
  kept: report.kept.length,
  session: { files: report.actions.filter((action) => action.action !== "skip").length, rows: report.rows.reduce((total, rows) => total + rows.insert + rows.replace + rows.delete, 0) },
  fork: report.fork && {
    nativeId: report.fork.nativeId,
    shared: report.fork.from.filter((unit) => unit.shared > 0).map((unit) => `${unit.unit.split("/").at(-1)}: ${unit.shared} bytes`),
    files: report.fork.actions.filter((action) => action.action !== "skip").map((action) => `${action.path.split("/").at(-1)}: ${(action.bytes / 1024 / 1024).toFixed(1)} MiB`),
    rows: report.fork.rows.map((rows) => `${rows.table} +${rows.insert} (${rows.skip} there)`),
    diverged: report.fork.diverged.length,
    written: report.fork.written,
  },
})

try {
  const reader = storeReader(harness, home)
  const info = await stat(path)
  const ref = await reader.peek({ path, bytes: info.size, mtimeMs: info.mtimeMs })
  if (!ref?.nativeId) throw new Error(`${harness} names no session at ${path}`)
  const records = await reader.records(path)
  if (!records) throw new Error(`${harness} keeps no records at ${path}`)
  const capture = await measured("capture (read-only, from this machine)", () => store.capture({ harness, nativeId: ref.nativeId, home, records }))
  console.log(`  ${capture.versions.length} versions, ${(capture.newBytes / 1024 / 1024).toFixed(0)} MiB new`)

  let local: string
  if (harness === "codex") {
    // The destination's copy: the rollout's first lines, then one of its own.
    local = join(destination, relative(home, path)).replace(/\.zst$/, "")
    await mkdir(dirname(local), { recursive: true })
    const want = Number(prefixArgument ?? 64) * 1024 * 1024
    const handle = await open(local, "w")
    let written = 0
    try {
      for await (const { bytes } of recordChunks(path, 0, Number.MAX_SAFE_INTEGER)) {
        const room = want - written
        if (room <= 0) break
        const piece = bytes.subarray(0, Math.min(bytes.length, room))
        const cut = piece.length < bytes.length ? piece.lastIndexOf(0x0a) + 1 : piece.length
        await handle.write(piece.subarray(0, cut))
        written += cut
        if (cut < piece.length) break
      }
    } finally {
      await handle.close()
    }
    await appendFile(local, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "went_on_here" } })}\n`)
    console.log(`destination: the first ${(written / 1024 / 1024).toFixed(0)} MiB of the rollout and a line of its own`)
  } else {
    await measured("plain restore into the destination", () => store.restore({ harness, nativeId: ref.nativeId, home: destination }))
    local = join(destination, relative(home, path))
    const index = join(destination, relative(home, records.databases.find((database) => database.path.endsWith("index.db"))!.path))
    const db = new DatabaseSync(index)
    try {
      db.prepare("UPDATE agents SET name = 'went on here' WHERE agent_id = ?").run(ref.nativeId)
    } finally {
      db.close()
    }
    console.log("destination: the whole session, its index row changed there")
  }
  const localRecords = await storeReader(harness, destination).records(local)
  const forked = await measured("restore that forks", () => store.restore({ harness, nativeId: ref.nativeId, home: destination, destination: localRecords ?? undefined, fork: reader.fork }))
  console.log(JSON.stringify(summary(forked), null, 2))
  const again = await measured("second restore, finding the fork", () => store.restore({ harness, nativeId: ref.nativeId, home: destination, destination: localRecords ?? undefined, fork: reader.fork }))
  console.log(JSON.stringify(summary(again)))
} finally {
  await store.close()
  await rm(destination, { recursive: true, force: true })
}
