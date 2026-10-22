import { createWriteStream, existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema } from "@mako/protocol/moves"
import type { InstalledReading } from "@mako/sessions/record-writers"
import { RecordHoldingsSchema, type ReceivedRecords, type ReceivingSession, type RecordsLink } from "@mako/sessions/record-sync"
import { hostLog } from "../base/host-log.js"
import { applyMoveCheckpoint } from "../workspaces/index.js"

/**
 * A Thread arriving on a cloud machine from a device, before anything runs: its checkout applied to the machine's
 * clone, which its agent made at the device's own path, and each Session's native records written into its
 * harness's store here, so each harness resumes the same session. Nothing is started; the device asks the cloud to
 * claim the move once this answers, and only then starts the Sessions here.
 *
 * Asked again for the same move, it answers what it did without doing it again: a mark in the clone's Git folder
 * says the move arrived, so a repeat can never write the checkout over what an agent has done here since.
 */
export const MoveArrivalInputSchema = z.object({
  move: z.uuid(),
  folder: z.string().min(1),
  checkpoint: MoveCheckpointSchema,
  /** `holdings`: what the device pushed of each session, which the machine holds at least before it writes any of it. */
  sessions: z.array(z.object({ harness: z.string().min(1), nativeId: z.string().min(1), holdings: RecordHoldingsSchema.optional() })).min(1),
}).strict()
export type MoveArrivalInput = z.infer<typeof MoveArrivalInputSchema>

export type MoveArrival = {
  /** `applied` now, or `arrived` before (the move's mark was there). */
  checkout: "applied" | "arrived"
  sessions: Array<{ harness: string; nativeId: string; restored: "restored" | "present"; path: string }>
  ms: number
}

export type MoveArrivalDeps = {
  git: Git
  /** The machine's link to its Thread's records at the gateway, while it has one. */
  records(): RecordsLink | undefined
  /** The folder this machine's agent made the clone at. */
  workspace(): string | undefined
  receive(link: RecordsLink, sessions: ReceivingSession[], installed: Record<string, InstalledReading | null>): Promise<ReceivedRecords[]>
  installed(harness: string): InstalledReading | null
  /** A folder of this host's own for the checkpoint while it's applied. */
  scratch: string
}

const ArrivedMarkSchema = z.object({ move: z.uuid(), sha256: z.string(), at: z.number() })

export async function arriveMove(deps: MoveArrivalDeps, input: MoveArrivalInput): Promise<MoveArrival> {
  const began = performance.now()
  const link = deps.records()
  if (!link) throw new Error("This host isn't a cloud machine's: no Thread's records are linked here.")
  const workspace = deps.workspace()
  if (workspace !== input.folder) throw new Error(`This machine's folder is ${workspace ?? "not made"}, not the move's ${input.folder}.`)
  const gitDir = (await deps.git.output(input.folder, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim()
  const mark = join(gitDir, `mako-move-${input.move}.json`)
  let checkout: MoveArrival["checkout"] = "arrived"
  if (!existsSync(mark)) {
    await mkdir(deps.scratch, { recursive: true })
    const scratch = await mkdtemp(join(deps.scratch, "move-"))
    try {
      const file = join(scratch, "checkpoint.bundle")
      const response = await fetch(`${link.base}/checkpoints/${input.checkpoint.sha256}`, { headers: { authorization: link.authorization }, signal: AbortSignal.timeout(10 * 60_000) })
      if (!response.ok || !response.body) throw new Error(`The move's checkout couldn't be read from the cloud: ${response.status}`)
      await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
      await applyMoveCheckpoint(deps.git, input.folder, file, input.checkpoint)
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    await writeFile(mark, JSON.stringify(ArrivedMarkSchema.parse({ move: input.move, sha256: input.checkpoint.sha256, at: Date.now() })))
    checkout = "applied"
  }
  const installed: Record<string, InstalledReading | null> = {}
  for (const session of input.sessions) installed[session.harness] = deps.installed(session.harness)
  const received = await deps.receive(link, input.sessions, installed)
  const sessions: MoveArrival["sessions"] = []
  for (const each of received) {
    const restored = each.restored
    if (restored.kind === "restored" || restored.kind === "present") sessions.push({ harness: each.harness, nativeId: each.nativeId, restored: restored.kind, path: restored.path })
    else if (restored.kind === "outdated") throw new Error(`${each.harness} here is older than the version that wrote this session, so it can't resume it.`)
    else if (restored.kind === "forked") throw new Error(`${each.harness} here already held another copy of this session.`)
    else throw new Error(restored.reason)
  }
  const ms = Math.round(performance.now() - began)
  hostLog("moves", "a Thread arrived from a device", { move: input.move, folder: input.folder, checkout, sessions: sessions.length, ms })
  return { checkout, sessions, ms }
}
