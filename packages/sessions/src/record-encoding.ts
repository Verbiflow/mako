/**
 * Which encoding a record's file is in, from its name alone: a harness
 * writes a record plain and may later compress it in place (Codex rewrites a
 * rollout untouched for a week as `.jsonl.zst`). Reading the bytes is
 * `record-files.ts`.
 */

export type RecordEncoding = "plain" | "zstd"

/** The suffix each encoding adds to the plain file's name. */
const SUFFIXES = { plain: "", zstd: ".zst" } as const satisfies Record<RecordEncoding, string>

export function recordEncoding(path: string): RecordEncoding {
  return path.endsWith(SUFFIXES.zstd) ? "zstd" : "plain"
}

/** The record's plain file name, whatever its encoding. */
export function plainRecordPath(path: string): string {
  const suffix = SUFFIXES[recordEncoding(path)]
  return suffix ? path.slice(0, -suffix.length) : path
}

/** The record's file in `encoding`. */
export function encodedRecordPath(path: string, encoding: RecordEncoding): string {
  return plainRecordPath(path) + SUFFIXES[encoding]
}

/**
 * Of files found together, each record's once: a plain file hides its
 * compressed sibling, as the harness reads it. Compression writes the
 * compressed file before deleting the plain one, and a restore the reverse,
 * so both exist only for that moment and hold the same bytes.
 */
export function oneFilePerRecord(paths: readonly string[]): string[] {
  const plain = new Set(paths.filter((path) => recordEncoding(path) === "plain"))
  return paths.filter((path) => recordEncoding(path) === "plain" || !plain.has(plainRecordPath(path)))
}
