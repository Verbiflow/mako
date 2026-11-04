import { z } from "zod"

/**
 * macOS's file-change service (fseventsd) as this host reads it: how late
 * its watcher child's canary hears beats, and how much memory the daemon
 * holds, from `ps`, without root. Healthy, a beat arrives in tens of
 * milliseconds and the daemon holds a few megabytes. fseventsd has been seen
 * degraded after a month up, holding 24 GB and delivering every app's events
 * 2.6 s late at the median, until a restart brought it back to 11.5 ms. That
 * is a fault, not a busy Mac: Mako says so and offers the restart.
 */

/**
 * A canary's median beat later than this, over `LAG_BEATS` (five minutes at
 * the 10 s beat, `LAG_BEATS_NEEDED` at least), is degraded. Healthy beats
 * take 13 to 60 ms on a quiet Mac, and a few hundred on a busy one: 257 ms
 * was seen from a healthy 11 MB daemon just after a restart. The degraded
 * daemon this is for was 2.6 s late at the median, for days.
 */
export const DEGRADED_LAG_MS = 1_000
export const LAG_BEATS = 30
export const LAG_BEATS_NEEDED = 18
/** A canary unheard this long is degraded too; shorter silences are the watcher's own to answer. */
export const DEGRADED_SILENCE_MS = 3 * 60_000
/** Resident memory past this is degraded: healthy, fseventsd holds under 50 MB. */
export const DEGRADED_MEMORY_BYTES = 1024 ** 3
/** Readings of memory over the threshold in a row, a minute apart, before it's said. */
export const MEMORY_READINGS_NEEDED = 2
/** After fseventsd starts over, its lag isn't judged for this long: only its memory is. */
export const SETTLE_MS = 10 * 60_000
/** Healthy this long ends a degraded episode; a degradation within it is the same one, never said again. */
export const EPISODE_GAP_MS = 30 * 60_000
/** A snoozed notice comes back early only for a reading this many times worse, or a new reason. */
export const WORSE_BY = 2
/** How often the rolling history keeps a sample. */
export const SAMPLE_EVERY_MS = 15 * 60_000

export const FileEventsStateSchema = z.enum(["healthy", "degraded", "unknown"])
export type FileEventsState = z.infer<typeof FileEventsStateSchema>

/** What Mako was doing around a sample, to line a degradation's start up with. */
export const FileEventsContextSchema = z.object({
  /** Folders Mako watches, and the FSEvents streams they take. */
  watched: z.number().int().nonnegative(),
  streams: z.number().int().nonnegative(),
  /** Watcher-child starts and history reads since the sample before. */
  childStarts: z.number().int().nonnegative(),
  historyReads: z.number().int().nonnegative(),
  /** Agents' turns running when the sample was taken. */
  turnsRunning: z.number().int().nonnegative(),
  /** Wakes from sleep since the sample before. */
  wakes: z.number().int().nonnegative(),
})
export type FileEventsContext = z.infer<typeof FileEventsContextSchema>

/** One sample of the rolling history, every `SAMPLE_EVERY_MS` and at each change of state or daemon, a line each in the host's file. */
export const FileEventsSampleSchema = z.object({
  at: z.number(),
  /** The daemon's process id: a new one means it started over. */
  pid: z.number().int().positive().optional(),
  residentBytes: z.number().nonnegative().optional(),
  /** The median of the canary's recent beats, and how many it was taken over. */
  lagMs: z.number().nonnegative().optional(),
  beats: z.number().int().nonnegative(),
  state: FileEventsStateSchema,
  /** Why this sample was taken out of turn: the state changed, or the daemon started over. */
  why: z.enum(["state", "restarted"]).optional(),
  context: FileEventsContextSchema.optional(),
})
export type FileEventsSample = z.infer<typeof FileEventsSampleSchema>

/**
 * A step of Mako's restart, said as it goes: `restarting` from the password
 * dialog through the evidence and the restart, which run as one privileged
 * step, then `measuring` delivery again.
 */
export type FileEventsRestartStep = "restarting" | "measuring"

export interface FileEventsMeasure {
  lagMs?: number
  residentBytes?: number
}

/** How the last restart through Mako went. */
export interface FileEventsRestart {
  at: number
  outcome: "restarted" | "cancelled" | "failed"
  message?: string
  before: FileEventsMeasure
  after?: FileEventsMeasure
  /** The folder in Mako's diagnostics holding the evidence captured before the restart. */
  evidence?: string
  /** Whether a change written just before the restart was still in the history after it. */
  historyKept?: boolean
}

/** `mako:file-events-service` and the window-wide `file-events-service` event. */
export interface FileEventsService {
  /** `unknown` off macOS, and until the first readings are in. */
  state: FileEventsState
  /** While degraded: since when, and which readings say so. */
  degraded?: { since: number; lag: boolean; memory: boolean }
  /** The median of the canary's last beats, the slowest of them, and how many. */
  lagMs?: number
  slowestMs?: number
  beats: number
  /** The canary went unheard: how long since it was last heard. */
  silentMs?: number
  pid?: number
  residentBytes?: number
  /** When memory was last read. */
  readAt?: number
  /** The rolling history, oldest first: a day of samples at most. */
  history: FileEventsSample[]
  /** A restart under way, by step. */
  restarting?: FileEventsRestartStep
  /** The last restart's outcome; `seen` once the person closed its notice. */
  restart?: FileEventsRestart & { seen?: boolean }
  /** Whether the desk says it's degraded now: once an episode, and not while "Not now" holds unless it got worse. */
  notice: boolean
  /** "Not now" holds until then, the end of the day it was pressed. */
  snoozedUntil?: number
  /** Just restarted: lag isn't judged until then. */
  settlingUntil?: number
  /** This Mac is busy with other work, so a late canary says nothing about fseventsd. */
  busy?: boolean
}
