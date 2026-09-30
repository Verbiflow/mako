import { z } from "zod"
import type { ThreadId } from "./thread-identity.js"

/**
 * Whose running app a set of values belongs to: one per folder, since two
 * apps on the same files would fight over their build output and data. A
 * Worktree Thread's app is keyed by the Thread's ID, and Threads sharing
 * any other folder share `folder-<digest of its path>`.
 */
export const AppKeySchema = z.string()
  .regex(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|folder-[0-9a-f]{16})$/, "not an app key")
  .brand<"AppKey">()
export type AppKey = z.infer<typeof AppKeySchema>

/** What a device holds for one app: its hostname and the first of its ports. */
export interface ThreadEnvironmentValues {
  app: AppKey
  /** A `.localhost` name: every such name reaches this machine, and each keeps its own cookies. */
  host: string
  port: number
  usedAt: number
}

/** A Thread's values as its agents receive them: its folder's app's. */
export interface ThreadEnvironment extends Omit<ThreadEnvironmentValues, "usedAt"> {
  /** The agent's own Thread; every Thread in the app's folder shares its values. Absent for an app a person runs from the desk. */
  thread?: ThreadId
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

/** What starts a setup Session; the guide itself comes from `environment_guide`, so it's the same for every agent. */
export const ENVIRONMENT_SETUP_PROMPT = `Set this project up so every Thread can run and check its own copy of the app at the same time as the others. Call the environment_guide tool first and follow it.`

/** What starts a repair Session for a recipe Mako can't use. */
export function environmentRepairPrompt(problem: string): string {
  return `Mako can't run this project's app because its recipe is broken: ${problem}\n\nFix the recipe so every Thread can run and check its own copy again. Call the environment_guide tool first and follow it.`
}

export const THREAD_PORT_COUNT = 10
/** Below both macOS's (49152) and Linux's (32768) ephemeral ranges, so the system never hands these out. */
export const THREAD_PORT_FIRST = 20_000
export const THREAD_PORT_LAST = 32_759
export const THREAD_HOST_SUFFIX = ".thread.localhost"
