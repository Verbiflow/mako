import { createWriteStream, existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import { fetch as fetchWith } from "undici"
import { z } from "zod"
import type { Git } from "@mako/git"
import { describeGatewayFailure } from "@mako/protocol/gateway-http"
import { MoveCheckpointSchema } from "@mako/protocol/moves"
import { RecordSessionSchema } from "@mako/protocol/records"
import type { InstalledReading } from "@mako/sessions/record-writers"
import { RecordHoldingsSchema, describeSync, withFreshLink, type ReceivedRecords, type ReceivingSession, type RecordsLink, type StagedRecords } from "@mako/sessions/record-sync"
import { SessionSettingsSchema, type SessionSettings } from "@mako/sessions/settings"
import { hostLog, hostWarn } from "../base/host-log.js"
import { HandoffSchema, type Handoff } from "../contracts/thread-execution.js"
import { applyMoveCheckpoint, verifyMoveCheckpoint } from "../workspaces/index.js"

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
  /**
   * What the device released, which this machine's store takes before any session opens (`takeArrival`): the Thread
   * and its Sessions under the device's IDs, so both stores name them alike. Absent from a device before this.
   */
  handoff: HandoffSchema.optional(),
}).strict()
export type MoveArrivalInput = z.infer<typeof MoveArrivalInputSchema>
/** What a device sends: its IDs plain strings, which `MoveArrivalInputSchema` parses into the branded ones. */
export type MoveArrivalWire = z.input<typeof MoveArrivalInputSchema>

export type MoveArrival = {
  /** `applied` now, `staged` (applied ahead, proven unchanged), or `arrived` before (the move's mark was there). */
  checkout: "applied" | "staged" | "arrived"
  sessions: Array<{ harness: string; nativeId: string; restored: "restored" | "present"; path: string; opened?: { ms: number } }>
  ms: number
  /** How long each part took, in ms: the checkout's read, apply or verify, and the records. */
  parts?: Record<string, number>
}

/**
 * A Session to open here, resumed from the records just written. `path` is where its harness lists the session here:
 * the start reads its history from there first, as a desktop's resume does, so the conversation's history is the
 * session's records, and what a harness replays as it loads one (ACP's `session/load`) is drawn over them, not in
 * their place.
 */
export type ArrivingSession = { harness: string; nativeId: string; path: string; folder: string; conversationId: string; modeId?: string; tuning?: SessionSettings }

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
  /** Pulls records into this machine's record store ahead of the move, writing nothing into the harnesses' stores. */
  stage(link: RecordsLink, sessions: ReceivingSession[]): Promise<StagedRecords[]>
  installed(harness: string): InstalledReading | null
  /**
   * Opens the conversation, resuming its native session, and resolves once its harness is ready; rejects with why
   * it couldn't start. Asked again, it answers how the conversation stands.
   */
  open(session: ArrivingSession): Promise<void>
  /** This machine's store takes the Thread under the device's IDs (`ThreadStore.takeArrival`), once per move. */
  take(handoff: Handoff): void
  /** Reads ahead what a start of `harness` reads first (its catalog), so the sessions open quickly as the move arrives. */
  warm(harness: string, folder: string, tuning?: SessionSettings): Promise<void>
  /** Whether the account gave this machine a sign-in for the harness; undefined before it gave any set. */
  signedIn(harness: string): boolean | undefined
  /** The harness's name, as people read it. */
  label(harness: string): string
  /** A folder of this host's own for the checkpoint while it's applied. */
  scratch: string
  /**
   * By folder, the records pulled ahead as the machine got ready for a move (`readyForMove`), which its stage and
   * arrival wait for rather than read again.
   */
  ahead?: Map<string, Promise<void>>
}

export const MoveReadyInputSchema = z.object({
  folder: z.string().min(1),
  /** The harnesses the move's sessions run on: what each start reads first is read now, while the device still runs them. */
  harnesses: z.array(z.string().min(1).max(64)).max(32).optional(),
  /**
   * Each session's harness with the settings it runs with: the launch settings its start resolves (a harness's model
   * catalog, read by starting it once) are read now, in the folder, so the hand-over's start finds them ready.
   */
  launches: z.array(z.object({ harness: z.string().min(1).max(64), tuning: SessionSettingsSchema.optional() }).strict()).max(256).optional(),
}).strict()
export type MoveReadyInput = z.infer<typeof MoveReadyInputSchema>

/**
 * Whether this machine can take a Thread at `folder`, asked before the device releases it: once its agent cloned the
 * folder, answered; one it couldn't clone refuses with why. Waits for the clone, which the machine makes as it boots.
 */
export async function readyForMove(
  deps: Pick<MoveArrivalDeps, "workspaceSettled" | "warm"> & Partial<Pick<MoveArrivalDeps, "records" | "stage" | "ahead">>,
  input: MoveReadyInput
): Promise<{ folder: string }> {
  const settled = await deps.workspaceSettled()
  if ("problem" in settled) throw new Error(`The cloud machine couldn't make this Thread's folder: ${settled.problem}`)
  if (settled.path !== input.folder) throw new Error(`This machine's folder is ${settled.path}, not the move's ${input.folder}.`)
  // Read ahead, not judged: a harness that can't start here says so when its session opens, as the move arrives.
  // A session's own settings first, which is what its start reads; then each harness the move names without them.
  // Not waited for: the device goes on sending ahead meanwhile (OpenCode's catalog took 9.4 s on a cold machine,
  // 2026-10-23), and the arrival's session open joins a read still running rather than starting another.
  const launches: Array<{ harness: string; tuning?: SessionSettings }> = [...input.launches ?? [], ...[...new Set(input.harnesses ?? [])].filter((harness) => !input.launches?.some((launch) => launch.harness === harness)).map((harness) => ({ harness }))]
  const began = performance.now()
  if (launches.length)
    void Promise.all(launches.map((launch) => deps.warm(launch.harness, settled.path, launch.tuning).catch((error: Error) => {
      hostWarn("moves", "a harness's launch settings weren't read ahead of a move", { harness: launch.harness, error: error.message })
    }))).then(() => hostLog("moves", "launch settings read ahead of a move", { harnesses: launches.map((launch) => launch.harness).join(","), ms: Math.round(performance.now() - began) }))
  pullAhead(deps, settled.path)
  return { folder: settled.path }
}

/**
 * The records the Thread holds so far pulled into this machine's record store as it gets ready, not waited for: the
 * device sends the newest meanwhile, and the stage after pulls only what came since. The first read of the Thread's
 * records in minutes may find the cloud's copy cold (1.7 s once, 2026-10-23); it's paid here, beside the machine's
 * own readying, rather than in the stage the release waits on.
 */
function pullAhead(deps: Partial<Pick<MoveArrivalDeps, "records" | "stage" | "ahead">>, folder: string): void {
  const link = deps.records?.()
  const { stage, ahead } = deps
  if (!link || !stage || !ahead || ahead.has(folder)) return
  const began = performance.now()
  ahead.set(folder, (async () => {
    const sessions = await remoteSessions(link)
    if (!sessions.length) return
    const pulled = await withFreshLink(() => deps.records?.() ?? link, (current) => stage(current, sessions))
    hostLog("moves", "records pulled ahead as the machine got ready", { ms: Math.round(performance.now() - began), sessions: pulled.map((each) => `${each.harness}: ${describeSync(each)}`).join("; ") })
  })().catch((error: Error) => {
    hostWarn("moves", "records weren't pulled ahead as the machine got ready; the stage pulls them", { error: describeGatewayFailure(error) })
  }))
}

/** The sessions the Thread's records hold in the cloud. */
async function remoteSessions(link: RecordsLink): Promise<ReceivingSession[]> {
  const response = await fetchWith(`${link.base}/sessions`, { headers: { authorization: link.authorization }, signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`The Thread's sessions couldn't be listed (GET /sessions answered ${response.status})`)
  return z.object({ sessions: RecordSessionSchema.array() }).parse(await response.json()).sessions.map(({ harness, nativeId }) => ({ harness, nativeId }))
}

/** Once what was pulled ahead for `folder` has landed: what's read now is only what came since. */
async function pulledAhead(deps: Pick<MoveArrivalDeps, "ahead">, folder: string): Promise<void> {
  const pulling = deps.ahead?.get(folder)
  if (!pulling) return
  await pulling
  deps.ahead?.delete(folder)
}

const ArrivedMarkSchema = z.object({ move: z.uuid(), sha256: z.string(), at: z.number() })
/** The checkout staged ahead of a move's hand-over, by its checkpoint's hash. */
const StagedMarkSchema = z.object({ move: z.uuid(), sha256: z.string(), at: z.number() })

export const MoveStageInputSchema = z.object({
  move: z.uuid(),
  folder: z.string().min(1),
  /** The checkout and each session's records as the device sent them ahead, while the Thread still runs there. */
  checkpoint: MoveCheckpointSchema,
  sessions: z.array(z.object({ harness: z.string().min(1), nativeId: z.string().min(1) })).min(1).max(256),
}).strict()
export type MoveStageInput = z.infer<typeof MoveStageInputSchema>

export type MoveStage = { checkpointMs: number; recordsMs: number; staged: Array<{ harness: string; nativeId: string; versions: number; bytes: number }> }

/** Reads the move's checkpoint from the cloud into `file`. */
async function readCheckpoint(link: RecordsLink, sha256: string, file: string): Promise<void> {
  const response = await fetchWith(`${link.base}/checkpoints/${sha256}`, { headers: { authorization: link.authorization }, signal: AbortSignal.timeout(10 * 60_000) })
  if (!response.ok || !response.body) {
    // The gateway's own words and correlation ID, so a refusal leads to its log line.
    const problem = z.object({ title: z.string(), correlationId: z.string() }).partial().safeParse(await response.json().catch(() => undefined)).data
    const correlationId = problem?.correlationId ?? response.headers.get("x-mako-correlation-id")
    throw new Error(`The move's checkout couldn't be read from the cloud: ${problem?.title ?? "no checkout"} (GET /checkpoints answered ${response.status}${correlationId ? `, correlation ${correlationId}` : ""})`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file))
}

/** Runs one part of a move on this machine, its failure saying which part and, for a gateway's refusal, which call. */
async function part<Value>(what: string, work: () => Promise<Value>): Promise<Value> {
  try {
    return await work()
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    throw new Error(`${what}: ${describeGatewayFailure(failure)}`, { cause: error })
  }
}

/**
 * What a move's hand-over can do while the Thread still runs on its device, done ahead: the checkout sent ahead laid
 * over the machine's clone, and each session's records sent ahead pulled into its record store (not its harness's).
 * Nothing runs here until the move arrives, so the hand-over only verifies the checkout (or lays the newest over it)
 * and pulls the last seconds of records. Asked again, as the device sends newer, it stages the newer.
 */
export async function stageMove(deps: MoveArrivalDeps, input: MoveStageInput): Promise<MoveStage> {
  const link = deps.records()
  if (!link) throw new Error("This host isn't a cloud machine's: no Thread's records are linked here.")
  const workspace = deps.workspace()
  if (workspace !== input.folder) throw new Error(`This machine's folder is ${workspace ?? "not made"}, not the move's ${input.folder}.`)
  const gitDir = (await deps.git.output(input.folder, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim()
  if (existsSync(join(gitDir, `mako-move-${input.move}.json`))) throw new Error("This move already arrived here.")
  const began = performance.now()
  const since = () => Math.round(performance.now() - began)
  const checkout = async (): Promise<number> => {
    await mkdir(deps.scratch, { recursive: true })
    const scratch = await mkdtemp(join(deps.scratch, "stage-"))
    try {
      const file = join(scratch, "checkpoint.bundle")
      await part("Its checkout couldn't be staged", async () => {
        await readCheckpoint(link, input.checkpoint.sha256, file)
        await applyMoveCheckpoint(deps.git, input.folder, file, input.checkpoint, { replace: true })
      })
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
    await writeFile(join(gitDir, `mako-stage-${input.move}.json`), JSON.stringify(StagedMarkSchema.parse({ move: input.move, sha256: input.checkpoint.sha256, at: Date.now() })))
    return since()
  }
  const records = async (): Promise<{ ms: number; pulled: StagedRecords[] }> => {
    await pulledAhead(deps, input.folder)
    const pulled = await part("Its sessions' records couldn't be staged", () => withFreshLink(() => deps.records() ?? link, (current) => deps.stage(current, input.sessions)))
    return { ms: since(), pulled }
  }
  const [checkpointMs, staged] = await Promise.all([checkout(), records()])
  const stage: MoveStage = {
    checkpointMs,
    recordsMs: staged.ms,
    staged: staged.pulled.map((each) => ({ harness: each.harness, nativeId: each.nativeId, versions: each.versions, bytes: each.bytes })),
  }
  hostLog("moves", "a move was staged ahead of its hand-over", { move: input.move, checkpointMs, recordsMs: staged.ms, sessions: staged.pulled.map((each) => `${each.harness}: ${describeSync(each)}`).join("; ") })
  return stage
}

export async function arriveMove(deps: MoveArrivalDeps, input: MoveArrivalInput): Promise<MoveArrival> {
  const began = performance.now()
  const link = deps.records()
  if (!link) throw new Error("This host isn't a cloud machine's: no Thread's records are linked here.")
  const workspace = deps.workspace()
  if (workspace !== input.folder) throw new Error(`This machine's folder is ${workspace ?? `not made${deps.workspaceProblem() ? ` (${deps.workspaceProblem()})` : ""}`}, not the move's ${input.folder}.`)
  const gitDir = (await deps.git.output(input.folder, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim()
  const mark = join(gitDir, `mako-move-${input.move}.json`)
  // Each part timed, so a slow hand-over says where it waited.
  const parts: Record<string, number> = {}
  const timed = async <Value>(part: string, work: () => Promise<Value>): Promise<Value> => {
    const at = performance.now()
    try {
      return await work()
    } finally {
      parts[part] = Math.round(performance.now() - at)
    }
  }
  let checkout: MoveArrival["checkout"] = "arrived"
  if (!existsSync(mark)) {
    const stagedMark = join(gitDir, `mako-stage-${input.move}.json`)
    const staged = existsSync(stagedMark) ? StagedMarkSchema.safeParse(JSON.parse(await readFile(stagedMark, "utf8"))).data : undefined
    // Staged ahead and unchanged since: the clone already reads as the checkout, which is proven, not assumed. Else
    // the newest is laid over what was staged (nothing has run here, so nothing of the machine's own is lost).
    const unchanged = staged?.sha256 === input.checkpoint.sha256 && await timed("checkpointVerified", () => verifyMoveCheckpoint(deps.git, input.folder, input.checkpoint).then(() => true, () => false))
    if (!unchanged) {
      await mkdir(deps.scratch, { recursive: true })
      const scratch = await mkdtemp(join(deps.scratch, "move-"))
      try {
        const file = join(scratch, "checkpoint.bundle")
        await timed("checkpointRead", () => readCheckpoint(link, input.checkpoint.sha256, file))
        await timed("checkpointApplied", () => applyMoveCheckpoint(deps.git, input.folder, file, input.checkpoint, { replace: staged !== undefined }))
      } finally {
        await rm(scratch, { recursive: true, force: true })
      }
    }
    await writeFile(mark, JSON.stringify(ArrivedMarkSchema.parse({ move: input.move, sha256: input.checkpoint.sha256, at: Date.now() })))
    await rm(stagedMark, { force: true })
    checkout = unchanged ? "staged" : "applied"
  }
  const installed: Record<string, InstalledReading | null> = {}
  for (const session of input.sessions) installed[session.harness] = deps.installed(session.harness)
  // Under the machine's newest credential if the last one lapsed on the way.
  await pulledAhead(deps, input.folder)
  const received = await timed("records", () => part("Its sessions' records couldn't be pulled here", () => withFreshLink(() => deps.records() ?? link, (current) => deps.receive(current, input.sessions, installed))))
  const sessions: MoveArrival["sessions"] = []
  for (const each of received) {
    const restored = each.restored
    if (restored.kind === "restored" || restored.kind === "present") sessions.push({ harness: each.harness, nativeId: each.nativeId, restored: restored.kind, path: restored.path })
    else if (restored.kind === "outdated") throw new Error(`${each.harness} here is older than the version that wrote this session, so it can't resume it.`)
    else if (restored.kind === "forked") throw new Error(`${each.harness} here already held another copy of this session.`)
    else throw new Error(restored.reason)
  }
  // Filed under the device's Thread and Sessions before any opens: a conversation's journal joins its own Session.
  if (input.handoff) deps.take(input.handoff)
  // Opened one at a time: a machine starts one harness much faster than several at once.
  for (const session of input.sessions) {
    if (!session.open) continue
    const at = sessions.find((each) => each.harness === session.harness && each.nativeId === session.nativeId)
    if (!at) throw new Error(`${session.harness}'s session ${session.nativeId} wasn't written here.`)
    const opening = performance.now()
    try {
      await deps.open({ harness: session.harness, nativeId: session.nativeId, path: at.path, folder: input.folder, ...session.open })
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
    move: input.move, folder: input.folder, checkout, sessions: sessions.length, ms, ...parts,
    openMs: sessions.map((session) => session.opened?.ms ?? "none").join(","),
    received: received.map((each) => `${each.harness}: pulled ${describeSync(each.pulled)}; ${each.restored.kind}${"ms" in each.restored ? ` in ${each.restored.ms} ms` : ""}`).join("; "),
  })
  return { checkout, sessions, ms, parts }
}
