import { z } from "zod"

/**
 * A session's records as they cross between record stores (a machine's, the gateway's, a laptop's): its units and
 * the versions one store has past what the other holds, each version naming its chunks by hash. Chunks cross apart,
 * in packs, each checked against its hash where it lands. Logical unit keys and the session's layout make a bundle
 * independent of where it was captured; a restore moves it into the destination's own folders.
 *
 * Every store takes a bundle by one rule (`planRecordImport`): a version it holds must be the one arriving, and one
 * past its head must follow it. Records that went on in two places, or that skip, are refused, never stitched.
 */

const Hex = z.string().regex(/^[0-9a-f]*$/)
/** A chunk's hash: the SHA-256 of its plain bytes, as hex. */
export const ChunkHashSchema = z.string().regex(/^[0-9a-f]{64}$/)

export const RecordVersionSchema = z.object({
  seq: z.number().int().nonnegative(),
  kind: z.enum(["append", "replace", "delete"]),
  /** When it was written, in ms, by the clock of the store that captured it. */
  at: z.number(),
  size: z.number().int().nonnegative(),
  digest: Hex.nullable(),
  tail: Hex.nullable(),
  /** Its chunks' hashes, in order, as hex laid end to end. */
  chunks: Hex.refine((chunks) => chunks.length % 64 === 0, "whole hashes"),
  detail: z.string().nullable(),
  writer: z.string().nullable(),
  writerSource: z.enum(["record", "observed"]).nullable(),
})
export type RecordVersion = z.infer<typeof RecordVersionSchema>

export const RecordUnitSchema = z.object({
  key: z.string().min(1),
  role: z.enum(["file", "row", "schema", "lines"]),
  /** A file's path as its root names it (`claude:projects/x/s1.jsonl`), where a restore writes it; and every place its harness may file it. */
  path: z.string().nullable(),
  places: z.string().nullable(),
  /** In order; contiguous from the first `seq` past what the receiving store holds. */
  versions: z.array(RecordVersionSchema),
})
export type RecordUnit = z.infer<typeof RecordUnitSchema>

export const RecordLayoutSchema = z.object({
  home: z.string(),
  roots: z.record(z.string(), z.string()),
  paths: z.record(z.string(), z.record(z.string(), z.array(z.string()))),
})
export type RecordLayout = z.infer<typeof RecordLayoutSchema>

export const RecordBundleSchema = z.object({
  harness: z.string().min(1).max(64),
  nativeId: z.string().min(1).max(512),
  /** Where the records were when captured: the machine's home, each root's folder, and the path columns of each database. */
  layout: RecordLayoutSchema,
  /**
   * The session's marks as the sending store keeps them, but those naming only its own machine's files: which
   * databases its captures took whole (a restore writes only those), their schema and key digests, its writers and
   * listing. A mark the receiving store already keeps for the session stays as it is.
   */
  marks: z.record(z.string(), z.string()),
  units: z.array(RecordUnitSchema),
})
export type RecordBundle = z.infer<typeof RecordBundleSchema>

/** What a store holds of a session: each unit's newest `seq`, by key. A bundle carries only what's past it. */
export const RecordHoldingsSchema = z.record(z.string(), z.number().int().min(-1))
export type RecordHoldings = z.infer<typeof RecordHoldingsSchema>

/** The chunk hashes some versions name, each once: a whole bundle's with `bundle.units.flatMap((unit) => unit.versions)`. */
export function recordChunks(versions: readonly RecordVersion[]): string[] {
  const hashes = new Set<string>()
  for (const version of versions)
    for (let at = 0; at < version.chunks.length; at += 64) hashes.add(version.chunks.slice(at, at + 64))
  return [...hashes]
}

/** Why a store refused a bundle: a unit's version it holds differs (`diverged`), or one arrives past a gap (`gap`). */
export class RecordConflictError extends Error {
  constructor(
    readonly conflict: "diverged" | "gap",
    readonly key: string,
    readonly seq: number,
    readonly head: number
  ) {
    super(
      conflict === "diverged"
        ? `The records of ${key} went on in two places: version ${seq} differs`
        : `The records of ${key} skip from version ${head} to ${seq}; the versions between are needed first`
    )
  }
}

/** What a receiving store knows of one unit: its newest `seq`, and the kind and chunks of a version it holds. */
export type HeldUnit = { head: number; version(seq: number): { kind: RecordVersion["kind"]; chunks: string } | undefined }

/**
 * The one rule every store takes a bundle by. Versions at or below the unit's head must be the ones held (the same
 * kind and chunks); the first past it must be `head + 1`, and each after it the next. Returns what's new, in order,
 * and how many arrived already held; throws `RecordConflictError` on anything else, before a store writes anything.
 */
export type RecordImportPlan = { taking: Array<{ unit: RecordUnit; version: RecordVersion }>; held: number }
export function planRecordImport(bundle: RecordBundle, held: (key: string) => HeldUnit | undefined): RecordImportPlan {
  const taking: Array<{ unit: RecordUnit; version: RecordVersion }> = []
  let already = 0
  for (const unit of bundle.units) {
    const known = held(unit.key)
    const head = known?.head ?? -1
    let next = head + 1
    for (const version of unit.versions) {
      if (version.seq < next) {
        const kept = known?.version(version.seq)
        if (!kept || kept.kind !== version.kind || kept.chunks !== version.chunks) throw new RecordConflictError("diverged", unit.key, version.seq, head)
        already += 1
        continue
      }
      if (version.seq !== next) throw new RecordConflictError("gap", unit.key, version.seq, next - 1)
      taking.push({ unit, version })
      next += 1
    }
  }
  return { taking, held: already }
}

/**
 * Chunks travel in packs: entries laid end to end, each a header and the chunk's stored body, the layout of a record
 * store's own pack files. Header: magic `MCK1` (little-endian u32), the 32-byte hash, the codec (0 plain, 1 zstd),
 * the plain size and the stored size (little-endian u32 each).
 */
export const CHUNK_PACK_MAGIC = 0x314b434d
export const CHUNK_HEADER_BYTES = 4 + 32 + 1 + 4 + 4
/** The most a chunk's plain bytes can be: a record store cuts at 64 KiB. */
export const CHUNK_MAX_BYTES = 64 * 1024

export type PackedChunk = { hash: string; codec: 0 | 1; size: number; body: Uint8Array }

/** One pack holding `chunks`, in order. */
export function encodeChunkPack(chunks: readonly PackedChunk[]): Uint8Array<ArrayBuffer> {
  const total = chunks.reduce((sum, chunk) => sum + CHUNK_HEADER_BYTES + chunk.body.length, 0)
  const bytes = new Uint8Array(total)
  const view = new DataView(bytes.buffer)
  let at = 0
  for (const chunk of chunks) {
    view.setUint32(at, CHUNK_PACK_MAGIC, true)
    bytes.set(hexBytes(chunk.hash), at + 4)
    view.setUint8(at + 36, chunk.codec)
    view.setUint32(at + 37, chunk.size, true)
    view.setUint32(at + 41, chunk.body.length, true)
    bytes.set(chunk.body, at + CHUNK_HEADER_BYTES)
    at += CHUNK_HEADER_BYTES + chunk.body.length
  }
  return bytes
}

/** Each entry of a pack with where its body sits in it; throws on a pack that isn't whole. */
export function decodeChunkPack(bytes: Uint8Array): Array<PackedChunk & { offset: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const entries: Array<PackedChunk & { offset: number }> = []
  let at = 0
  while (at < bytes.length) {
    if (at + CHUNK_HEADER_BYTES > bytes.length || view.getUint32(at, true) !== CHUNK_PACK_MAGIC) throw new Error(`Not a chunk pack at byte ${at}`)
    const codec = view.getUint8(at + 36)
    if (codec !== 0 && codec !== 1) throw new Error(`A chunk at byte ${at} names codec ${codec}`)
    const size = view.getUint32(at + 37, true)
    const stored = view.getUint32(at + 41, true)
    const offset = at + CHUNK_HEADER_BYTES
    if (size > CHUNK_MAX_BYTES || offset + stored > bytes.length) throw new Error(`The chunk at byte ${at} runs past its pack`)
    entries.push({ hash: bytesHex(bytes.subarray(at + 4, at + 36)), codec, size, body: bytes.subarray(offset, offset + stored), offset })
    at = offset + stored
  }
  return entries
}

function hexBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`Not a chunk hash: ${hex.slice(0, 80)}`)
  const bytes = new Uint8Array(32)
  for (let index = 0; index < 32; index++) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  return bytes
}

function bytesHex(bytes: Uint8Array): string {
  let hex = ""
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0")
  return hex
}

/** A session a store holds records of, as it lists them: how many versions, and the newest number it gave one. */
export const RecordSessionSchema = z.object({ harness: z.string(), nativeId: z.string(), units: z.number().int(), versions: z.number().int(), through: z.number().int() })
export type RecordSession = z.infer<typeof RecordSessionSchema>

/** The most hashes one ask names, and the most bytes one pack carries, either way. */
export const RECORD_ASK_HASHES = 4096
export const RECORD_PACK_BYTES = 16 * 1024 * 1024
