import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { withFileLock } from "../base/file-lock.js"
import { publishFile } from "../base/published-files.js"
import type { AutomationFired } from "../contracts/automations-usage-updates.js"

const ResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("started") }),
  z.object({ status: z.literal("completed") }),
  z.object({ status: z.literal("not-run"), why: z.string() }),
  z.object({ status: z.literal("unknown"), error: z.string() }),
])
const ReceiptSchema = z.object({ cwd: z.string(), id: z.string(), result: ResultSchema })

export const UNKNOWN_AUTOMATION_LAUNCH = "Mako can't confirm whether this automation started. Check its Threads before asking for a new run. This answer won't launch it again."

/** Only a launch's preflight may say it certainly started nothing. Other exceptions leave its effect uncertain. */
export class AutomationNotStartedError extends Error {}

/** An approved run's durable admission and outcome, under the same identity after a host dies. */
export class AutomationLaunches {
  private readonly folder: string

  constructor(folder: string) { this.folder = folder }

  async run(operation: string, owner: { cwd: string; id: string }, launch: () => Promise<AutomationFired>): Promise<AutomationFired> {
    const path = join(this.folder, `${createHash("sha256").update(operation).digest("hex")}.json`)
    // The OS releases the lock on death; the saved started state then forbids a second launch.
    return withFileLock(`${path}.lock`, async () => {
      let previous: z.infer<typeof ReceiptSchema> | undefined
      try { previous = ReceiptSchema.parse(JSON.parse(await readFile(path, "utf8"))) }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error }
      if (previous) {
        if (previous.cwd !== owner.cwd || previous.id !== owner.id) return { status: "not-run", why: "That approval belongs to another automation or workspace." }
        if (previous.result.status === "completed") return previous.result
        if (previous.result.status !== "not-run") return { status: "unknown", error: UNKNOWN_AUTOMATION_LAUNCH }
      }
      const save = (result: z.infer<typeof ResultSchema>) => publishFile(path, JSON.stringify({ ...owner, result }), { mode: 0o600, dirMode: 0o700 })
      await save({ status: "started" })
      let result: AutomationFired
      try { result = await launch() }
      catch { result = { status: "unknown", error: UNKNOWN_AUTOMATION_LAUNCH } }
      // A generic failed launch does not prove no conversation was created before it failed.
      const kept = result.status === "failed" ? { status: "unknown" as const, error: UNKNOWN_AUTOMATION_LAUNCH } : result
      await save(kept)
      return kept
    })
  }
}
