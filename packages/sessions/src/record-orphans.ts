import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { ENTRY_HEADER_BYTES, HASH_BYTES } from "./record-chunks.js"
import { droppable, intentStanding, IntentRowSchema, type IntentRow, type IntentStanding } from "./record-intents.js"

/**
 * Chunks no version names, found and judged. Three things leave them:
 *
 * - **forgotten**: a session the person deleted (`RecordStore.forget`) was
 *   the only one to name them; `orphans` lists them.
 * - **abandoned**: a capture stored them and failed, or its process died,
 *   before the version naming them committed; its intent says so
 *   (`record-intents.ts`).
 * - **unnamed**: neither of those says why (a store an older build wrote, a
 *   capture that finished without naming one). Found by a sweep, kept as
 *   `unnamed` with when it was first seen, and dropped once it has stayed
 *   unnamed for `GRACE_MS` with no capture claiming it.
 *
 * A chunk a capture in progress may still name is never dropped: one its
 * intent stored, or one it found held and **claimed** (`intent_claims`, and
 * the chunk's intent moves to it), while that intent's owner runs or can't
 * be proven gone. A capture claims a held chunk whenever an intent stored
 * it or a sweep found it unnamed, in the transaction that finds it, so a
 * version committed between the repack's read of the versions and its drop
 * always moved the chunk out of what the drop takes. Anything else a
 * capture found held earlier and names later meets the drop generation
 * (`RecordStore.slice`), raised by each drop and by each sweep that finds a
 * new unnamed chunk.
 */

/** A full sweep for unnamed chunks runs at most this often, besides each repack with forgotten or abandoned ones to find. */
export const SWEEP_MS = 24 * 60 * 60_000
/** An unnamed chunk is dropped once it has been unnamed, unclaimed, this long. */
export const GRACE_MS = 60 * 60_000
/** The `meta` key that keeps when the last full sweep ran. */
export const SWEPT = "orphans swept"
/** Version chunk lists are read into the named set this many hashes to a statement. */
const BATCH = 256

export type OrphanVerdict =
  /** A capture in progress may still name it. */
  | "running"
  | "forgotten"
  | "abandoned"
  /** Unnamed past the grace, with nothing claiming it. */
  | "unnamed"
  /** Unnamed, but not yet for the grace. */
  | "waiting"

export const DROPPED_VERDICTS: ReadonlySet<OrphanVerdict> = new Set(["forgotten", "abandoned", "unnamed"])

/** A chunk's verdict, and why, in words for the readout. */
export interface OrphanJudgement {
  verdict: OrphanVerdict
  reason: string
}

export interface OrphanChunk extends OrphanJudgement {
  hash: Buffer
  pack: number
  offset: number
  stored: number
  /** The intent that stored or last claimed it, and the others that claimed it. */
  intent: number | null
  claims: number[]
  /** When a sweep first found it unnamed; null if none has. */
  since: number | null
}

const CandidateSchema = z.object({
  hash: z.instanceof(Uint8Array), pack: z.number(), offset: z.number(), stored: z.number(),
  intent: z.number().nullable(), claims: z.string().nullable(), forgotten: z.number(), since: z.number().nullable(),
})
const ChunksSchema = z.object({ chunks: z.instanceof(Uint8Array) })
const CountSchema = z.object({ n: z.number() })

export function hasTable(db: DatabaseSync, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name))
}

/** Each intent with its standing, as this process can prove it. */
export async function intentStandings(db: DatabaseSync, folder: string, now = Date.now()): Promise<Map<number, { row: IntentRow; standing: IntentStanding }>> {
  const found = new Map<number, { row: IntentRow; standing: IntentStanding }>()
  if (!hasTable(db, "intents")) return found
  for (const row of IntentRowSchema.array().parse(db.prepare("SELECT id, owner, scope, pid, start, locked, session, began, ended FROM intents ORDER BY id").all()))
    found.set(row.id, { row, standing: await intentStanding(folder, row, now) })
  return found
}

/**
 * Lists on `db`, a connection of the reader's own, the chunks no version
 * names, in one read without the store's lock: every chunk (a sweep), or
 * only `candidates` (SQL selecting hashes: what `forget` left, what failed
 * captures stored). `orphan_unnamed` takes those unnamed, and
 * `orphan_named` those found named, which a repack clears from its lists.
 * Bounded memory: a batch of hashes at a time, the rest in SQLite. A sweep
 * gathers every name the versions list and keeps the chunks it lacks; a
 * look at candidates strikes each name off them, far cheaper when they're
 * few. Returns how many it found unnamed.
 */
export function listUnnamed(db: DatabaseSync, candidates?: string): number {
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS orphan_named (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS orphan_unnamed (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    CREATE TEMP TABLE IF NOT EXISTS orphan_candidates (hash BLOB PRIMARY KEY) WITHOUT ROWID;
    DELETE FROM orphan_named; DELETE FROM orphan_unnamed; DELETE FROM orphan_candidates;
  `)
  const slots = Array.from({ length: BATCH }, () => "?").join(", ")
  const many = candidates === undefined
    ? db.prepare(`INSERT OR IGNORE INTO orphan_named (hash) VALUES ${Array.from({ length: BATCH }, () => "(?)").join(", ")}`)
    : db.prepare(`DELETE FROM orphan_unnamed WHERE hash IN (${slots})`)
  const one = candidates === undefined ? db.prepare("INSERT OR IGNORE INTO orphan_named (hash) VALUES (?)") : db.prepare("DELETE FROM orphan_unnamed WHERE hash = ?")
  let batch: Uint8Array[] = []
  db.exec("BEGIN")
  try {
    if (candidates !== undefined) db.exec(`
      INSERT OR IGNORE INTO orphan_candidates (hash) SELECT k.hash FROM (${candidates}) k WHERE EXISTS (SELECT 1 FROM chunks c WHERE c.hash = k.hash);
      INSERT INTO orphan_unnamed (hash) SELECT hash FROM orphan_candidates;
    `)
    for (const row of db.prepare("SELECT chunks FROM versions").iterate()) {
      const list = ChunksSchema.parse(row).chunks
      for (let at = 0; at < list.length; at += HASH_BYTES) {
        batch.push(list.subarray(at, at + HASH_BYTES))
        if (batch.length === BATCH) {
          many.run(...batch)
          batch = []
        }
      }
    }
    for (const hash of batch) one.run(hash)
    if (candidates === undefined) db.exec("INSERT INTO orphan_unnamed (hash) SELECT hash FROM chunks c WHERE NOT EXISTS (SELECT 1 FROM orphan_named n WHERE n.hash = c.hash)")
    else db.exec("INSERT INTO orphan_named (hash) SELECT hash FROM orphan_candidates k WHERE NOT EXISTS (SELECT 1 FROM orphan_unnamed u WHERE u.hash = k.hash)")
    db.exec("COMMIT")
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK")
    throw error
  }
  return CountSchema.parse(db.prepare("SELECT count(*) AS n FROM orphan_unnamed").get()).n
}

/**
 * Each chunk `listUnnamed` found, as the store holds it now, with its
 * verdict. `standings` are the intents' as read before; an intent that
 * exists now but wasn't read then began since, and runs. `cutoff`: a chunk
 * first found unnamed at or before it is past the grace.
 */
export function* judgeUnnamed(db: DatabaseSync, standings: ReadonlyMap<number, { standing: IntentStanding }>, cutoff: number): Generator<OrphanChunk> {
  const intents = hasTable(db, "intents")
  const existing = new Set(intents ? z.object({ id: z.number() }).array().parse(db.prepare("SELECT id FROM intents").all()).map((row) => row.id) : [])
  const claims = hasTable(db, "intent_claims") ? "(SELECT group_concat(k.intent) FROM intent_claims k WHERE k.hash = c.hash)" : "NULL"
  const since = hasTable(db, "unnamed") ? "(SELECT u.since FROM unnamed u WHERE u.hash = c.hash)" : "NULL"
  const tag = intents ? "c.intent" : "NULL"
  // CROSS JOIN: SQLite reads the few unnamed chunks first, not the whole index in pack order looking each up.
  for (const found of db.prepare(`
    SELECT c.hash, c.pack, c.offset, c.stored, ${tag} AS intent, ${claims} AS claims,
      EXISTS (SELECT 1 FROM orphans o WHERE o.hash = c.hash) AS forgotten, ${since} AS since
    FROM orphan_unnamed n CROSS JOIN chunks c ON c.hash = n.hash ORDER BY c.pack, c.offset`).iterate()) {
    const row = CandidateSchema.parse(found)
    const claimed = row.claims ? row.claims.split(",").map(Number) : []
    const members = [...(row.intent === null ? [] : [row.intent]), ...claimed]
    const judged = judge(row, members, existing, standings, cutoff)
    yield { hash: Buffer.from(row.hash), pack: row.pack, offset: row.offset, stored: row.stored, intent: row.intent, claims: claimed, since: row.since, ...judged }
  }
}

function judge(row: z.infer<typeof CandidateSchema>, members: number[], existing: ReadonlySet<number>, standings: ReadonlyMap<number, { standing: IntentStanding }>, cutoff: number): OrphanJudgement {
  for (const member of members) {
    if (!existing.has(member)) continue
    const standing = standings.get(member)?.standing
    if (droppable(standing)) continue
    return { verdict: "running", reason: `capture #${member} may still name it: ${standing?.reason ?? "it began after this look"}` }
  }
  if (row.forgotten) return { verdict: "forgotten", reason: "only sessions the person deleted named it" }
  // Abandoned only while every intent that stored or claimed it is still there to say so: one that finished may have named it since the versions were read.
  if (row.intent !== null && members.every((member) => existing.has(member) && droppable(standings.get(member)?.standing)))
    return { verdict: "abandoned", reason: `capture #${row.intent} stored it and named it in no version: ${standings.get(row.intent)?.standing.reason}` }
  if (row.since !== null && row.since <= cutoff) return { verdict: "unnamed", reason: `no version or capture has named it since ${new Date(row.since).toISOString()}` }
  return {
    verdict: "waiting",
    reason: row.since === null ? "found unnamed now, with no capture to say why; dropped once it stays so" : `unnamed since ${new Date(row.since).toISOString()}; dropped once it stays so ${Math.round(GRACE_MS / 60_000)} minutes`,
  }
}

/**
 * Where a trim of the newest pack writes its intended length before it
 * truncates (`record-repack.ts`): one cut short leaves it, and the next
 * repack finishes the trim and removes it.
 */
export const TRIM_RECORD = "trim.json"
const TrimRecordSchema = z.object({ pack: z.number(), length: z.number(), from: z.number(), at: z.number() })
export type TrimRecord = z.infer<typeof TrimRecordSchema>

/** The trim a repack cut short left, if any. */
export function pendingTrim(folder: string): TrimRecord | null {
  const path = join(folder, TRIM_RECORD)
  if (!existsSync(path)) return null
  try {
    return TrimRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    // Written whole and synced before the truncate; one that doesn't parse was cut short before it, and named nothing.
    return null
  }
}

/**
 * The newest pack and what follows its last indexed entry: bytes a write
 * cut short before its commit left (staged, synced, never indexed), and
 * entries dropped at its end. Captures append only to the newest pack, so
 * that's the only tail compaction never reaches.
 */
export interface PackTail {
  pack: number
  size: number
  /** Where its last indexed entry ends: what it's trimmed to. */
  end: number
}

export function newestTail(db: DatabaseSync, folder: string): PackTail | null {
  const newest = packSpace(db, folder).at(-1)
  if (!newest) return null
  const end = CountSchema.parse(db.prepare("SELECT coalesce(max(offset + stored), 0) AS n FROM chunks WHERE pack = ?").get(newest.pack)).n
  return { pack: newest.pack, size: newest.bytes, end }
}

/**
 * Why the newest pack's tail can't be trimmed now: an intent whose capture
 * runs, or can't be proven not to (another namespace's). Null when none
 * is, so no capture anywhere is between its chunks and its version.
 */
export function trimBlocker(standings: ReadonlyMap<number, { row: IntentRow; standing: IntentStanding }>): string | null {
  for (const { row, standing } of standings.values())
    if (!droppable(standing)) return `capture #${row.id} (${row.session}) is ${standing.state === "running" ? "running" : "not provably over"}: ${standing.reason}`
  return null
}

export interface PackSpace {
  pack: number
  bytes: number
  /** Bytes of the entries the index names. */
  live: number
}

/** Each pack's size against what the index names in it: the rest is dropped entries awaiting compaction and tails a write cut short left. */
export function packSpace(db: DatabaseSync, folder: string): PackSpace[] {
  const live = new Map(z.object({ pack: z.number(), live: z.number() }).array().parse(db.prepare(`SELECT pack, sum(stored) + count(*) * ${ENTRY_HEADER_BYTES} AS live FROM chunks GROUP BY pack`).all()).map((row) => [row.pack, row.live]))
  const packs = join(folder, "packs")
  let names: string[] = []
  try {
    names = readdirSync(packs)
  } catch {
    return []
  }
  return names.flatMap((name) => {
    const match = /^(\d{8})\.pack$/.exec(name)
    if (!match) return []
    const pack = Number(match[1])
    return [{ pack, bytes: statSync(join(packs, name)).size, live: live.get(pack) ?? 0 }]
  }).sort((left, right) => left.pack - right.pack)
}

export interface OrphanReport {
  chunks: number
  unnamed: number
  ms: number
  /** Unnamed chunks by verdict, with their stored bytes. */
  verdicts: Record<OrphanVerdict, { chunks: number; bytes: number }>
  intents: { row: IntentRow; standing: IntentStanding; chunks: number; bytes: number }[]
  /** Each unnamed chunk, up to the limit asked for. */
  listed: OrphanChunk[]
  packs: PackSpace[]
  lastSweep: number | null
  /** The newest pack's tail past its last indexed entry, and why the next repack trims it or not. */
  tail: (PackTail & { blocked: string | null }) | null
  /** A trim a repack cut short, which the next one finishes. */
  pendingTrim: TrimRecord | null
}

/**
 * The store's orphans as the repack would judge them now, read only: what
 * `records.ts orphans` prints. The store may be in a newer format, or an
 * older one with no intents yet.
 */
export async function orphanReport(folder: string, options: { list?: number; now?: number } = {}): Promise<OrphanReport> {
  const started = Date.now()
  const now = options.now ?? started
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite")
  const db = new DatabaseSync(join(folder, "records.sqlite"), { readOnly: true })
  try {
    const standings = await intentStandings(db, folder, now)
    const unnamed = listUnnamed(db)
    const verdicts: OrphanReport["verdicts"] = { running: { chunks: 0, bytes: 0 }, forgotten: { chunks: 0, bytes: 0 }, abandoned: { chunks: 0, bytes: 0 }, unnamed: { chunks: 0, bytes: 0 }, waiting: { chunks: 0, bytes: 0 } }
    const byIntent = new Map<number, { chunks: number; bytes: number }>()
    const listed: OrphanChunk[] = []
    for (const chunk of judgeUnnamed(db, standings, now - GRACE_MS)) {
      verdicts[chunk.verdict].chunks += 1
      verdicts[chunk.verdict].bytes += chunk.stored + ENTRY_HEADER_BYTES
      if (chunk.intent !== null) {
        const counted = byIntent.get(chunk.intent) ?? { chunks: 0, bytes: 0 }
        counted.chunks += 1
        counted.bytes += chunk.stored + ENTRY_HEADER_BYTES
        byIntent.set(chunk.intent, counted)
      }
      if (listed.length < (options.list ?? 0)) listed.push(chunk)
    }
    const swept = hasTable(db, "meta") ? z.object({ value: z.string() }).optional().parse(db.prepare("SELECT value FROM meta WHERE key = ?").get(SWEPT))?.value : undefined
    return {
      chunks: CountSchema.parse(db.prepare("SELECT count(*) AS n FROM chunks").get()).n,
      unnamed,
      ms: Date.now() - started,
      verdicts,
      intents: [...standings.values()].map((entry) => ({ ...entry, ...(byIntent.get(entry.row.id) ?? { chunks: 0, bytes: 0 }) })),
      listed,
      packs: packSpace(db, folder),
      lastSweep: swept === undefined ? null : Number(swept),
      tail: tailOf(newestTail(db, folder), standings),
      pendingTrim: pendingTrim(folder),
    }
  } finally {
    db.close()
  }
}

function tailOf(tail: PackTail | null, standings: ReadonlyMap<number, { row: IntentRow; standing: IntentStanding }>): OrphanReport["tail"] {
  return tail && { ...tail, blocked: trimBlocker(standings) }
}
