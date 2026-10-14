/**
 * What a Thread changed, from the attribution journal: "changes made",
 * shown beside what it spent. Each file counts once, at its latest change.
 */
export interface ThreadChangeSummary {
  files: { created: number; changed: number; deleted: number; renamed: number }
  /** Lines added and removed by its changes, summed over every change it made. */
  lines: { added: number; removed: number }
  /** Commands its tool calls ran, as its harness reported them. */
  commands: number
  /**
   * Paths outside its checkouts it touched, counted rather than listed:
   * `named` its calls named; `maybe` only changed while it ran, so another
   * app could have, which on a busy Mac is most of them.
   */
  outside: { named: number; maybe: number }
  /** Changes that might be its too: several Threads ran at once. */
  maybe: number
}

/** A version of a file the journal still keeps, which the file on disk no longer has. */
export interface LostVersion {
  /** The journal's root and entry, which restore it. */
  root: string
  entry: number
  /** Absolute. */
  path: string
  /** When the journal saw it. */
  at: number
  size?: number
  /** The Thread that wrote it, when one is named; otherwise who did, in a word. */
  thread?: string
  by: "thread" | "person" | "mako" | "unknown"
}
