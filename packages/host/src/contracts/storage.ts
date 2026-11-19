/**
 * The disk's low line: 5% of it, at least 15 GB and at most 30 GB. Under it Mako frees what is expendable, oldest
 * first, and says what it freed; still under it, Mako warns. On 2026-11-19 a 926 GB Mac reached 15 GB free with 140 GB
 * of finished Threads' scratch, worktrees and rewind checkpoints nothing read.
 */
export const STORAGE_LOW_BYTES = 15 * 1024 ** 3
export const STORAGE_LOW_MAX_BYTES = 30 * 1024 ** 3
export const STORAGE_LOW_SHARE = 0.05

export function storageLowBytes(totalBytes: number): number {
  return Math.min(STORAGE_LOW_MAX_BYTES, Math.max(STORAGE_LOW_BYTES, Math.round(totalBytes * STORAGE_LOW_SHARE)))
}

/**
 * How expendable a folder is. `now`: its Thread is archived or finished and quiet, nothing reads it and it holds no
 * uncommitted work, so Mako removes it on its own (on its schedule, or when the disk runs low). `approve`: nothing
 * reads it, but it goes only when the person says so (a finished Thread not yet archived, a folder's shared app
 * data). `keep`: in use, holding work, or of an owner Mako can't read.
 */
export type ReclaimClass = "now" | "approve" | "keep"
export type ReclaimStore = "scratch" | "thread-data" | "app-data" | "worktrees" | "snapshots"

export interface ReclaimItem {
  /** `<store>:<path>`, stable between a preview and the removal it authorises. */
  id: string
  store: ReclaimStore
  path: string
  /** The Thread's title, or what the folder is. */
  label: string
  thread?: string
  /** The project a worktree or a folder's app data belongs to, by its folder's name. */
  project?: string
  /** What it is made of, where that isn't the whole folder: a Thread's app data without its registered scratch. */
  parts?: string[]
  /** Allocated bytes; a clone sharing blocks with another file counts in full. Null until measured. */
  bytes: number | null
  /** When it, or its Thread, was last used. */
  usedAt?: number
  class: ReclaimClass
  reason: string
}

export interface ReclaimPlan {
  at: string
  items: ReclaimItem[]
}

export interface ReclaimOutcome {
  at: string
  trigger: "person" | "low disk"
  /** What the person agreed to, or `now` for Mako's own pass. */
  consent: "now" | "approve"
  /** Measured as the disk's free space before and after, so a clone's shared blocks don't count. */
  freedBytes: number
  removed: ReclaimItem[]
  /** Items asked for that a fresh look kept, each with why. */
  kept: ReclaimItem[]
}

/** The person's switch for the low-disk pass, kept in `<user root>/storage-budget.json`. */
export interface StorageBudgetSettings {
  autoFree: boolean
}

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
  /** What each store could give back, from the last preview; null until one ran. */
  plan: ReclaimPlan | null
  planning: boolean
  /** A removal the person asked for, or the low-disk pass, running now. */
  reclaiming: boolean
  /** The latest removals, newest first. */
  reclaims: ReclaimOutcome[]
  budget: StorageBudgetSettings
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
