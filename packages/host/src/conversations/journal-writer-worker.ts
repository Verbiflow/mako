import { DatabaseSync, type StatementSync } from "node:sqlite"
import { parentPort } from "node:worker_threads"
import { z } from "zod"
import { errorMessage } from "../base/error-message.js"

/**
 * The writer of running turns' streamed rows (`JournalWriter`): each journal it is given has a connection here, and
 * each message is one transaction on it, in the order the host sent them. It writes only what a flush of a running
 * turn appends (a block whole, a block's growth, the revision); everything else of a journal is still its host's own
 * connection's to write, which waits for this one to be idle first.
 *
 * A journal's cell says how far it got: `[0]` the last message done, `[1]` the last that failed. The host reads it
 * without waiting for a message, and waits on it when it must have everything written before it goes on.
 */
const OpSchema = z.union([
  z.tuple([z.literal("block"), z.number().int().nonnegative(), z.string(), z.tuple([z.string(), z.number(), z.string().nullable(), z.string().nullable()]).nullable()]),
  z.tuple([z.literal("append"), z.number().int().nonnegative(), z.number().int().nonnegative(), z.string()]),
])
const AskSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("open"), key: z.number(), path: z.string(), cell: z.instanceof(SharedArrayBuffer), keptBytes: z.number() }),
  z.object({ kind: z.literal("write"), key: z.number(), seq: z.number(), revision: z.number(), ops: z.array(OpSchema), indexed: z.boolean() }),
  z.object({ kind: z.literal("close"), key: z.number(), seq: z.number() }),
])

interface Connection {
  db: DatabaseSync
  progress: StatementSync
  block: StatementSync
  clear: StatementSync
  append: StatementSync
  /** The turn index's line of a block, written or dropped with the block, and the revision the index is whole through. */
  turn: StatementSync
  noTurn: StatementSync
  through: StatementSync
}

interface Journal {
  cell: Int32Array
  /** None for a journal that couldn't be opened here: each write of it is answered as failed. */
  connection: Connection | undefined
  /** After a write failed nothing more is written: the host writes what its rows should hold itself. */
  failed: boolean
}

const journals = new Map<number, Journal>()

parentPort?.on("message", (message) => {
  const ask = AskSchema.parse(message)
  if (ask.kind === "open") {
    const cell = new Int32Array(ask.cell)
    try {
      const db = new DatabaseSync(ask.path)
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA journal_size_limit=${ask.keptBytes}`)
      journals.set(ask.key, {
        cell, failed: false,
        connection: {
          db,
          progress: db.prepare("INSERT OR REPLACE INTO progress VALUES (1, ?)"),
          block: db.prepare("INSERT OR REPLACE INTO blocks VALUES (?, ?)"),
          clear: db.prepare("DELETE FROM block_appends WHERE block_id=?"),
          append: db.prepare("INSERT INTO block_appends VALUES (?, ?, ?)"),
          turn: db.prepare("INSERT OR REPLACE INTO turn_index VALUES (?, ?, ?, ?, ?)"),
          noTurn: db.prepare("DELETE FROM turn_index WHERE id=?"),
          through: db.prepare("INSERT OR REPLACE INTO progress VALUES (2, ?)"),
        },
      })
    } catch (error) {
      // No connection: every write of it fails, which its host reads from the cell.
      journals.set(ask.key, { cell, failed: true, connection: undefined })
      parentPort?.postMessage({ key: ask.key, seq: 0, error: errorMessage({ error }) })
    }
    return
  }
  const journal = journals.get(ask.key)
  if (ask.kind === "close") {
    journals.delete(ask.key)
    try { journal?.connection?.db.close() } catch { /* its host closes its own connection next, and reads the file as it is */ }
    if (journal) done(journal.cell, ask.seq, false)
    parentPort?.postMessage({ key: ask.key, seq: ask.seq })
    return
  }
  let failure: string | undefined
  const connection = journal?.failed ? undefined : journal?.connection
  if (!journal || !connection) failure = "the journal's writer has no connection to it"
  else {
    const { db } = connection
    try {
      db.exec("BEGIN IMMEDIATE")
      connection.progress.run(ask.revision)
      if (ask.indexed) connection.through.run(ask.revision)
      for (const op of ask.ops) {
        if (op[0] === "block") {
          connection.block.run(op[1], op[2])
          connection.clear.run(op[1])
          if (op[3]) connection.turn.run(op[1], ...op[3])
          else connection.noTurn.run(op[1])
        } else connection.append.run(op[1], op[2], op[3])
      }
      db.exec("COMMIT")
    } catch (error) {
      failure = errorMessage({ error })
      journal.failed = true
      try { if (db.isTransaction) db.exec("ROLLBACK") } catch { /* SQLite rolled it back itself */ }
    }
  }
  if (journal) done(journal.cell, ask.seq, failure !== undefined)
  parentPort?.postMessage({ key: ask.key, seq: ask.seq, ...(failure !== undefined && { error: failure }) })
})

function done(cell: Int32Array, seq: number, failed: boolean): void {
  if (failed) Atomics.store(cell, 1, seq)
  Atomics.store(cell, 0, seq)
  Atomics.notify(cell, 0)
}
