import { createWriteStream, existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fetch as fetchWith } from "undici"
import { z } from "zod"
import type { Git } from "@mako/git"
import { MoveCheckpointSchema } from "@mako/protocol/moves"
import type { InstalledReading } from "@mako/sessions/record-writers"
import { RecordHoldingsSchema, withFreshLink, type ReceivedRecords, type ReceivingSession, type RecordsLink } from "@mako/sessions/record-sync"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { hostLog, hostWarn } from "../base/host-log.js"
import { applyMoveCheckpoint } from "../workspaces/index.js"

/**
 * A Thread arriving on a cloud machine from a device, before anything runs: its checkout applied to the machine's
 * clone, which its agent made at the device's own path, each Session's native records written into its harness's
 * store here, and each Session opened here as the same native session, answering only once its harness is ready.
 * No turn runs: the device asks the cloud to claim the move once this answers, so a harness that can't start here
 * (not signed in, refusing its folder) refuses the move while the device still has the Thread, never after the
 * cloud took it.
 *
 * Asked again for the same move, it answers what it did without doing it again: a mark in the clone's Git folder
 * says the move arrived, so a repeat can never write the checkout over what an agent has done here since.
 */
export const MoveArrivalInputSchema = z.object({
  move: z.uuid(),
  folder: z.string().min(1),
  checkpoint: MoveCheckpointSchema,
  /** `holdings`: what the device pushed of each session, which the machine holds at least before it writes any of it. */
  sessions: z.array(z.object({
    harness: z.string().min(1),
    nativeId: z.string().min(1),
    holdings: RecordHoldingsSchema.optional(),
    /** The conversation it's opened as here, under the mode and settings it ran with: its journal keeps the device's id. */
    open: z.object({ conversationId: z.uuid(), modeId: z.string().min(1).optional(), tuning: SessionSettingsSchema.optional() }).strict().optional(),
  })).min(1),
}).strict()
export type MoveArrivalInput = z.infer<typeof MoveArrivalInputSchema>

export type MoveArrival = {
  /** `applied` now, or `arrived` before (the move's mark was there). */
  checkout: "applied" | "arrived"
  sessions: Array<{ harness: string; nativeId: string; restored: "restored" | "present"; path: string; opened?: { ms: number } }>
  ms: number
}

/** A Session to open here, resumed from the records just written. */
export type ArrivingSession = { harness: string; nativeId: string; folder: string; conversationId: string; modeId?: string; tuning?: SessionSettings }

export type MoveArrivalDeps = {
  git: Git
  /** The machine's link to its Thread's records at the gateway, while it has one. */
  records(): RecordsLink | undefined
  /** The folder this machine's agent made the clone at. */
  workspace(): string | undefined
  /** Why the agent couldn't make it, when it said. */
  workspaceProblem(): string | undefined
  /** Once the agent made the folder (`path`) or said why it couldn't. */
  workspaceSettled(): Promise<{ path: string } | { problem: string }>
  receive(link: RecordsLink, sessions: ReceivingSession[], installed: Record<string, InstalledReading | null>): Promise<ReceivedRecords[]>
  installed(harness: string): InstalledReading | null
  /**
   * Opens the conversation, resuming its native session, and resolves once its harness is ready; rejects with why
   * it couldn't start. Asked again, it answers how the conversation stands.
   */
  open(session: ArrivingSession): Promise<void>
  /** Reads ahead what a start of `harness` reads first (its catalog), so the sessions open quickly as the move arrives. */
  warm(harness: string, folder: string): Promise<void>
  /** Whether the account gave this machine a sign-in for the harness; undefined before it gave any set. */
  signedIn(harness: string): boolean | undefined
  /** The harness's name, as people read it. */
  label(harness: string): string
  /** A folder of this host's own for the checkpoint while it's applied. */
  scratch: string
}

export const MoveReadyInputSchema = z.object({
  folder: z.string().min(1),
  /** The harnesses the move's sessions run on: what each start reads first is read now, while the device still runs them. */
  harnesses: z.array(z.string().min(1).max(64)).max(32).optional(),
}).strict()
export type MoveReadyInput = z.infer<typeof MoveReadyInputSchema>

/**
 * Whether this machine can take a Thread at `folder`, asked before the device releases it: once its agent cloned the
 * folder, answered; one it couldn't clone refuses with why. Waits for the clone, which the machine makes as it boots.
 */
export async function readyForMove(deps: Pick<MoveArrivalDeps, "workspaceSettled" | "warm">, input: MoveReadyInput): Promise<{ folder: string }> {
  const settled = await deps.workspaceSettled()
  if ("problem" in settled) throw new Error(`The cloud machine couldn't make this Thread's folder: ${settled.problem}`)
  if (settled.path !== input.folder) throw new Error(`This machine's folder is ${settled.path}, not the move's ${input.folder}.`)
  // Read ahead, not judged: a harness that can't start here says so when its session opens, as the move arrives.
  await Promise.all([...new Set(input.harnesses ?? [])].map((harness) => deps.warm(harness, settled.path).catch((error: Error) => {
    hostWarn("moves", "a harness's launch settings weren't read ahead of a move", { harness, error: error.message })
  })))
  return { folder: settled.path }
}

const ArrivedMarkSchema = z.object({ move: z.uuid(), sha256: z.string(), at: z.number() })

export async function arriveMove(deps: MoveArrivalDeps, input: MoveArrivalInput): Promise<MoveArrival> {
  const began = performance.now()
  const link = deps.records()
  if (!link) throw new Error("This host isn't a cloud machine's: no Thread's records are linked here.")
  const workspace = deps.workspace()
  if (workspace !== input.folder) throw new Error(`This machine's folder is ${workspace ?? `not made${deps.workspaceProblem() ? ` (${deps.workspaceProblem()})` : ""}`}, not the move's ${input.folder}.`)
  const gitDir = (await deps.git.output(input.folder, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim()
  const mark = join(gitDir, `mako-move-${input.move}.json`)
  let checkout: MoveArrival["checkout"] = "arrived"
  if (!existsSync(mark)) {
    await mkdir(deps.scratch, { recursive: true })
    const scratch = await mkdtemp(join(deps.scratch, "move-"))
    try {
      const file = join(scratch, "checkpoint.bundle")
      const response = await fetchWith(`${link.base}/checkpoints/${input.checkpoint.sha256}`, { headers: { authorization: link.authorization }, signal: AbortSignal.timeout(10 * 60_000) })
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
  // Under the machine's newest credential if the last one lapsed on the way.
  const received = await withFreshLink(() => deps.records() ?? link, (current) => deps.receive(current, input.sessions, installed))
  const sessions: MoveArrival["sessions"] = []
  for (const each of received) {
    const restored = each.restored
    if (restored.kind === "restored" || restored.kind === "present") sessions.push({ harness: each.harness, nativeId: each.nativeId, restored: restored.kind, path: restored.path })
    else if (restored.kind === "outdated") throw new Error(`${each.harness} here is older than the version that wrote this session, so it can't resume it.`)
    else if (restored.kind === "forked") throw new Error(`${each.harness} here already held another copy of this session.`)
    else throw new Error(restored.reason)
  }
  // Opened one at a time: a machine starts one harness much faster than several at once.
  for (const session of input.sessions) {
    if (!session.open) continue
    const at = sessions.find((each) => each.harness === session.harness && each.nativeId === session.nativeId)
    if (!at) throw new Error(`${session.harness}'s session ${session.nativeId} wasn't written here.`)
    const opening = performance.now()
    try {
      await deps.open({ harness: session.harness, nativeId: session.nativeId, folder: input.folder, ...session.open })
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      const name = deps.label(session.harness)
      const signIn = deps.signedIn(session.harness) === false ? ` Mako Cloud has no sign-in for ${name}: turn on "Use this Mac's sign-ins" in Settings › Account, then move the Thread again.` : ""
      throw new Error(`${name} couldn't start in the cloud: ${why}${signIn}`, { cause: error })
    }
    at.opened = { ms: Math.round(performance.now() - opening) }
  }
  const ms = Math.round(performance.now() - began)
  hostLog("moves", "a Thread arrived from a device", {
    move: input.move, folder: input.folder, checkout, sessions: sessions.length, ms,
    openMs: sessions.map((session) => session.opened?.ms ?? "none").join(","),
  })
  return { checkout, sessions, ms }
}
