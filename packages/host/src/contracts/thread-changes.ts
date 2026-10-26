/**
 * What a Thread changed, from the attribution journal: "changes made",
 * shown beside what it spent. The sum of its turns' summaries
 * (`TurnChanges`), the same records the line under each answer draws: its
 * own changes only, each file once at what its turns did to it in all.
 */
export interface ThreadChangeSummary {
  files: { created: number; changed: number; deleted: number; renamed: number }
  /** Net lines its turns added and removed, summed over its turns. */
  lines: { added: number; removed: number }
  /** Commands its tool calls ran, as its harness reported them. */
  commands: number
  /**
   * Paths outside its checkouts it touched, counted rather than listed:
   * `named` its calls named; `maybe` only changed while it ran, so another
   * app could have, which on a busy Mac is most of them.
   */
  outside: { named: number; maybe: number }
  /** Files that might be its too, never counted in `files`: changed while it ran with nothing tying them to it. */
  maybe: number
}

/** Files changed, each counted once per project, and lines summed over every change. */
export interface ChangeTotals {
  files: number
  added: number
  removed: number
  /** Threads that changed something. */
  threads: number
}

/**
 * What agents changed on this device over the journal's window, for
 * Settings › Usage: by project, how surely Mako told whose each change was,
 * and how often the person corrected a move.
 */
export interface ChangeUsage {
  /** The journal keeps this many days. */
  days: number
  total: ChangeTotals
  /** Largest first; `path` is the repository's folder. */
  projects: (ChangeTotals & { path: string })[]
  /** Every change journaled in the window, by how its writer was known. */
  certainty: { exact: number; named: number; window: number; ambiguous: number; person: number; mako: number }
  /**
   * Moves into worktrees, and what the person changed of them. `guessed`
   * files came on timing alone; `putBack` went back, so were wrong;
   * `offered` stayed because Mako couldn't tell; `brought` of those the
   * person brought, so Mako missed them.
   */
  moves: { moves: number; came: number; guessed: number; putBack: number; offered: number; brought: number }
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
