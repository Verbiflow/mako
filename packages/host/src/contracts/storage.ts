/** Under this much free space Mako warns, and its collectors run without waiting for their schedule. */
export const STORAGE_LOW_BYTES = 10 * 1024 ** 3

/** What Mako keeps on this Mac, part by part, and what its collectors last freed (`mako:storage`). */
export interface StorageReport {
  /** When the parts were measured; null until the first measurement ends. */
  at: string | null
  /** The disk Mako's folders are on. */
  disk: { freeBytes: number; totalBytes: number } | null
  lowBytes: number
  parts: StoragePart[]
  /** Each collector's last pass, newest first. */
  collections: StorageCollection[]
  /** A measurement or a collection running now. */
  measuring: boolean
  collecting: boolean
}

export interface StoragePart {
  /** The folder's name under its root. */
  id: string
  label: string
  /** What it holds, and what keeps it from growing without end. */
  detail: string
  path: string
  /** Its files' sizes; a clone that shares blocks with another file counts in full. */
  bytes: number
  /** Whether a collector of Mako's own frees what this part no longer needs. */
  collected: boolean
}

export interface StorageCollection {
  /** The part it frees (`StoragePart.id`). */
  part: string
  at: string
  trigger: "scheduled" | "person" | "low disk"
  freedBytes: number
  /** Stores it went through, and those it left for later: running, open in a session, or written recently. */
  collected: number
  skipped: number
  ms: number
  error?: string
}
