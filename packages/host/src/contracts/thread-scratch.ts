import type { ThreadId } from "./thread-identity.js"

/** Preview is the default; enabling removal is the person's choice. */
export interface ThreadScratchSettings {
  mode: "preview" | "remove"
  idleDays: number
  kept: ThreadId[]
}

export interface ThreadScratchEntry {
  thread: ThreadId
  title?: string
  path: string
  generation?: string
  retainedPath?: string
  privateBytes: number | null
  usedAt?: number
  reason: string
  eligible: boolean
  removed?: boolean
}

export interface ThreadScratchReport {
  settings: ThreadScratchSettings
  at: number
  everyMs: number
  entries: ThreadScratchEntry[]
}
