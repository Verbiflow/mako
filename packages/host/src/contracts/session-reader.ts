/** Who served a host's session list: the user's login daemon, the shared on-demand reader, or the host's own worker. */
export type SessionReaderKind = "process" | "shared" | "worker"

/**
 * One thing that happened to the reader serving a host (`threads/reader-history.ts`):
 * - `adopted`: a reader began serving it.
 * - `lost`: the reader serving it went away; `reason` is what the host saw
 *   (the socket closed, an error, an exit code, memory).
 * - `exited`: a reader this host started exited, with its code or signal; a
 *   reader can't log its own SIGKILL or out-of-memory abort.
 * - `retired`: this host retired a reader from another build.
 * - `unavailable`: no shared reader could be joined (it didn't answer, or failed to start).
 */
export interface SessionReaderEvent {
  /** ISO time. */
  at: string
  event: "adopted" | "lost" | "exited" | "retired" | "unavailable"
  kind: SessionReaderKind
  reason?: string
  pid?: number
}

/** What Settings › Diagnostics shows of the session reader. */
export interface SessionReaderHistory {
  /** When this host started counting (ISO): it keeps no history across restarts. */
  since: string
  /** How many times a reader serving this host was lost since `since`. */
  lost: number
  /** The newest events first, at most `READER_EVENTS_KEPT`. */
  events: SessionReaderEvent[]
  /** The shared reader's own log (`~/.mako/logs/syncd.log`), or "" while it has none. */
  logPath: string
}
