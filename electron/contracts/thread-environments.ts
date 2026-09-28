import type { ThreadId } from "./thread-identity.js"

/** What a device holds for one Thread: its hostname and the first of its ports. */
export interface ThreadEnvironmentValues {
  thread: ThreadId
  /** A `.localhost` name: every such name reaches this machine, and each keeps its own cookies. */
  host: string
  port: number
  usedAt: number
}

/** A Thread's values as its agents receive them. */
export interface ThreadEnvironment extends Omit<ThreadEnvironmentValues, "usedAt"> {
  /** `THREAD_PORT_COUNT` ports from `port`. */
  ports: number
  /** Private to the Thread and kept for its life; outside the checkout, so Git never sees it. */
  dataDir: string
  /** The project recipe's names for these values, such as `PORT`, resolved for this Thread. */
  values?: Record<string, string>
  recipe?: ThreadRecipeSummary
}

export interface ThreadRecipeProcess {
  name: string
  port?: number
}

export type ThreadRecipeSummary =
  | { kind: "none" }
  | { kind: "ready"; processes: ThreadRecipeProcess[]; checks: string[] }
  | { kind: "invalid"; message: string }

export const THREAD_PORT_COUNT = 10
/** Below both macOS's (49152) and Linux's (32768) ephemeral ranges, so the system never hands these out. */
export const THREAD_PORT_FIRST = 20_000
export const THREAD_PORT_LAST = 32_759
export const THREAD_HOST_SUFFIX = ".thread.localhost"
