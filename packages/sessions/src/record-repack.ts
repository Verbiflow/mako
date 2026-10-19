import { randomUUID } from "node:crypto"
import { existsSync, readdirSync, statSync } from "node:fs"
import { open, rename, rm, type FileHandle } from "node:fs/promises"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { deadEntry, ENTRY_HEADER_BYTES, HASH_BYTES, PACK_LIMIT, packEntry, packName, type ChunkCodec, type Packs } from "./record-chunks.js"
import { droppable, OWNERS, ownerLockPath } from "./record-intents.js"
import { probeLock, takeLock } from "./record-locks.js"
import { DROPPED_VERDICTS, GRACE_MS, hasTable, intentStandings, judgeUnnamed, listUnnamed, newestTail, SWEEP_MS, SWEPT, TRIM_RECORD, trimBlocker, type OrphanVerdict, type TrimRecord } from "./record-orphans.js"
import { onMac } from "./platform.js"
import { declareStoreFormat } from "./store-format.js"

/**
 * The record store's packs, compacted and laid out by session.
 *
 * Capture appends every new chunk to the newest pack, so a session written
 * a turn at a time over a day is spread among everything else written that
 * day, and a session the person deleted (`RecordStore.forget`) leaves its
 * chunks behind, named by nothing. A repack:
 *
 * 1. **Drops** chunks no version names (`record-orphans.ts`): those only
 *    sessions the person deleted named (`forget` left them in `orphans`),
 *    those a capture stored and never named because it failed or its
 *    process died (`record-intents.ts`), and, at most daily, any other
 *    chunk found unnamed and left so for an hour. Never one a capture in
 *    progress may still name, in this process or another. Versions are
 *    read without the lock; a capture naming a chunk meanwhile claims it in
 *    its own transaction, and the write lock is held only to judge and drop
 *    the rest. `forget`, the drop and a sweep that finds a new unnamed chunk
 *    each raise a generation: a capture that found a chunk held in an
 *    earlier slice and hasn't named it yet starts over
 *    (`RecordStore.slice`), and stores it again.
 * 2. **Groups** each quiet session (no version for `quietMs`) whose chunks
 *    are scattered: its chunks, unit by unit in the order capture first took
 *    them and each unit's versions in turn, are copied together, several
 *    sessions to a pack. A session already laid out in long runs, as a
 *    backfill writes one, is only marked.
 *    Then it **scrubs** each dropped chunk's entry where it lies: a dead
 *    header and zeros, so what the person deleted leaves the disk, not
 *    only the index, for the cost of what was deleted (`scrub_entries`
 *    keeps the list across a crash).
 * 3. **Compacts** each pack below the newest whose live chunks take less
 *    than `liveRatio` of it, copying them into a new pack.
 * 4. **Removes** each pack below the newest that no chunk names any more.
 * 5. **Trims** the newest pack's tail past its last indexed entry, once no
 *    capture anywhere may be writing (`trimNewest`).
 *
 * Crash-safe at every step: copies go to `repack-*.tmp` files no reader
 * opens; switching the index is one transaction under the store's turn and
 * write lock, which renames each copy to the next pack number and moves the
 * chunks it holds only from the place it copied them from; a pack is removed
 * only once the index names nothing in it. A crash before the switch leaves
 * temporary files, removed by the next repack; after it, packs nothing
 * names, removed the same way. The newest pack is never removed, so a pack
 * number is never used twice.
 *
 * Bounded memory: chunk lists and moves are listed into temporary tables on
 * the repack's own connection and read back in pages, and one chunk is in
 * memory at a time. It takes the store's turn only to switch, so captures
 * run while it reads and copies.
 */

/** The `meta` key a repack raises when it drops chunks. */
export const DROPPED = "dropped"
const QUIET_MS = 60 * 60_000
const LIVE_RATIO = 0.5
/**
 * A session read in runs of this many chunks or more on average (about a
 * mebibyte) is laid out already, as is one in a few runs: chunks it shares
 * with other sessions lie with whichever was laid out first.
 */
const RUN_CHUNKS = 64
const FEW_RUNS = 4
/** The mark (`marks`) that says a session was laid out at this many versions, the newest captured then. */
const GROUPED = "grouped"
const TEMPORARY = /^repack-.*\.tmp$/
const PAGE = 1024
/** A batch switches once it has copied this much: the turn it takes moves a bounded number of chunks. */
const BATCH_BYTES = 256 * 1024 * 1024
/** Chunks moved in one turn of the switch. */
const SWITCH_ROWS = 2048

export type RepackStep = "dropped" | "copied" | "placed" | "switched" | "trimming"

export interface RepackOptions {
  /** A session is grouped once no version of it is newer than this. */
  quietMs?: number
  /** A pack whose live chunks take less than this share of it is rewritten. */
  liveRatio?: number
  /** Called after each step; a test throws from it to stop there as a crash would. */
  step?: (step: RepackStep) => void
  /** Sweep for unnamed chunks now, whenever the last sweep was (`records.ts repack --sweep`); otherwise at most daily (`SWEEP_MS`). */
  sweep?: boolean
  /** How long a chunk a sweep found unnamed stays so before it's dropped (`GRACE_MS`). */
  graceMs?: number
}

/** What the drop found no version naming, and what it did with it. */
export interface OrphanCounts {
  /** Whether it read every version this repack: a sweep, or forgotten or abandoned chunks to find. */
  scanned: boolean
  /** Whether it looked at every chunk (a sweep), not only the candidates. */
  sweep: boolean
  /** Reading the versions into the named set, without the lock. */
  scanMs: number
  /** The store's turn held to judge and drop. */
  turnMs: number
  /** Unnamed chunks found. */
  unnamed: number
  /** Dropped, by why. */
  forgotten: number
  abandoned: number
  /** Unnamed past the grace, nothing claiming them. */
  swept: number
  /** Kept: a capture in progress may still name them. */
  running: number
  /** Kept: unnamed for less than the grace. */
  waiting: number
  /** Intents of captures that failed or whose process died, cleared with their chunks. */
  intentsCleared: number
}

export interface RepackReport {
  /** False when another repack held the lock: this one did nothing. */
  ran: boolean
  /** Chunks dropped, every reason together (`orphans` says which). */
  dropped: number
  droppedBytes: number
  /** Bytes of dropped entries overwritten where they lay. */
  scrubbedBytes: number
  /** Sessions laid out together, and those found laid out already. */
  grouped: number
  alreadyGrouped: number
  /** Chunks copied, and their bytes in the packs. */
  copied: number
  copiedBytes: number
  packsWritten: number
  packsRemoved: number
  /** Leftovers of a repack cut short: temporary copies removed. */
  leftovers: number
  packBytesBefore: number
  packBytesAfter: number
  ms: number
  /** The longest the store's turn was held for one switch. */
  longestTurnMs: number
  orphans: OrphanCounts
  /** The newest pack's tail past its last indexed entry, truncated (`trimNewest`). */
  trim: { pack: number | null; bytes: number; resumed: boolean; skipped: string | null }
}

/** How a session's chunks lie: how many there are, and in how many contiguous runs a read in order takes them. */
interface Layout {
  chunks: number
  runs: number
}

export interface RepackParts {
  folder: string
  packs: Packs
  /** The store's turn: no capture's transaction is open on its connection while it's held. */
  turn: <T>(work: () => Promise<T>) => Promise<T>
  /** The store format this build writes, which its connection declares (`declareStoreFormat`). */
  format: number
}

const PlaceSchema = z.object({ hash: z.instanceof(Uint8Array), pack: z.number(), offset: z.number(), stored: z.number(), size: z.number(), codec: z.union([z.literal(0), z.literal(1)]) })
const ChunksSchema = z.object({ chunks: z.instanceof(Uint8Array) })
const SessionSchema = z.object({ id: z.number(), versions: z.number(), newest: z.number(), grouped: z.string().nullable() })
const PackLiveSchema = z.object({ pack: z.number(), live: z.number() })
const ScrubSchema = z.object({ pack: z.number(), offset: z.number(), stored: z.number() })
const ValueSchema = z.object({ value: z.string() })

export async function repackStore(parts: RepackParts, options: RepackOptions = {}): Promise<RepackReport> {
  const started = Date.now()
  const report: RepackReport = {
    ran: false, dropped: 0, droppedBytes: 0, scrubbedBytes: 0, grouped: 0, alreadyGrouped: 0, copied: 0, copiedBytes: 0,
    packsWritten: 0, packsRemoved: 0, leftovers: 0, packBytesBefore: 0, packBytesAfter: 0, ms: 0, longestTurnMs: 0,
    orphans: { scanned: false, sweep: false, scanMs: 0, turnMs: 0, unnamed: 0, forgotten: 0, abandoned: 0, swept: 0, running: 0, waiting: 0, intentsCleared: 0 },
    trim: { pack: null, bytes: 0, resumed: false, skipped: null },
  }
  const lock = await takeLock(join(parts.folder, "repack.lock"))
  if (!lock) return report
  report.ran = true
  const repack = new Repack(parts, options, report)
  try {
    await repack.run()
  } finally {
    await repack.close()
    await lock.release()
    report.ms = Date.now() - started
  }
  return report
}

class Repack {
  private readonly db: DatabaseSync
  private readonly folder: string
  private readonly sources = new Map<number, FileHandle>()
  /** The batch being copied: its temporary packs, the marks that go with its switch, and its bytes so far. */
  private copies: TemporaryPack[] = []
  private marks: (() => void)[] = []
  private batchBytes = 0

  constructor(private readonly parts: RepackParts, private readonly options: RepackOptions, private readonly report: RepackReport) {
    this.folder = join(parts.folder, "packs")
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
    // Its own connection: its temporary tables and reads never join a capture's transaction on the store's.
    this.db = new DatabaseSync(join(parts.folder, "records.sqlite"), { timeout: 60_000 })
    declareStoreFormat(this.db, parts.format)
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS repack_order (n INTEGER PRIMARY KEY, hash BLOB NOT NULL);
      CREATE TEMP TABLE IF NOT EXISTS repack_seen (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS repack_moves (hash BLOB PRIMARY KEY, file INTEGER NOT NULL, old_pack INTEGER NOT NULL, old_offset INTEGER NOT NULL, offset INTEGER NOT NULL) WITHOUT ROWID;
    `)
  }

  async run(): Promise<void> {
    await this.leftovers()
    this.report.packBytesBefore = this.packBytes()
    // Finding a pack's chunks reads the whole index without it; made once, under the turn, since it writes the schema.
    await this.locked(async () => this.db.exec(`
      CREATE INDEX IF NOT EXISTS chunks_by_pack ON chunks (pack, offset);
      CREATE TABLE IF NOT EXISTS scrub_entries (pack INTEGER NOT NULL, offset INTEGER NOT NULL, stored INTEGER NOT NULL, PRIMARY KEY (pack, offset)) WITHOUT ROWID;
    `))
    await this.drop()
    await this.scrub()
    await this.group()
    await this.compact()
    await this.removeEmpty()
    await this.trimNewest()
    this.report.packBytesAfter = this.packBytes()
  }

  async close(): Promise<void> {
    // A batch never switched (an error stopped the repack): its copies go, as a crash's would at the next repack.
    for (const copy of this.copies.splice(0)) await copy.discard()
    for (const handle of this.sources.values()) await handle.close()
    this.sources.clear()
    this.db.close()
  }

  /** Temporary copies a repack cut short left; this one holds the lock, so none is another's. */
  private async leftovers(): Promise<void> {
    for (const name of readdirSync(this.folder)) {
      if (!TEMPORARY.test(name)) continue
      await rm(join(this.folder, name), { force: true })
      this.report.leftovers += 1
    }
  }

  private packBytes(): number {
    let total = 0
    for (const name of readdirSync(this.folder, { withFileTypes: true })) if (name.isFile() && /^\d{8}\.pack$/.test(name.name)) total += statSize(join(this.folder, name.name))
    return total
  }

  /** `work` under the store's turn and its write lock, in one transaction. */
  private locked<T>(work: () => Promise<T>): Promise<T> {
    return this.parts.turn(async () => {
      const taken = Date.now()
      this.db.exec("BEGIN IMMEDIATE")
      try {
        const result = await work()
        this.db.exec("COMMIT")
        return result
      } catch (error) {
        if (this.db.isTransaction) this.db.exec("ROLLBACK")
        throw error
      } finally {
        this.report.longestTurnMs = Math.max(this.report.longestTurnMs, Date.now() - taken)
      }
    })
  }

  /**
   * 1. Chunks no version names, judged and dropped (`record-orphans.ts`).
   * The versions are read without the store's lock, and only when there's
   * something to find: chunks `forget` left, an intent whose capture failed
   * or whose owner is gone, unnamed chunks past their grace, or a sweep due
   * (`SWEEP_MS`). The lock is taken to judge what the read left, as the
   * store stands then, and drop it in one transaction: a capture that named
   * a chunk since claimed it in its own transaction (`RecordStore.storeChunk`),
   * and one that found it held before then starts over, since the drop
   * raises the generation (`RecordStore.slice`). Chunks stored during the
   * read wait for the next repack.
   */
  private async drop(): Promise<void> {
    const counts = this.report.orphans
    const now = Date.now()
    const grace = this.options.graceMs ?? GRACE_MS
    const standings = await intentStandings(this.db, this.parts.folder, now)
    const abandoned = [...standings.values()].filter((entry) => droppable(entry.standing)).map((entry) => entry.row.id)
    const meta = (key: string) => ValueSchema.optional().parse(this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key))?.value
    const swept = meta(SWEPT)
    const sweep = this.options.sweep ?? (swept === undefined || now - Number(swept) >= SWEEP_MS)
    const forgotten = Boolean(this.db.prepare("SELECT 1 FROM orphans LIMIT 1").get())
    const due = Boolean(this.db.prepare("SELECT 1 FROM unnamed WHERE since <= ? LIMIT 1").get(now - grace))
    if (!sweep && !forgotten && !abandoned.length && !due) return
    // The candidates `forget` had left by now: one it adds while the versions are read waits for the next repack.
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS orphan_listed (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      DELETE FROM orphan_listed; INSERT INTO orphan_listed (hash) SELECT hash FROM orphans;
    `)
    const scanned = Date.now()
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS orphan_cleared (id INTEGER PRIMARY KEY);
      DELETE FROM orphan_cleared;
    `)
    const clearing = this.db.prepare("INSERT INTO orphan_cleared (id) VALUES (?)")
    for (const id of abandoned) clearing.run(id)
    // Not sweeping: only what `forget` left, what failed or dead captures stored, and what has waited out its grace.
    counts.unnamed = listUnnamed(this.db, sweep ? undefined : `
      SELECT hash FROM orphans UNION SELECT hash FROM chunks WHERE intent IN (SELECT id FROM orphan_cleared)
      UNION SELECT hash FROM unnamed WHERE since <= ${Math.floor(now - grace)}`)
    counts.scanned = true
    counts.sweep = sweep
    counts.scanMs = Date.now() - scanned
    this.db.exec(`
      CREATE TEMP TABLE IF NOT EXISTS orphan_drop (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      CREATE TEMP TABLE IF NOT EXISTS orphan_new (hash BLOB PRIMARY KEY) WITHOUT ROWID;
      DELETE FROM orphan_drop; DELETE FROM orphan_new;
    `)
    await this.locked(async () => {
      const judging = Date.now()
      const dropping = this.db.prepare("INSERT INTO orphan_drop (hash) VALUES (?)")
      const first = this.db.prepare("INSERT INTO orphan_new (hash) VALUES (?)")
      const tally = { running: 0, forgotten: 0, abandoned: 0, unnamed: 0, waiting: 0 } satisfies Record<OrphanVerdict, number>
      let bytes = 0
      for (const chunk of judgeUnnamed(this.db, standings, now - grace)) {
        tally[chunk.verdict] += 1
        if (DROPPED_VERDICTS.has(chunk.verdict)) {
          dropping.run(chunk.hash)
          bytes += chunk.stored
        } else if (chunk.verdict === "waiting" && chunk.since === null) first.run(chunk.hash)
      }
      // Where their bytes lie, to overwrite once this commits: what the person deleted, or a capture left, leaves the disk, not only the index.
      this.db.exec(`
        INSERT OR IGNORE INTO scrub_entries (pack, offset, stored) SELECT pack, offset, stored FROM chunks WHERE hash IN (SELECT hash FROM orphan_drop);
        DELETE FROM chunks WHERE hash IN (SELECT hash FROM orphan_drop);
        DELETE FROM orphans AS t WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.hash = t.hash)
          OR (EXISTS (SELECT 1 FROM orphan_listed l WHERE l.hash = t.hash) AND EXISTS (SELECT 1 FROM orphan_named n WHERE n.hash = t.hash));
        DELETE FROM unnamed AS t WHERE EXISTS (SELECT 1 FROM orphan_named n WHERE n.hash = t.hash) OR NOT EXISTS (SELECT 1 FROM chunks c WHERE c.hash = t.hash);
        DELETE FROM intent_claims AS t WHERE EXISTS (SELECT 1 FROM orphan_named n WHERE n.hash = t.hash) OR NOT EXISTS (SELECT 1 FROM chunks c WHERE c.hash = t.hash)
          OR EXISTS (SELECT 1 FROM orphan_cleared d WHERE d.id = t.intent);
        DELETE FROM intents WHERE id IN (SELECT id FROM orphan_cleared);
      `)
      const found = Number(this.db.prepare("INSERT OR IGNORE INTO unnamed (hash, since) SELECT hash, ? FROM orphan_new").run(now).changes)
      // A chunk dropped, or newly found unnamed: a capture that found it held in an earlier slice starts over, and stores or claims it again.
      if (tally.forgotten + tally.abandoned + tally.unnamed + found > 0) {
        const generation = Number(meta(DROPPED) ?? "0")
        this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(DROPPED, String(generation + 1))
      }
      // Only a look at every chunk counts as a sweep: one at the candidates alone leaves the next sweep due.
      if (sweep) this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(SWEPT, String(now))
      counts.forgotten = tally.forgotten
      counts.abandoned = tally.abandoned
      counts.swept = tally.unnamed
      counts.running = tally.running
      counts.waiting = tally.waiting
      counts.intentsCleared = abandoned.length
      this.report.dropped += tally.forgotten + tally.abandoned + tally.unnamed
      this.report.droppedBytes += bytes
      counts.turnMs = Date.now() - judging
    })
    this.options.step?.("dropped")
    if (onMac()) await this.clearOwnerLocks()
  }

  /**
   * Lock files of owners whose process is gone and whose intents are
   * cleared (on macOS; elsewhere a lock leaves no file). One whose lock is
   * free has no process to take it again: its id was its process's alone.
   */
  private async clearOwnerLocks(): Promise<void> {
    const owners = join(this.parts.folder, OWNERS)
    const open = new Set(hasTable(this.db, "intents") ? z.object({ owner: z.string() }).array().parse(this.db.prepare("SELECT DISTINCT owner FROM intents").all()).map((row) => row.owner) : [])
    let names: string[] = []
    try {
      names = readdirSync(owners)
    } catch {
      return
    }
    for (const name of names) {
      const owner = name.replace(/\.lock$/, "")
      if (owner === name || open.has(owner)) continue
      if ((await probeLock(ownerLockPath(this.parts.folder, owner))) === "free") await rm(join(owners, name), { force: true })
    }
  }

  /** 2. Each quiet session whose chunks are scattered, copied in the order a whole read takes them. */
  private async group(): Promise<void> {
    const quiet = Date.now() - (this.options.quietMs ?? QUIET_MS)
    const sessions = SessionSchema.array().parse(this.db.prepare(`
      SELECT s.id, count(*) AS versions, max(v.captured_at) AS newest,
        (SELECT fingerprint FROM marks m WHERE m.session = s.id AND m.name = ?) AS grouped
      FROM sessions s JOIN session_units su ON su.session = s.id JOIN versions v ON v.unit = su.unit
      GROUP BY s.id`).all(GROUPED))
    for (const session of sessions) {
      const fingerprint = `${session.versions}:${session.newest}`
      if (session.newest > quiet || session.grouped === fingerprint) continue
      this.db.exec("DELETE FROM repack_order")
      const order = this.db.prepare("INSERT INTO repack_order (hash) VALUES (?)")
      for (const row of this.db.prepare(`
        SELECT v.chunks FROM session_units su JOIN units u ON u.id = su.unit JOIN versions v ON v.unit = u.id
        WHERE su.session = ? ORDER BY u.id, v.seq`).iterate(session.id)) {
        const list = ChunksSchema.parse(row).chunks
        for (let at = 0; at < list.length; at += HASH_BYTES) order.run(list.subarray(at, at + HASH_BYTES))
      }
      const mark = () => this.db.prepare("INSERT INTO marks (session, name, fingerprint) VALUES (?, ?, ?) ON CONFLICT (session, name) DO UPDATE SET fingerprint = excluded.fingerprint").run(session.id, GROUPED, fingerprint)
      const { chunks, runs } = this.layout()
      this.marks.push(mark)
      if (runs <= Math.max(FEW_RUNS, chunks / RUN_CHUNKS)) {
        this.report.alreadyGrouped += 1
        continue
      }
      await this.copy(this.placesInOrder())
      this.report.grouped += 1
    }
    await this.switchBatch()
  }

  /**
   * How the listed chunks lie: how many distinct ones there are, and in how
   * many contiguous runs a read in order takes them the first time each
   * comes. A chunk named again (a row repeating another's bytes) is read
   * from where it already is, laid out or not.
   */
  private layout(): Layout {
    this.db.exec("DELETE FROM repack_seen")
    const first = this.db.prepare("INSERT OR IGNORE INTO repack_seen (hash) VALUES (?)")
    let chunks = 0
    let runs = 0
    let end: { pack: number; offset: number } | null = null
    for (const place of this.placesInOrder()) {
      if (!Number(first.run(place.hash).changes)) continue
      chunks += 1
      if (!end || end.pack !== place.pack || end.offset !== place.offset) runs += 1
      end = { pack: place.pack, offset: place.offset + place.stored + ENTRY_HEADER_BYTES }
    }
    return { chunks, runs }
  }

  private *placesInOrder(): Generator<z.infer<typeof PlaceSchema>> {
    const page = this.db.prepare("SELECT o.n, c.hash, c.pack, c.offset, c.stored, c.size, c.codec FROM repack_order o JOIN chunks c ON c.hash = o.hash WHERE o.n > ? ORDER BY o.n LIMIT ?")
    let after = 0
    for (;;) {
      const rows = z.array(PlaceSchema.extend({ n: z.number() })).parse(page.all(after, PAGE))
      if (!rows.length) return
      for (const row of rows) yield row
      after = rows.at(-1)!.n
    }
  }

  /**
   * 1b. The dropped chunks' entries overwritten where they lie: a dead
   * header and zeros. No version names them, so nothing reads them again;
   * the list survives a crash in `scrub_entries`, and a pack removed since
   * took them with it. The space returns when the pack is compacted.
   */
  private async scrub(): Promise<void> {
    const listed = this.db.prepare("SELECT pack, offset, stored FROM scrub_entries WHERE pack > ? OR (pack = ? AND offset > ?) ORDER BY pack, offset LIMIT ?")
    let after = { pack: -1, offset: -1 }
    const done: { pack: number; offset: number }[] = []
    // One pack open at a time, synced once its entries are overwritten.
    const target = new ScrubTarget(this.folder)
    try {
      for (;;) {
        const rows = ScrubSchema.array().parse(listed.all(after.pack, after.pack, after.offset, PAGE))
        if (!rows.length) break
        for (const row of rows) {
          if (await target.overwrite(row.pack, row.offset - ENTRY_HEADER_BYTES, deadEntry(row.stored))) this.report.scrubbedBytes += ENTRY_HEADER_BYTES + row.stored
          done.push(row)
        }
        after = rows.at(-1)!
      }
    } finally {
      await target.close()
    }
    if (!done.length) return
    await this.locked(async () => {
      const forget = this.db.prepare("DELETE FROM scrub_entries WHERE pack = ? AND offset = ?")
      for (const row of done) forget.run(row.pack, row.offset)
    })
  }

  /** 3. Each pack below the newest that is mostly dead, its live chunks copied out in order. */
  private async compact(): Promise<void> {
    const newest = this.parts.packs.numbers().at(-1)
    const live = new Map(PackLiveSchema.array().parse(this.db.prepare(`SELECT pack, sum(stored) + count(*) * ${ENTRY_HEADER_BYTES} AS live FROM chunks GROUP BY pack`).all()).map((row) => [row.pack, row.live]))
    const statement = this.db.prepare("SELECT hash, pack, offset, stored, size, codec FROM chunks WHERE pack = ? AND offset > ? ORDER BY offset LIMIT ?")
    const inPack = function* (pack: number): Generator<z.infer<typeof PlaceSchema>> {
      let after = -1
      for (;;) {
        const rows = PlaceSchema.array().parse(statement.all(pack, after, PAGE))
        if (!rows.length) return
        yield* rows
        after = rows.at(-1)!.offset
      }
    }
    for (const pack of this.parts.packs.numbers()) {
      const kept = live.get(pack) ?? 0
      if (pack !== newest && kept > 0 && kept < statSize(join(this.folder, packName(pack))) * (this.options.liveRatio ?? LIVE_RATIO)) await this.copy(inPack(pack))
    }
    await this.switchBatch()
  }

  /**
   * 5. The newest pack cut to the end of its last indexed entry. A write
   * cut short before its commit (killed, failed) leaves bytes past it no
   * index names, and compaction never reaches the newest pack. Under the
   * store's turn and its write lock, so no capture in any process is
   * appending (each finds the pack's size again as its next transaction
   * begins, `Packs.begin`), and only while no intent runs or can't be
   * proven over (`trimBlocker`). The length goes first into `TRIM_RECORD`,
   * synced; then the truncate, synced; then the record goes. A crash
   * between leaves the pack whole up to every indexed entry, and the next
   * repack trims again from what the index says then and removes the record.
   */
  private async trimNewest(): Promise<void> {
    const record = join(this.parts.folder, TRIM_RECORD)
    const trim = this.report.trim
    trim.resumed = existsSync(record)
    await this.locked(async () => {
      trim.skipped = trimBlocker(await intentStandings(this.db, this.parts.folder))
      if (trim.skipped) return
      const tail = newestTail(this.db, this.parts.folder)
      if (tail && tail.size > tail.end) {
        const intended: TrimRecord = { pack: tail.pack, length: tail.end, from: tail.size, at: Date.now() }
        const written = await open(record, "w")
        try {
          await written.writeFile(JSON.stringify(intended))
          await written.sync()
        } finally {
          await written.close()
        }
        this.options.step?.("trimming")
        const pack = await open(join(this.folder, packName(tail.pack)), "r+")
        try {
          await pack.truncate(tail.end)
          await pack.sync()
        } finally {
          await pack.close()
        }
        // Dropped entries that lay in the tail went with it: nothing is left to overwrite there.
        this.db.prepare("DELETE FROM scrub_entries WHERE pack = ? AND offset >= ?").run(tail.pack, tail.end)
        trim.pack = tail.pack
        trim.bytes = tail.size - tail.end
      }
      await rm(record, { force: true })
    })
  }

  /** 4. Packs below the newest that no chunk names, checked and removed under the write lock. */
  private async removeEmpty(): Promise<void> {
    await this.locked(async () => {
      const named = this.db.prepare("SELECT 1 AS n FROM chunks WHERE pack = ? LIMIT 1")
      const numbers = this.parts.packs.numbers()
      const newest = numbers.at(-1)
      for (const pack of numbers) {
        if (pack === newest || named.get(pack)) continue
        await this.sources.get(pack)?.close()
        this.sources.delete(pack)
        await this.parts.packs.drop(pack)
        await rm(join(this.folder, packName(pack)), { force: true })
        this.report.packsRemoved += 1
      }
    })
  }

  /**
   * Copies `places` into the batch's temporary packs after what it holds,
   * skipping a chunk the batch holds already, so each session's chunks lie
   * together and several sessions share a pack.
   */
  private async copy(places: Iterable<z.infer<typeof PlaceSchema>>): Promise<void> {
    const move = this.db.prepare("INSERT OR IGNORE INTO repack_moves (hash, file, old_pack, old_offset, offset) VALUES (?, ?, ?, ?, ?)")
    const moved = this.db.prepare("SELECT 1 AS n FROM repack_moves WHERE hash = ?")
    for (const place of places) {
      if (moved.get(place.hash)) continue
      const body = await this.read(place.pack, place.offset, place.stored)
      let copy = this.copies.at(-1)
      if (!copy || copy.size + ENTRY_HEADER_BYTES + body.length > PACK_LIMIT) this.copies.push(copy = await TemporaryPack.create(this.folder))
      const offset = await copy.append(Buffer.from(place.hash), place.codec, place.size, body)
      move.run(place.hash, this.copies.length - 1, place.pack, place.offset, offset)
      this.batchBytes += ENTRY_HEADER_BYTES + body.length
      this.report.copied += 1
      this.report.copiedBytes += ENTRY_HEADER_BYTES + body.length
    }
    if (this.batchBytes >= BATCH_BYTES) await this.switchBatch()
  }

  /**
   * Switches the index to the batch. Under the turn, each copy becomes the
   * next pack; then its chunks move to it `SWITCH_ROWS` at a time, each
   * only if it's still where it was copied from, a turn for each slice, so
   * a live capture waits for one slice at most. Every state between is
   * whole: a chunk not moved yet still reads from its old place, which
   * stays until no chunk names it. The batch's marks go last.
   */
  private async switchBatch(): Promise<void> {
    const copies = this.copies.splice(0)
    const marks = this.marks.splice(0)
    this.batchBytes = 0
    if (!copies.length && !marks.length) return
    for (const copy of copies) await copy.finish()
    if (copies.length) this.options.step?.("copied")
    const slice = this.db.prepare("SELECT max(hash) AS hash FROM (SELECT hash FROM repack_moves WHERE file = ? AND hash > ? ORDER BY hash LIMIT ?)")
    const update = this.db.prepare(`
      UPDATE chunks SET pack = ?1, offset = m.offset FROM repack_moves m
      WHERE m.file = ?2 AND m.hash > ?3 AND m.hash <= ?4 AND chunks.hash = m.hash AND chunks.pack = m.old_pack AND chunks.offset = m.old_offset`)
    for (const [index, copy] of copies.entries()) {
      const pack = await this.locked(async () => {
        const next = (this.parts.packs.numbers().at(-1) ?? 0) + 1
        await rename(copy.path, join(this.folder, packName(next)))
        return next
      })
      this.report.packsWritten += 1
      this.options.step?.("placed")
      let after: Uint8Array = Buffer.alloc(0)
      for (;;) {
        const through = z.object({ hash: z.instanceof(Uint8Array).nullable() }).parse(slice.get(index, after, SWITCH_ROWS)).hash
        if (!through) break
        await this.locked(async () => update.run(pack, index, after, through))
        after = through
      }
    }
    await this.locked(async () => {
      for (const mark of marks) mark()
    })
    this.db.exec("DELETE FROM repack_moves")
    if (copies.length) this.options.step?.("switched")
  }

  private async read(pack: number, offset: number, stored: number): Promise<Buffer> {
    let handle = this.sources.get(pack)
    if (!handle) this.sources.set(pack, handle = await open(join(this.folder, packName(pack)), "r"))
    const body = Buffer.allocUnsafe(stored)
    let read = 0
    while (read < stored) {
      const { bytesRead } = await handle.read(body, read, stored - read, offset + read)
      if (bytesRead === 0) throw new Error(`${packName(pack)} ends before the chunk at ${offset}`)
      read += bytesRead
    }
    return body
  }
}

/** The pack a scrub is overwriting entries of, kept open across its entries and synced when it moves on. */
class ScrubTarget {
  private pack = -1
  private handle: FileHandle | null = null

  constructor(private readonly folder: string) {}

  /** Writes `bytes` at `at` in `pack`; false when the pack is gone, its entries with it. */
  async overwrite(pack: number, at: number, bytes: Buffer): Promise<boolean> {
    if (pack !== this.pack) {
      await this.close()
      this.pack = pack
      this.handle = await open(join(this.folder, packName(pack)), "r+").catch(() => null)
    }
    if (!this.handle) return false
    await this.handle.write(bytes, 0, bytes.length, at)
    return true
  }

  async close(): Promise<void> {
    const handle = this.handle
    this.handle = null
    this.pack = -1
    if (!handle) return
    await handle.sync()
    await handle.close()
  }
}

/** A pack being written by a repack, under a name no reader or writer opens until the switch renames it. */
class TemporaryPack {
  size = 0

  private constructor(readonly path: string, private readonly handle: FileHandle) {}

  static async create(folder: string): Promise<TemporaryPack> {
    const path = join(folder, `repack-${process.pid}-${randomUUID()}.tmp`)
    return new TemporaryPack(path, await open(path, "wx"))
  }

  async append(hash: Buffer, codec: ChunkCodec, size: number, body: Buffer): Promise<number> {
    const offset = this.size + ENTRY_HEADER_BYTES
    await this.handle.writev(packEntry(hash, codec, size, body), this.size)
    this.size += ENTRY_HEADER_BYTES + body.length
    return offset
  }

  /** Durable before the index names it. */
  async finish(): Promise<void> {
    await this.handle.sync()
    await this.handle.close()
  }

  async discard(): Promise<void> {
    await this.handle.close().catch(() => undefined)
    await rm(this.path, { force: true })
  }
}

function statSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}
