import { z } from "zod"
import { parentPort, workerData } from "node:worker_threads"
import { readFile, writeFile, rename, rm } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import { emptyBroker } from "@mako/protocol/borrow"
import { BorrowingStore } from "./borrowing-store.js"
import type { BorrowingState } from "./borrowing-state.js"

// SAFETY: constructed only by LocalBorrowing under the folder's kernel lock. No user values are posted back.
const { folder, account } = workerData as { folder: string; account: string }
const LegacyEnvelope = z.object({ state: z.object({ account: z.string() }).loose() }).loose()
let store: BorrowingStore | undefined
const temporary = join(folder, `.state.${process.pid}.${randomUUID()}.tmp`)
try {
  const text = await readFile(join(folder, "state.json"), "utf8").catch(error => { if (error.code === "ENOENT") return undefined; throw error })
  const value = text ? JSON.parse(text) : { state: emptyBroker(account), waiting: [], unanswered: [] }
  LegacyEnvelope.parse(value)
  // SAFETY: the old broker wrote this private snapshot from step() under this same lock. The envelope above also refuses format fences.
  const saved = value as BorrowingState
  const kept = { state: saved.state, waiting: saved.waiting ?? [], unanswered: saved.unanswered ?? [] }
  store = new BorrowingStore(join(folder, "state.sqlite"), saved.state.account)
  if (!store.canImport()) throw new Error("A legacy snapshot replaced the borrowing format marker; refusing to overwrite newer decisions")
  await store.write(kept, true)
  store.close(); store = undefined
  // Publication is last. Before this rename, legacy JSON remains authoritative and a crash retries the import.
  // Old binaries dereference state.account before every operation, under the same lock. null fences them closed,
  // including one already running: they cannot recreate grants or overwrite a newer decision with the old snapshot.
  await writeFile(temporary, JSON.stringify({ version: 2, reads: 2, state: null }), { mode: 0o600 })
  await rename(temporary, join(folder, "state.json"))
  parentPort?.postMessage({ ok: true })
} catch (error) {
  parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) })
} finally {
  store?.close()
  await rm(temporary, { force: true })
  parentPort?.close()
}
