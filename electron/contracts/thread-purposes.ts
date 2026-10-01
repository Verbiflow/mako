/**
 * What Mako started a Thread for, when it started one for a job of its own
 * rather than for something a person typed. It is recorded once, as the
 * Thread starts, and never read back from the transcript.
 */
export type ThreadPurposeKind = "setup"

export interface ThreadPurpose {
  thread: string
  kind: ThreadPurposeKind
  /** The project folder the Thread was started for. */
  project: string
  createdAt: number
}

/** What a host start records for a new Thread. */
export type StartPurpose = Pick<ThreadPurpose, "kind" | "project">
