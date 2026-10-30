import { createReadStream, existsSync } from "node:fs"
import { lstat, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { fetch as fetchWith } from "undici"
import { z } from "zod"
import type { Git } from "@mako/git"
import type { ThreadFileHistory } from "@mako/protocol"
import { MoveCarrySchema, ReturnDepartureSchema, type MoveCarryRef, type MoveCarryRepository, type ReturnDeparture } from "@mako/protocol/moves"
import { withFreshLink, type RecordsLink, type SentRecords } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { DeviceIdSchema, MoveIdSchema, type ExecutionOwner, type Handoff, type MoveId, type Refusal } from "../contracts/thread-execution.js"
import type { Actor, ThreadId } from "../contracts/thread-identity.js"
import type { MoveBegan } from "../threads/index.js"
import { captureCarry, captureMoveCheckpoint, readOutside, type OutsideCandidate } from "../workspaces/index.js"
import { namedUuid } from "./cloud-moves.js"
import { MoveNotQuietError } from "./live-moves.js"
import { ARRIVED_CARRY } from "./move-arrival.js"

/**
 * A Thread leaving a cloud machine for the device it came from. Once none of its conversations works, the machine
 * releases the Thread in its own store, toward the device, as a device releases a Thread it moves: its providers
 * close and nothing of it runs here again unless it's taken back (`stayMove`), so work that reaches the machine
 * after this, a prompt sent just before the return began, waits rather than runs. Then the machine's checkout goes up
 * as a checkpoint beside the Thread's records, and each conversation's native records after it. The gateway takes no
 * work for the Thread while it returns, and only the device's word, after this answers, records it gone.
 *
 * Asked again, it answers the same way without harm: the release is kept by its operation, a checkout that hasn't
 * changed makes the same checkpoint (sent once, by its hash), and the records send only what the cloud lacks. A
 * failure after the release takes the Thread back here before it answers, so a refused departure leaves the Thread
 * running here as it was.
 */
export const MoveDepartureInputSchema = z.object({
  move: z.uuid(),
  folder: z.string().min(1),
  /** The conversations going back, under the ids they had on the device and kept here. */
  conversations: z.array(z.uuid()).min(1).max(256),
  /** The device the Thread goes back to: the owner its release here names. */
  device: z.uuid(),
  /** The device takes a carry back (`MoveCarry`): its other repositories, its files outside its folder, its file history. */
  carry: z.literal(true).optional(),
}).strict()
export type MoveDepartureInput = z.infer<typeof MoveDepartureInputSchema>

export type MoveDepartureDeps = {
  git: Git
  /** The machine's link to its Thread's records at the gateway, while it has one. */
  records(): RecordsLink | undefined
  /** The folder this machine's agent made the clone at. */
  workspace(): string | undefined
  /** Why the agent couldn't make it, when it said. */
  workspaceProblem(): string | undefined
  /**
   * What keeps the Thread from leaving, once what passes in a moment (a turn's checkpoint as it ends) has passed:
   * `LiveMoves.settledBlockers`. Empty when it could.
   */
  blockers(thread: ThreadId): Promise<string[]>
  /** This machine's Thread store, where the conversations' Thread is released and taken back. */
  threads(): DepartureThreads | undefined
  moves: DepartureMoves
  /** The native session a conversation runs here: its harness, id and path. */
  native(conversationId: string): { harness: string; nativeId: string; path: string } | undefined
  send(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  /** A folder of this host's own for the checkpoint while it's made. */
  scratch: string
  /** The Thread's paths outside its folder that this machine's journal ties to it (`Attribution.changes`' footprint, with evidence). */
  outside?(thread: ThreadId): OutsideCandidate[]
  /** The Thread's file history on this machine (`Attribution.threadHistory`), carried back with it. */
  history?(thread: ThreadId): ThreadFileHistory | undefined
}

/** What a departure reads of the machine's Thread store. */
export type DepartureThreads = {
  journalPlacement(conversationId: string): { thread: ThreadId } | undefined
  moveStatus(move: MoveId): { phase: string } | undefined
  person(): Actor
}

/** The moves of `LiveMoves` a departure takes: release toward the device, and taking the Thread back. */
export type DepartureMoves = {
  begin(input: { move: MoveId; thread: ThreadId; target: ExecutionOwner; actor: Actor }): MoveBegan
  release(input: { operationId: string; move: MoveId; actor: Actor }): Promise<Handoff>
  cancel(input: { operationId: string; move: MoveId; actor: Actor }): void
  reclaim(input: { operationId: string; refusal: Refusal; actor: Actor }): void
}

/** A departure's step in the machine's store, as the store takes it once: the same UUID each time it's asked. */
function departureOperation(move: string, step: "release" | "cancel" | "reclaim"): string {
  return namedUuid(`mako return\0${move}\0${step}`)
}

/** The one Thread on this machine the departing conversations are in. */
function departingThread(deps: MoveDepartureDeps, input: MoveDepartureInput): ThreadId {
  const threads = deps.threads()
  if (!threads) throw new Error("This machine's Thread store isn't open.")
  const placed = input.conversations.map((conversation) => threads.journalPlacement(conversation)?.thread)
  const thread = placed[0]
  if (!thread || placed.some((each) => each !== thread)) throw new Error("These conversations aren't one Thread on this machine.")
  return thread
}

/** The Thread released here toward the device, once its conversations are quiet; refuses, naming what works. */
async function releaseHere(deps: MoveDepartureDeps, input: MoveDepartureInput, thread: ThreadId): Promise<void> {
  const threads = deps.threads()
  if (!threads) throw new Error("This machine's Thread store isn't open.")
  const move = MoveIdSchema.parse(input.move)
  const actor = threads.person()
  if (!threads.moveStatus(move)) deps.moves.begin({ move, thread, target: { kind: "device", device: DeviceIdSchema.parse(input.device) }, actor })
  try {
    await deps.moves.release({ operationId: departureOperation(move, "release"), move, actor })
  } catch (error) {
    if (threads.moveStatus(move)?.phase === "leaving") deps.moves.cancel({ operationId: departureOperation(move, "cancel"), move, actor })
    throw error instanceof MoveNotQuietError ? new Error(`A Thread goes back between turns: ${error.reasons.join("; ")}.`, { cause: error }) : error
  }
}

export const MoveFollowInputSchema = z.object({ folder: z.string().min(1) }).strict()
export type MoveFollowInput = z.infer<typeof MoveFollowInputSchema>
/** Each repository of the Thread's checkout on this machine as it stands, its checkpoint kept beside the Thread's records. */
export type MoveFollow = { repositories: Array<{ path: string; checkpoint: ReturnDeparture["checkpoint"] }> }

/**
 * The Thread's checkout on this machine as it stands, for its device's worktree to follow while the Thread runs here:
 * each repository's checkpoint (the first's, then any other the carry it arrived with names), sent up unless the cloud
 * has it. Only reads: nothing of the Thread is released or changed, so it can be asked at any turn's end.
 */
export async function followMove(deps: Pick<MoveDepartureDeps, "git" | "records" | "workspace" | "workspaceProblem" | "scratch">, input: MoveFollowInput): Promise<MoveFollow> {
  const link = deps.records()
  if (!link) throw new Error("This host isn't a cloud machine's: no Thread's records are linked here.")
  const workspace = deps.workspace()
  if (workspace !== input.folder) throw new Error(`This machine's folder is ${workspace ?? `not made${deps.workspaceProblem() ? ` (${deps.workspaceProblem()})` : ""}`}, not ${input.folder}.`)
  const gitDir = (await deps.git.output(input.folder, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim()
  const marked = join(gitDir, ARRIVED_CARRY)
  const arrived = existsSync(marked) ? MoveCarrySchema.safeParse(JSON.parse(await readFile(marked, "utf8"))).data : undefined
  await mkdir(deps.scratch, { recursive: true })
  const scratch = await mkdtemp(join(deps.scratch, "follow-"))
  try {
    const repositories: MoveFollow["repositories"] = []
    for (const path of [input.folder, ...(arrived?.repositories.slice(1) ?? []).map((repository) => repository.path)]) {
      const captured = await captureMoveCheckpoint(deps.git, path, await mkdtemp(join(scratch, "checkout-")))
      await sendBundle(link, captured.checkpoint, captured.file, `The checkout of ${path}`)
      repositories.push({ path, checkpoint: captured.checkpoint })
    }
    return { repositories }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

export const MoveStayInputSchema = z.object({ move: z.uuid(), device: z.uuid(), reason: z.string().min(1).max(2_000) }).strict()
export type MoveStayInput = z.infer<typeof MoveStayInputSchema>
/** Whether the machine took the Thread back now: false when nothing of it was released here, or it was already back. */
export type MoveStay = { stayed: boolean }

/**
 * The Thread taken back here after its departure: the device cancelled the return or gave the Thread back, so it runs
 * on this machine again, each Session one generation on. Asked again, or for a departure that never released it, it
 * changes nothing.
 */
export function stayMove(deps: Pick<MoveDepartureDeps, "threads" | "moves">, input: MoveStayInput): MoveStay {
  const threads = deps.threads()
  if (!threads) throw new Error("This machine's Thread store isn't open.")
  const move = MoveIdSchema.parse(input.move)
  const phase = threads.moveStatus(move)?.phase
  const actor = threads.person()
  if (phase === "leaving") deps.moves.cancel({ operationId: departureOperation(move, "cancel"), move, actor })
  else if (phase === "released") deps.moves.reclaim({ operationId: departureOperation(move, "reclaim"), refusal: { move, by: { kind: "device", device: DeviceIdSchema.parse(input.device) }, reason: input.reason }, actor })
  else return { stayed: false }
  hostLog("moves", "a Thread stayed on this machine after its departure", { move, was: phase, reason: input.reason })
  return { stayed: true }
}

export async function departMove(deps: MoveDepartureDeps, input: MoveDepartureInput): Promise<ReturnDeparture> {
  const began = performance.now()
  const link = deps.records()
  if (!link) throw new Error("This host isn't a cloud machine's: no Thread's records are linked here.")
  const workspace = deps.workspace()
  if (workspace !== input.folder) throw new Error(`This machine's folder is ${workspace ?? `not made${deps.workspaceProblem() ? ` (${deps.workspaceProblem()})` : ""}`}, not the return's ${input.folder}.`)
  const thread = departingThread(deps, input)
  // Asked as a turn ends, it waits out the turn's own bookkeeping rather than refusing for it; a turn is said at once.
  const busy = await deps.blockers(thread)
  if (busy.length) throw new Error(`A Thread goes back between turns: ${busy.join("; ")}.`)
  const natives = input.conversations.map((conversation) => {
    const native = deps.native(conversation)
    if (!native) throw new Error(`The conversation ${conversation} hasn't started here, so it has no records to send back.`)
    return native
  })
  await releaseHere(deps, input, thread)
  try {
    return await packUp(deps, input, link, natives, began, thread)
  } catch (error) {
    // Nothing recorded it gone: it runs here again, and the device hears why.
    const reason = errorMessage({ error })
    hostWarn("moves", "a departure failed after its release; the Thread runs here again", { move: input.move, reason })
    stayMove(deps, { move: input.move, device: input.device, reason: `The departure failed: ${reason}`.slice(0, 2_000) })
    throw error
  }
}

/** The checkout and the records, sent up once the Thread is released here. */
async function packUp(deps: MoveDepartureDeps, input: MoveDepartureInput, link: RecordsLink, natives: Array<{ harness: string; nativeId: string; path: string }>, began: number, thread: ThreadId): Promise<ReturnDeparture> {
  // The checkout and the records go up at once: neither waits on the other, and the device takes both only once the
  // cloud has the departure, which names both. The carry names the checkout, so it follows it.
  const [{ checkpoint, carry }, sent] = await Promise.all([
    sendCheckout(deps, input, link).then(async (checkpoint) => ({ checkpoint, carry: input.carry ? await sendThreadCarry(deps, { folder: input.folder, thread, checkpoint }, link, `move ${input.move}`) : undefined })),
    withFreshLink(() => deps.records() ?? link, (current) => deps.send(current, natives.map((native) => native.path))),
  ])
  const sessions = natives.map((native) => {
    const went = sent.find((each) => each.harness === native.harness && each.nativeId === native.nativeId)
    if (!went) throw new Error(`${native.harness}'s session ${native.nativeId} wasn't sent.`)
    return { harness: native.harness, nativeId: native.nativeId, holdings: went.holdings }
  })
  const departure = ReturnDepartureSchema.parse({ checkpoint, sessions, ...carry && { carry } })
  hostLog("moves", "a Thread left for its device", { move: input.move, folder: input.folder, sessions: sessions.length, checkpointBytes: checkpoint.bytes, ms: Math.round(performance.now() - began) })
  return departure
}

/** A bundle sent up beside the Thread's records unless the cloud has it, by its hash. */
async function sendBundle(link: RecordsLink, ref: MoveCarryRef, file: string, what: string): Promise<void> {
  const url = `${link.base}/checkpoints/${ref.sha256}`
  const kept = await fetchWith(url, { method: "HEAD", headers: { authorization: link.authorization }, signal: AbortSignal.timeout(30_000) })
  if (kept.status === 404) {
    const put = await fetchWith(url, {
      method: "PUT",
      headers: { authorization: link.authorization, "content-type": "application/octet-stream", "content-length": String(ref.bytes) },
      body: createReadStream(file),
      duplex: "half",
      signal: AbortSignal.timeout(10 * 60_000),
    })
    if (!put.ok) throw new Error(`${what} couldn't be sent back: the cloud answered ${put.status}`)
  } else if (!kept.ok) throw new Error(`The cloud couldn't say whether it has ${what.toLowerCase()}: it answered ${kept.status}`)
}

/**
 * What the Thread carries back besides its checkout: its other repositories' checkouts, every file outside its folder
 * that it changed here (what came with it and changed, and what it wrote here), the ones it removed, and its file
 * history; the manifest it arrived with (`ARRIVED_CARRY`) says which came. A Thread that arrived without one carries
 * what this machine's journal ties to it.
 */
/** What a carry of the Thread on this machine reads: Git, a scratch folder, and the journal's outside files and file history. */
export type ThreadCarryDeps = Pick<MoveDepartureDeps, "git" | "scratch" | "outside" | "history">

/**
 * The Thread's carry as it stands on this machine, sent up beside its records unless the cloud has it: each other
 * repository the carry it arrived with names (the first's checkpoint is `at.checkpoint`), its files outside its folder
 * that changed here, those gone, and its file history. What its departure packs for the way back, and what a save takes
 * so a machine restoring it (`machine-restore.ts`) lays all of it down. `why` names the caller in the log.
 */
export async function sendThreadCarry(deps: ThreadCarryDeps, at: { folder: string; thread: ThreadId; checkpoint: ReturnDeparture["checkpoint"] }, link: RecordsLink, why: string): Promise<MoveCarryRef> {
  const { thread, checkpoint } = at
  const gitDir = (await deps.git.output(at.folder, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim()
  const marked = join(gitDir, ARRIVED_CARRY)
  const arrived = existsSync(marked) ? MoveCarrySchema.safeParse(JSON.parse(await readFile(marked, "utf8"))).data : undefined
  const folder = arrived?.folder ?? at.folder
  await mkdir(deps.scratch, { recursive: true })
  const scratch = await mkdtemp(join(deps.scratch, "carry-"))
  try {
    const repositories: MoveCarryRepository[] = [{ path: at.folder, checkpoint }]
    for (const other of arrived?.repositories.slice(1) ?? []) {
      const captured = await captureMoveCheckpoint(deps.git, other.path, await mkdtemp(join(scratch, "checkout-")))
      await sendBundle(link, captured.checkpoint, captured.file, `The checkout of ${other.path}`)
      repositories.push({ ...other, checkpoint: captured.checkpoint })
    }
    const came = new Map((arrived?.outside ?? []).map((entry) => [entry.path, entry]))
    const candidates: OutsideCandidate[] = [...came.values()].map(({ path, access }) => ({ path, access }))
    for (const used of deps.outside?.(thread) ?? []) if (used.access === "write") candidates.push(used)
    const { read, left } = await readOutside(candidates, folder)
    // Only what changed here goes back: a file that came and wasn't touched is the device's already.
    const changed = read.filter((each) => came.get(each.entry.path)?.sha256 !== each.entry.sha256)
    const gone: string[] = []
    for (const path of came.keys()) if (!(await lstat(path).catch(() => undefined))) gone.push(path)
    const history = deps.history?.(thread)
    const carry = await captureCarry(deps.git, { folder, repositories, outside: changed, left, gone, ...history && { history } }, scratch)
    await sendBundle(link, carry.ref, carry.file, "What it carries")
    hostLog("moves", "a Thread's carry was packed", { for: why, repositories: repositories.length, outside: changed.length, gone: gone.length, left: left.length, history: history !== undefined, bytes: carry.ref.bytes })
    return carry.ref
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/** The machine's checkout, captured and sent up unless the cloud has it. */
async function sendCheckout(deps: MoveDepartureDeps, input: MoveDepartureInput, link: RecordsLink): Promise<ReturnDeparture["checkpoint"]> {
  await mkdir(deps.scratch, { recursive: true })
  const scratch = await mkdtemp(join(deps.scratch, "depart-"))
  let checkpoint: ReturnDeparture["checkpoint"]
  try {
    const captured = await captureMoveCheckpoint(deps.git, input.folder, scratch)
    checkpoint = captured.checkpoint
    await sendBundle(link, checkpoint, captured.file, "The checkout")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  return checkpoint
}
