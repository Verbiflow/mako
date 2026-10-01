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
  command: string
  state: "never" | "running" | "passed" | "failed"
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
      /** Once the folder's app has ports of its own; before its first start it has none. */
      address?: { host: string; port: number }
      startedAt?: number
      processes: AppProcessView[]
      checks: AppCheckView[]
      prepare?: AppPrepareView
      /** Set while waiting: the other apps that stopping would free. */
      room?: { apps: number; bytes: number }
      /**
       * Set while stopped when the recipe runs one copy at a time and another
       * checkout has it: whose, in words, such as `the Thread “Fix login”`.
       * Nobody hears it until they ask to run this one.
       */
      elsewhere?: string
      /** The recipe names credentials files the person hasn't allowed new Threads to have yet. */
      credentialsWaiting?: boolean
    }

/** A checkout's app as the sidebar marks it. A stopped app has no mark. */
export interface AppMark {
  checkout: string
  state: "running" | "starting" | "waiting" | "crashed"
  /** Where its first process listens, while it runs. */
  port?: number
}

/** One output the dock can show: the install step, a process, or a check. */
export type AppOutputKey = "prepare" | `process:${string}` | `check:${"quick" | "full"}`

export const AppOutputKeySchema = z.union([
  z.literal("prepare"),
  z.templateLiteral(["process:", z.string().regex(/^[a-z][a-z0-9-]*$/)]),
  z.literal("check:quick"),
  z.literal("check:full"),
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
