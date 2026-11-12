import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { decompress } from "./content.js"
import { JournalReadSchema } from "./journal-reader.js"
import { JournalStore } from "./journal-store.js"
import { partition, storedView } from "./queries.js"

/*
 * Reads of the record of changes too big for the host's thread, on a connection of their own (`JournalReader`).
 * Read-only: in WAL a reader never stops the owner's writes, nor they it, and it sees what was committed.
 */
const { path } = z.object({ path: z.string() }).parse(workerData)
const BlobRow = z.object({ data: z.instanceof(Uint8Array) })

let db: DatabaseSync | undefined
let store: JournalStore | undefined
const open = () => {
  if (db?.isOpen) return db
  db = new DatabaseSync(path, { readOnly: true })
  db.exec("PRAGMA busy_timeout=2000")
  return db
}

parentPort?.on("message", (message) => {
  const request = JournalReadSchema.safeParse(message)
  if (!request.success) return
  const { id } = request.data
  try {
    if (request.data.kind === "partition") {
      // A view of what's committed now: the files' states and their writers, read on this thread.
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      parentPort?.postMessage({ id, ok: true, partition: partition(storedView(store), request.data.checkout, request.data.thread) })
      return
    }
    if (request.data.kind === "activity-overlapping") {
      const rows = open().prepare("SELECT * FROM activity WHERE started_at <= ? AND (ended_at IS NULL OR ended_at >= ?)").all(request.data.to, request.data.from)
      parentPort?.postMessage({ id, ok: true, rows })
      return
    }
    // Each stored content, as `JournalStore.blob` reads it; one the journal no longer holds is left out.
    const read = open().prepare("SELECT data FROM blobs WHERE ref=?")
    const blobs: { ref: string; bytes: Uint8Array }[] = []
    for (const ref of new Set(request.data.refs)) {
      const row = read.get(ref)
      if (row) blobs.push({ ref, bytes: decompress(BlobRow.parse(row).data) })
    }
    parentPort?.postMessage({ id, ok: true, blobs })
  } catch (error) {
    parentPort?.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
})
