import type { ThreadId } from "./thread-identity.js"

/**
 * Disposable scratch is removed by default once its Thread is archived, is a Fin that finished, or finished and stayed
 * quiet `idleDays`; Thread data stays preview until the person enables it.
 */
export interface ThreadScratchSettings {
  mode: "preview" | "remove"
  /** Separate consent: an existing scratch-removal setting never opts Thread data into removal. */
  dataMode?: "preview" | "remove"
  idleDays: number
  kept: ThreadId[]
}

export interface ThreadScratchEntry {
  kind: "scratch" | "data"
  thread: ThreadId
  title?: string
  path: string
  generation?: string
  retainedPath?: string
  privateBytes: number | null
  usedAt?: number
  reason: string
  eligible: boolean
  /** `now` when eligible; `approve` when only a waiting period or an open ancestor keeps it; `keep` otherwise. */
  class?: "now" | "approve" | "keep"
  removed?: boolean
}

export interface ThreadScratchReport {
  settings: ThreadScratchSettings
  at: number
  everyMs: number
  entries: ThreadScratchEntry[]
}
