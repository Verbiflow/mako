import type { z } from "zod"
import { type Problem, OperationNameSchema, problemType } from "./envelope.js"

/**
 * What a client may do with an operation whose answer it never got:
 * - `read` changes nothing, so running it twice is running it once;
 * - `replay` is settled by its operation id, so a repeat is answered with the first result;
 * - `never` has effects only the person can judge (a commit, a push), so it's repeated only if it never ran.
 */
export type Replay = "read" | "replay" | "never"

/** Where it runs; the operation's `target` names which Thread or which runtime. */
export type Scope = "thread" | "runtime"

export type OperationSpec = {
  scope: Scope
  replay: Replay
  input: z.ZodType
  output: z.ZodType
}

export function defineOperations<const T extends Record<string, OperationSpec>>(
  operations: T
): T {
  for (const name of Object.keys(operations))
    if (!OperationNameSchema.safeParse(name).success)
      throw new Error(
        `Operation name ${JSON.stringify(name)} isn't lowercase words joined by dots`
      )
  return operations
}

const TRANSIENT = new Set([
  "owner-unavailable",
  "unavailable",
  "restarting",
  "internal",
])

/** Whether repeating the same operation, with the same id, can't do harm and may succeed. */
export function mayRetry(replay: Replay, failure: Problem): boolean {
  if (!TRANSIENT.has(problemType(failure))) return false
  return replay !== "never" || failure.outcome === "not-applied"
}
