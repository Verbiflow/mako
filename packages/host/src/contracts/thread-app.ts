import { z } from "zod"

/**
 * A folder's running app as the desk shows it: the strip's control and the
 * app's tabs in the terminal dock. The host builds it from the recipe and
 * the app's records, so every host sharing the Thread store shows the same.
 */

export type AppPhase = "stopped" | "preparing" | "starting" | "running" | "crashed" | "waiting"

export interface AppProcessView {
  name: string
  state: "starting" | "running" | "exited" | "stopped"
  port?: number
  memoryBytes?: number
  exit?: { code: number; afterMs: number; at: number }
}

export interface AppCheckView {
  tier: "quick" | "full"
  /** Its command, or for a check of steps, each step's in order. */
  command: string
  state: "never" | "running" | "passed" | "failed"
  at?: number
  /** For a check of named steps: each step as it stands, from the run under way or the last run of it. */
  steps?: AppCheckStepView[]
}

export interface AppCheckStepView {
  name: string
  command: string
  state: "never" | "waiting" | "running" | "passed" | "failed"
  /** How long it took, once it has finished. */
  ms?: number
  /** When it finished. */
  at?: number
}

export interface AppPrepareView {
  command: string
  /** Why it runs, such as "package-lock.json changed". */
  reason: string
  /** Set when it failed, so nothing started. */
  exit?: { code: number; at: number }
}

export type SetupStep = "waiting" | "running" | "done" | "failed"

/** A setup Thread's way to a working app: its recipe saved, the app started from it, both checks passed. */
export interface SetupProgress {
  recipe: SetupStep
  app: SetupStep
  checks: SetupStep
}

export type ThreadAppView =
  | {
      kind: "none"
      project: string
      root: string
      /** The Thread whose setup turn ended before it saved a recipe; it may be asking something. */
      stopped?: { title: string; conversation: string }
    }
  | { kind: "invalid"; project: string; root: string; message: string }
  | {
      kind: "setting-up"
      project: string
      root: string
      /** The Thread setting it up: from reading the guide until its checks pass or its turn ends. */
      thread: { title: string; harness: string; conversation: string }
      /** How far it has got, from what Mako ran for that Thread. */
      progress?: SetupProgress
    }
  | {
      kind: "ready"
      project: string
      phase: AppPhase
      /** A running process's address: web first, then the first process with a port. */
      address?: { host: string; port: number }
      startedAt?: number
      processes: AppProcessView[]
      /** The full check is the target's that the view was asked about, or the first target's. */
      checks: AppCheckView[]
      /** The recipe's targets in order, when it has them: what Run can start, the first by default. */
      targets?: string[]
      prepare?: AppPrepareView
      /** Set while waiting: the other apps that stopping would free. */
      room?: { apps: number; bytes: number }
      /**
       * Set while stopped when the recipe runs one copy at a time and another
       * checkout has it: whose, in words, such as `the Thread “Fix login”`.
       * Nobody hears it until they ask to run this one.
       */
      elsewhere?: string
    }

/** A list cut at the probe's limit, with how many it left out. */
export interface Capped<T> {
  entries: T[]
  more?: number
}

/**
 * What a Thread's app touches outside its checkout and ports, from one look
 * at this Mac: what two copies of it would fight over. Its sentences are
 * written for a person and an agent alike.
 */
export interface AppProbeView {
  at: number
  /** The home folder its paths are under, to show them from `~`. */
  home: string
  running: boolean
  upSince?: number
  /** When Mako saw the app stop; what changed and was registered is counted up to then. */
  stoppedAt?: number
  /** The Thread's block of ports. */
  ports: { first: number; last: number }
  /** `fixed` is a port outside the block the system didn't pick, so a second copy would fight over it. */
  listening: { port: number; pid: number; fixed: boolean }[]
  /** Ports on this Mac it has a connection to, with who listens there. */
  connectsTo: { port: number; owner: string }[]
  connectsOutside: Capped<string>
  /** Files it holds open for writing outside its checkout and data folder. */
  writing: Capped<{ path: string; pid: number }>
  /** Processes it left that no stop ends; `sure` when they carry the app's mark, not only work in its folders. */
  leftovers: { pid: number; command: string; sure: boolean }[]
  /**
   * Its running containers: those Compose ran in its checkout or that mount
   * a folder of it. `fixed` is a published port outside the Thread's block.
   * Missing when no container runtime answered.
   */
  containers?: { name: string; image: string; bytes?: number; ports: { port: number; fixed: boolean }[] }[]
  /** Folders where apps keep state with something changed since it came up, with who had files open there. */
  changed: Capped<{ folder: string; paths: string[]; more: boolean; who: string }>
  /** `history`: read from the file system's history, any depth. `times`: modification times one or two levels down. */
  changedBy: "history" | "times"
  /** What was registered with macOS while it ran: launchd services and agents, URL schemes, login items; each detail says whether it points into the app. */
  registered: { kind: "service" | "launch-agent" | "url-handler" | "url-scheme" | "login-item"; name: string; detail: string }[]
  notes: string[]
}

/** A checkout's app as the sidebar marks it. A stopped app has no mark. */
export interface AppMark {
  checkout: string
  state: "running" | "starting" | "waiting" | "crashed"
  /** Where its first process listens, while it runs. */
  port?: number
}

/** An app running or waiting for memory on this Mac, as the Room lists it. */
export interface RoomApp {
  /** What `stopApps` takes. */
  app: string
  /** A Worktree Thread's checkout, a folder someone opened, or a spare checkout installing ahead of a Thread. */
  kind: "thread" | "folder" | "spare"
  state: AppMark["state"]
  checkout?: string
  /** The project's main checkout and name. */
  project?: { root: string; name: string }
  thread?: { id: string; title: string }
  /** What runs: process names, "install", or a check's tier. */
  runs: string[]
  port?: number
  /** Its processes' physical footprint at the last look, and its containers'. */
  memoryBytes?: number
  /** What its containers hold, inside `memoryBytes`. */
  containerBytes?: number
  /** It starts containers none of which Mako could read, so their memory isn't counted. */
  containers?: true
  upAt?: number
  usedAt?: number
  waitingSince?: number
}

/** Runs of a project's app that stayed up a minute before Mako says how many copies fit. */
export const FIT_RUNS = 3

/** How many copies of a project's app fit in memory, from its earlier runs. */
export interface RoomFit {
  root: string
  name: string
  estimate:
    /** Fewer than `FIT_RUNS` runs stayed up a minute. */
    | { kind: "learning"; runs: number }
    /** Its runs start containers Mako couldn't read, so their memory isn't counted. */
    | { kind: "containers" }
    /**
     * `peakBytes` is the median of its runs' peaks, `containerBytes` the part
     * its containers held; `atOnce` counts the copies running and as many more
     * as free memory holds, when Mako can read that, or as many as the
     * container runtime's machine holds when that is fewer (`limitedBy`).
     */
    | { kind: "ready"; runs: number; peakBytes: number; containerBytes?: number; running: number; atOnce?: number; limitedBy?: "containers" }
}

export interface RoomView {
  at: number
  pressure: "normal" | "warning" | "critical"
  freeBytes?: number
  totalBytes?: number
  /** The container runtime's machine: what it can give containers in all, and what every running container holds. */
  containerRuntime?: { totalBytes: number; usedBytes: number }
  apps: RoomApp[]
  /** Projects with an app listed. */
  fits: RoomFit[]
  marks: AppMark[]
}

/** One output the dock can show: the install step, a process, a check, or one step of a check. */
export type AppOutputKey = "prepare" | `process:${string}` | `check:${"quick" | "full"}` | `check:${"quick" | "full"}:${string}`

export const AppOutputKeySchema = z.union([
  z.literal("prepare"),
  z.templateLiteral(["process:", z.string().regex(/^[a-z][a-z0-9-]*$/)]),
  z.literal("check:quick"),
  z.literal("check:full"),
  z.templateLiteral(["check:", z.enum(["quick", "full"]), ":", z.string().regex(/^[a-z][a-z0-9-]*$/)]),
])

/** Where a read of an output left off: the log file it read, and how far. */
export interface AppOutputCursor {
  file: string
  offset: number
}

/** What a person should hear about an action: nothing when the view says it all. */
export interface AppActionOutcome {
  problems: string[]
}

export interface AppOutputChunk {
  text: string
  cursor: AppOutputCursor
  /** The output started over (a new run), so what was shown before goes. */
  reset: boolean
}
