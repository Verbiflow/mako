import { Worker } from "node:worker_threads"
import { availableParallelism } from "node:os"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"
import { hostWarn } from "../base/host-log.js"
import type { JournalRows } from "./live-journal.js"

/** At most this many readers at once, fewer on a machine with fewer cores: T3 Code reads on four beside its writer. */
const READERS = Math.max(1, Math.min(4, availableParallelism() - 1))
/** A reader with nothing to read for this long ends; the next read starts one. */
const READER_IDLE_MS = 60_000
/** A read that takes longer than this is given up on, and its journal read on the loop instead. */
const READ_TIMEOUT_MS = 120_000

const ReplySchema = z.object({ id: z.number(), rows: z.unknown().optional(), error: z.string().optional() })
const PartSchema = z.object({ id: z.number(), part: z.enum(["base", "blocks"]), entries: z.array(z.unknown()) })

interface Reader {
  worker: Worker
  busy: number
  idle?: ReturnType<typeof setTimeout>
  closing?: Promise<number>
}

interface Asked {
  resolve: (rows: JournalRows | null) => void
  reject: (error: Error) => void
  reader: Reader
  timer: ReturnType<typeof setTimeout>
  /** What came before the rows, a part at a time: its history's entries and its blocks. */
  base: unknown[][]
  blocks: unknown[][]
}

/**
 * Reads journals off the host's loop: each read goes to the least busy of a few worker threads, which opens the file
 * read-only, reads and parses its rows (`journalRowSteps`) and hands them back; the journal that owns the file makes
 * its snapshot of them (`LiveJournal.readSliced`). Read on the loop, a slice at a time, a day's journals held it
 * 11.6 s across the host's own profiles. A reader that fails or ends fails only the reads it had, which the journal
 * then reads itself.
 */
export class JournalReaders {
  private readonly readers: Reader[] = []
  private readonly asked = new Map<number, Asked>()
  private next = 0
  private stopped = false
  private closing?: Promise<void>
  private readonly retiring = new Set<Promise<number>>()

  private readonly entry: URL

  constructor(entry = new URL("./journal-reader-worker.js", import.meta.url)) {
    this.entry = entry
  }

  /** `path`'s rows; null for a journal with nothing kept yet. */
  read(path: string, withLog: boolean): Promise<JournalRows | null> {
    if (this.stopped) return Promise.reject(new Error("The journal readers are stopped."))
    const reader = this.reader()
    const id = (this.next += 1)
    reader.busy += 1
    if (reader.idle) clearTimeout(reader.idle)
    reader.idle = undefined
    return new Promise<JournalRows | null>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id, { error: "it took too long" }), READ_TIMEOUT_MS)
      timer.unref?.()
      this.asked.set(id, { resolve, reject, reader, timer, base: [], blocks: [] })
      reader.worker.postMessage({ id, path, withLog })
    })
  }

  /** Ends every reader; reads under way fail, and their journals are read on the loop. */
  stop(): Promise<void> {
    if (this.closing) return this.closing
    this.stopped = true
    for (const id of [...this.asked.keys()]) this.settle(id, { error: "the host is stopping" })
    for (const reader of [...this.readers]) this.retire(reader)
    return this.closing = Promise.allSettled([...this.retiring]).then(results => {
      const failed = results.flatMap(result => result.status === "rejected" ? [result.reason] : [])
      if (failed.length) throw new AggregateError(failed, "Journal readers could not be released")
    })
  }

  private retire(reader: Reader): Promise<number> {
    if (reader.closing) return reader.closing
    clearTimeout(reader.idle)
    const at = this.readers.indexOf(reader)
    if (at >= 0) this.readers.splice(at, 1)
    const closing = reader.closing = reader.worker.terminate()
    this.retiring.add(closing)
    // An unknown failed termination stays owned for stop() to report; a completed one holds nothing.
    void closing.then(() => this.retiring.delete(closing), () => {})
    return closing
  }

  private reader(): Reader {
    const free = this.readers.reduce<Reader | undefined>((least, reader) => (!least || reader.busy < least.busy ? reader : least), undefined)
    if (free && (free.busy === 0 || this.readers.length >= READERS)) return free
    const worker = new Worker(this.entry, { resourceLimits: { maxOldGenerationSizeMb: 1024 } })
    worker.unref()
    const reader: Reader = { worker, busy: 0 }
    worker.on("message", (message) => {
      const part = PartSchema.safeParse(message)
      if (part.success) {
        this.asked.get(part.data.id)?.[part.data.part].push(part.data.entries)
        return
      }
      const reply = ReplySchema.safeParse(message)
      if (!reply.success) return
      // SAFETY: the reader posts what `journalRowSteps` returned, parsed by the same schemas the journal reads with.
      this.settle(reply.data.id, reply.data.error === undefined ? { rows: reply.data.rows as JournalRows | null } : { error: reply.data.error })
    })
    const gone = (why: string) => {
      const at = this.readers.indexOf(reader)
      if (at >= 0) this.readers.splice(at, 1)
      for (const [id, asked] of this.asked) if (asked.reader === reader) this.settle(id, { error: why })
    }
    worker.on("error", (error) => {
      hostWarn("journal", "a journal reader failed", { error: errorMessage({ error }) })
      gone(errorMessage({ error }))
      this.retire(reader)
    })
    worker.on("exit", (code) => gone(`it exited with ${code}`))
    this.readers.push(reader)
    return reader
  }

  private settle(id: number, outcome: { rows: JournalRows | null } | { error: string }): void {
    const asked = this.asked.get(id)
    if (!asked) return
    this.asked.delete(id)
    clearTimeout(asked.timer)
    const { reader } = asked
    reader.busy = Math.max(0, reader.busy - 1)
    if (!reader.busy && !this.stopped && this.readers.includes(reader)) {
      reader.idle = setTimeout(() => {
        const at = this.readers.indexOf(reader)
        if (reader.busy || at < 0) return
        this.retire(reader)
      }, READER_IDLE_MS)
      reader.idle.unref?.()
    }
    if ("error" in outcome) return asked.reject(new Error(`A journal reader couldn't read it: ${outcome.error}`))
    const { rows } = outcome
    if (rows) {
      // SAFETY: each part is a slice of the `Entry[]` the reader parsed, in order.
      rows.blocks = asked.blocks.flat() as JournalRows["blocks"]
      if (rows.base?.kind === "rows") {
        // SAFETY: as the blocks: the history's entries, a slice at a time, in order.
        const entries = asked.base.flat() as JournalRows["blocks"]
        rows.base = { ...rows.base, entries }
      }
    }
    asked.resolve(rows)
  }
}
