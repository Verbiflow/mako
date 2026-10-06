import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { cursorSdkAgentDirectory } from "@mako/sessions/cursor-sdk-paths"
import { processIdentityMatches } from "../../process-liveness.js"

/**
 * Which Mako child is executing an agent's run, kept beside Cursor's SDK state.
 *
 * The SDK's local store marks a run active until the process executing it
 * ends it, and never expires that mark: a child killed mid-run (a crashed or
 * killed host, the next host reaping its orphans, memory pressure) leaves the
 * agent refusing every later message with "already has active run". The
 * child that starts a run writes this record and removes it when the run
 * ends, so it outlives every host and child that saw the run. A later child
 * expires the run only when the process recorded here is proved gone and the
 * run is still the agent's active one, so a run another executor started,
 * or one a live child is still executing, is never taken.
 */
const RunRecordSchema = z.object({
  runId: z.string(),
  pid: z.number().int().positive(),
  /** The child's own start, as wall-clock milliseconds. */
  startedAt: z.number(),
})
export type CursorRunRecord = z.infer<typeof RunRecordSchema>

/** `ps` start times are whole seconds, and Node's time origin follows exec by its bootstrap. */
const START_TOLERANCE_MS = 5_000

export function cursorRunRecordPath(stateRoot: string, agentId: string): string {
  return join(stateRoot, "mako-runs", `${basename(cursorSdkAgentDirectory(stateRoot, agentId))}.json`)
}

function read(path: string): CursorRunRecord | undefined {
  try {
    const parsed = RunRecordSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

/** Why the record could not be written, if it could not. */
export function recordCursorRun(stateRoot: string, agentId: string, record: CursorRunRecord): string | undefined {
  const path = cursorRunRecordPath(stateRoot, agentId)
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    const draft = `${path}.${process.pid}.tmp`
    writeFileSync(draft, JSON.stringify(record), { mode: 0o600 })
    renameSync(draft, path)
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** The run ended: nothing is left for a later child to expire. */
export function settleCursorRun(stateRoot: string, agentId: string, runId: string): void {
  const path = cursorRunRecordPath(stateRoot, agentId)
  if (read(path)?.runId === runId) rmSync(path, { force: true })
}

export type CursorRunOwnerGone = (record: CursorRunRecord) => Promise<boolean>

/** Proved gone, never presumed: a start time that cannot be read keeps the run. */
export const cursorRunOwnerGone: CursorRunOwnerGone = async (record) => {
  try {
    return !(await processIdentityMatches({ pid: record.pid, startedAt: record.startedAt, signal: AbortSignal.timeout(3_000), toleranceMs: START_TOLERANCE_MS }))
  } catch {
    return false
  }
}

/** The run the record names, once the child that was executing it is gone. */
export async function lostCursorRun(stateRoot: string, agentId: string, gone: CursorRunOwnerGone = cursorRunOwnerGone): Promise<string | undefined> {
  const record = read(cursorRunRecordPath(stateRoot, agentId))
  if (!record || !(await gone(record))) return undefined
  return record.runId
}
