import { homedir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { decompress } from "./content.js"
import { GitAnswerSchema, JournalReadSchema } from "./journal-reader.js"
import { CheckpointFingerprints } from "./checkpoint-fingerprints.js"
import { ACTIVITY_OVERLAPPING, JournalStore } from "./journal-store.js"
import { changeUsage, countTurnInSlices, partition, shares, storedView, threadSummary, type JournalView } from "./queries.js"
import { ThreadFiles, type ReferenceGit } from "./thread-files.js"
import { turnOnlyPair, turnWriters, undoPlan } from "./turn-lines.js"

/*
 * Reads of the record of changes too big for the host's thread, on a connection of their own (`JournalReader`).
 * Read-only: in WAL a reader never stops the owner's writes, nor they it, and it sees what was committed.
 */
const { path } = z.object({ path: z.string() }).parse(workerData)
const BlobRow = z.object({ data: z.instanceof(Uint8Array) })

let db: DatabaseSync | undefined
let store: JournalStore | undefined
let countView: ReturnType<typeof storedView> | undefined
let countVersion = -1
let fingerprints: CheckpointFingerprints | undefined
// What resolving file names keeps between questions: each Thread's work, its places' indexes and their renames.
let files: ThreadFiles | undefined
let gitAsked = 0
const gitAsks = new Map<number, { settle(stdout: Buffer): void; fail(error: Error): void }>()
/**
 * How long an answer from the host's Git is waited for, past the command's own limit when it has one. A read here is
 * retired with its worker at 30 s, every read waiting on it failing with it, and the host's Git is a queue that a busy
 * day fills: a name is resolved without Git's word, as when Git fails, long before that.
 */
const GIT_ANSWER_MS = 8_000
/** The host's Git, asked over the port: its helper, queue and log are the host's, and this thread starts no process. */
const git: ReferenceGit = {
  run: ({ cwd, args, timeoutMs }) => new Promise((settle, fail) => {
    const asked = ++gitAsked
    const late = setTimeout(() => {
      gitAsks.delete(asked)
      fail(new Error("The host's Git took too long to answer the journal's reader."))
    }, (timeoutMs ?? 0) + GIT_ANSWER_MS)
    gitAsks.set(asked, {
      settle: (stdout) => { clearTimeout(late); settle({ stdout }) },
      fail: (error) => { clearTimeout(late); fail(error) },
    })
    parentPort?.postMessage({ git: asked, cwd, args: [...args], ...(timeoutMs !== undefined && { timeoutMs }) })
  }),
}
const open = () => {
  if (db?.isOpen) return db
  db = new DatabaseSync(path, { readOnly: true })
  db.exec("PRAGMA busy_timeout=2000")
  return db
}

/** The journal as committed now: a view and its author cache last until another connection commits, as the host's did. */
const viewNow = (): JournalView => {
  store ??= JournalStore.open(path, { device: "", readOnly: true })
  const version = store.dataVersion()
  if (!countView || countVersion !== version) {
    countView = storedView(store)
    countVersion = version
  }
  return countView
}

parentPort?.on("message", async (message) => {
  const request = JournalReadSchema.safeParse(message)
  if (!request.success) {
    const answer = GitAnswerSchema.safeParse(message)
    const asked = answer.success ? gitAsks.get(answer.data.git) : undefined
    if (!answer.success || !asked) return
    gitAsks.delete(answer.data.git)
    if (answer.data.ok) asked.settle(Buffer.from(answer.data.stdout.buffer, answer.data.stdout.byteOffset, answer.data.stdout.byteLength))
    else asked.fail(new Error(answer.data.error))
    return
  }
  const { id } = request.data
  try {
    if (request.data.kind === "thread-changes") {
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      parentPort?.postMessage({ id, ok: true, answered: "thread-changes", value: threadSummary(store, request.data.thread) })
      return
    }
    if (request.data.kind === "resolve-files") {
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      files ??= new ThreadFiles({ git, home: homedir() })
      parentPort?.postMessage({ id, ok: true, answered: "resolve-files", value: await files.resolve(store, request.data.source, request.data.spellings) })
      return
    }
    if (request.data.kind === "moved-paths") {
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      files ??= new ThreadFiles({ git, home: homedir() })
      const { thread, from, to } = request.data
      parentPort?.postMessage({ id, ok: true, answered: "moved-paths", value: (await files.movedPaths(store, thread, from, to)) ?? null })
      return
    }
    if (request.data.kind === "count-turn") {
      const count = await countTurnInSlices(viewNow(), request.data.thread, request.data.turn, request.data.state)
      parentPort?.postMessage({ id, ok: true, count: count ?? null })
      return
    }
    if (request.data.kind === "turn-writers") {
      const { thread, turn, file, shown } = request.data
      parentPort?.postMessage({ id, ok: true, answered: "turn-writers", value: turnWriters(viewNow(), thread, turn, file, shown) ?? null })
      return
    }
    if (request.data.kind === "turn-only") {
      const { thread, turn, file } = request.data
      parentPort?.postMessage({ id, ok: true, answered: "turn-only", value: turnOnlyPair(viewNow(), thread, turn, file) ?? null })
      return
    }
    if (request.data.kind === "undo-plan") {
      parentPort?.postMessage({ id, ok: true, answered: "undo-plan", value: undoPlan(viewNow(), request.data.thread, request.data.scope, request.data.checkout) })
      return
    }
    if (request.data.kind === "change-usage") {
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      parentPort?.postMessage({ id, ok: true, answered: "change-usage", value: changeUsage(store, request.data.since) })
      return
    }
    if (request.data.kind === "shares") {
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      parentPort?.postMessage({ id, ok: true, answered: "shares", value: shares(storedView(store), request.data.checkout, request.data.thread) })
      return
    }
    if (request.data.kind === "checkpoint-fingerprint") {
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      fingerprints ??= new CheckpointFingerprints(store)
      parentPort?.postMessage({ id, ok: true, fingerprint: fingerprints.read(request.data.checkout, request.data.thread) })
      return
    }
    if (request.data.kind === "partition") {
      // A view of what's committed now: the files' states and their writers, read on this thread.
      store ??= JournalStore.open(path, { device: "", readOnly: true })
      parentPort?.postMessage({ id, ok: true, partition: partition(storedView(store), request.data.checkout, request.data.thread, { bring: request.data.bring }) })
      return
    }
    if (request.data.kind === "activity-overlapping") {
      const rows = open().prepare(ACTIVITY_OVERLAPPING).all(request.data.from, request.data.to, request.data.to)
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
