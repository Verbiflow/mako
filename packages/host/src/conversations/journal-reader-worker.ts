import { DatabaseSync } from "node:sqlite"
import { parentPort } from "node:worker_threads"
import { z } from "zod"
import { atOnce } from "@mako/sessions/slices"
import { errorMessage } from "../base/error-message.js"
import { buildTurnIndex, coldScan, journalRowSteps, readTurnIndex } from "./live-journal.js"

/**
 * A reader of journals (`JournalReaders`): each asked file is opened to query only, its rows read and parsed in one read
 * transaction, and handed back. It writes nothing; the host that owns a journal is its one writer.
 */
/** About a megabyte of a long session's entries: a part the host takes in within a few milliseconds. */
const ENTRIES_PER_PART = 150
const AskSchema = z.object({ id: z.number(), path: z.string(), withLog: z.boolean(), scan: z.literal(true).optional() })

parentPort?.on("message", (message) => {
  const ask = AskSchema.parse(message)
  let db: DatabaseSync | undefined
  try {
    // Not opened read-only: a journal its last host was killed writing has a WAL only a connection that may write can
    // recover, and a read-only one could read the file without its last commits. `query_only` keeps this one from
    // writing anything of its own.
    db = new DatabaseSync(ask.path)
    db.exec("PRAGMA busy_timeout=5000; PRAGMA query_only=ON")
    db.exec("BEGIN")
    // A cold journal's opening asks only what it reads of every block (`ColdScan`): none of its content comes back.
    if (ask.scan) {
      // From the journal's turn index where that holds every block; walked otherwise, and the index built from the
      // walk, so the journal's next cold open reads it.
      const indexed = readTurnIndex(db)
      const scan = indexed ?? coldScan(db)
      db.exec("COMMIT")
      if (!indexed) {
        try {
          db.exec("PRAGMA query_only=OFF")
          buildTurnIndex(db, scan)
        } catch { /* walked again at its next cold open */ }
      }
      // Closed before the answer goes: the opening that waits on it reads the file at once, and a connection still
      // closing here (the last one checkpoints and removes the log) would have it find the file locked.
      db.close()
      db = undefined
      parentPort?.postMessage({ id: ask.id, scan })
      return
    }
    const rows = atOnce(journalRowSteps(db, ask.withLog))
    db.exec("COMMIT")
    // Handed over a part at a time: the host takes each in on a turn of its own, so no one message holds its loop
    // for the whole journal's worth of entries.
    if (rows?.base?.kind === "rows") {
      const { entries } = rows.base
      for (let at = 0; at < entries.length; at += ENTRIES_PER_PART) parentPort?.postMessage({ id: ask.id, part: "base", entries: entries.slice(at, at + ENTRIES_PER_PART) })
      rows.base = { ...rows.base, entries: [] }
    }
    if (rows) {
      const { blocks } = rows
      for (let at = 0; at < blocks.length; at += ENTRIES_PER_PART) parentPort?.postMessage({ id: ask.id, part: "blocks", entries: blocks.slice(at, at + ENTRIES_PER_PART) })
      rows.blocks = []
    }
    parentPort?.postMessage({ id: ask.id, rows })
  } catch (error) {
    parentPort?.postMessage({ id: ask.id, error: errorMessage({ error }) })
  } finally {
    db?.close()
  }
})
