/**
 * How every client (a Mac's window, a phone, a tablet, a laptop's browser) reads a Thread's Sessions: when the person
 * last worked in each, how each stands, and when a send to the one on screen asks first. A message goes to the Session
 * the person has open; nothing here picks another for them.
 *
 * "When the person last worked in it" is their last message to it, from any device (`promptedAt`), never when its
 * journal was last written: opening a conversation on another device rewrites its journal, so an old fork read on a
 * phone at noon would otherwise look like the newest Session at one. On 2026-11-01 a phone opened a Thread on its first
 * listed Session, a Cursor fork last sent a message twenty days earlier, while its newest was between turns; its tabs
 * said only "Cursor" for both, and a "Please continue" sent there ran 255 tool calls in the fork.
 */

/** How a Session stands as its owner lists it: at work, waiting on the person, failed, moving, or ready. */
export type SessionState = "working" | "waiting" | "failed" | "moving" | "idle"

/** How a Session stands as a person reads it beside its name: `asleep` is ready and not worked in for a day. */
export type SessionStanding = SessionState | "asleep"

/** What every client knows of a Session, whichever list it came from. */
export interface SessionFacts {
  /** Mako's Session ID. */
  id: string
  harness: string
  /** Its harness's own title for it, never its Thread's. */
  title?: string
  state: SessionState
  createdAt: number
  /** When the person last sent it a message, from any device (`ReportedSession.promptedAt`). */
  promptedAt?: number
  /**
   * When its harness last wrote it, for a session Mako hasn't opened (a terminal's): its harness's own file, which
   * nobody's reading rewrites, and it holds no message of the person's that Mako saw.
   */
  harnessWroteAt?: number
  /** Its device can't be reached: nothing there runs or answers. */
  quiet?: boolean
  /** It began as a fork of another Session. */
  fork?: boolean
  /** The Session it was forked from, when its list says. */
  forkOf?: string
}

/** Ready and not worked in for longer than this, a Session is asleep: its harness long hibernated, its context old. */
export const ASLEEP_AFTER_MS = 24 * 60 * 60_000

/** When the person last worked in a Session: their last message, else its harness's last write, else its start. */
export function lastWorked(facts: Pick<SessionFacts, "promptedAt" | "harnessWroteAt" | "createdAt">): number {
  return facts.promptedAt ?? facts.harnessWroteAt ?? facts.createdAt
}

/** How a Session stands now. A quiet device's Sessions are never at work or waiting (`QUIET_STATUS`). */
export function sessionStanding(facts: SessionFacts, now: number): SessionStanding {
  const state = facts.quiet && (facts.state === "working" || facts.state === "waiting") ? "idle" : facts.state
  return state === "idle" && now - lastWorked(facts) > ASLEEP_AFTER_MS ? "asleep" : state
}

/** Newest first, by when the person last worked in each; between equals, the later start first. */
export function byLastWorked<T extends SessionFacts>(sessions: readonly T[]): T[] {
  return [...sessions].sort((left, right) => lastWorked(right) - lastWorked(left) || right.createdAt - left.createdAt)
}

/**
 * How the Session on screen got there: the person picked it here (its tab, its row, a link naming it, "Send here"),
 * or the screen opened on it by itself (a Thread's row with nothing of theirs to go on, an address naming none).
 */
export type OpenedBy = "person" | "screen"

/**
 * Whether a message to `target` asks first, and the Session to offer instead: the screen opened on `target` by itself,
 * it's resting (ready, or its last turn failed), not worked in for a day, and the person has worked in another Session
 * of its Thread since. One the person picked never asks: that is where they meant it to go. Undefined when it goes
 * without asking.
 */
export function staleTarget<T extends SessionFacts>(target: SessionFacts, sessions: readonly T[], now: number, openedBy: OpenedBy): T | undefined {
  if (openedBy === "person") return undefined
  const resting = target.state === "idle" || target.state === "failed" || (target.quiet === true && target.state !== "moving")
  if (!resting || now - lastWorked(target) <= ASLEEP_AFTER_MS) return undefined
  const newest = byLastWorked(sessions.filter((session) => session.id !== target.id))[0]
  return newest && lastWorked(newest) > lastWorked(target) ? newest : undefined
}
