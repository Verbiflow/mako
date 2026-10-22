import { createReadStream } from "node:fs"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { fetch as fetchWith } from "undici"
import { z } from "zod"
import type { Git } from "@mako/git"
import { ReturnDepartureSchema, type ReturnDeparture } from "@mako/protocol/moves"
import { withFreshLink, type RecordsLink, type SentRecords } from "@mako/sessions/record-sync"
import { errorMessage } from "../base/error-message.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { DeviceIdSchema, MoveIdSchema, type ExecutionOwner, type Handoff, type MoveId, type Refusal } from "../contracts/thread-execution.js"
import type { Actor, ThreadId } from "../contracts/thread-identity.js"
import type { MoveBegan } from "../threads/index.js"
import { captureMoveCheckpoint } from "../workspaces/index.js"
import { namedUuid } from "./cloud-moves.js"
import { MoveNotQuietError } from "./live-moves.js"

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
  /** What keeps these conversations from leaving now; empty when they could. */
  blockers(conversations: readonly string[]): string[]
  /** This machine's Thread store, where the conversations' Thread is released and taken back. */
  threads(): DepartureThreads | undefined
  moves: DepartureMoves
  /** The native session a conversation runs here: its harness, id and path. */
  native(conversationId: string): { harness: string; nativeId: string; path: string } | undefined
  send(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  /** A folder of this host's own for the checkpoint while it's made. */
  scratch: string
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

/** The Thread released here toward the device, once its conversations are quiet; refuses, naming what works. */
async function releaseHere(deps: MoveDepartureDeps, input: MoveDepartureInput): Promise<void> {
  const threads = deps.threads()
  if (!threads) throw new Error("This machine's Thread store isn't open.")
  const move = MoveIdSchema.parse(input.move)
  const placed = input.conversations.map((conversation) => threads.journalPlacement(conversation)?.thread)
  const thread = placed[0]
  if (!thread || placed.some((each) => each !== thread)) throw new Error("These conversations aren't one Thread on this machine.")
  const actor = threads.person()
  if (!threads.moveStatus(move)) deps.moves.begin({ move, thread, target: { kind: "device", device: DeviceIdSchema.parse(input.device) }, actor })
  try {
    await deps.moves.release({ operationId: departureOperation(move, "release"), move, actor })
  } catch (error) {
    if (threads.moveStatus(move)?.phase === "leaving") deps.moves.cancel({ operationId: departureOperation(move, "cancel"), move, actor })
    throw error instanceof MoveNotQuietError ? new Error(`A Thread goes back between turns: ${error.reasons.join("; ")}.`, { cause: error }) : error
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
  const busy = deps.blockers(input.conversations)
  if (busy.length) throw new Error(`A Thread goes back between turns: ${busy.join("; ")}.`)
  const natives = input.conversations.map((conversation) => {
    const native = deps.native(conversation)
    if (!native) throw new Error(`The conversation ${conversation} hasn't started here, so it has no records to send back.`)
    return native
  })
  await releaseHere(deps, input)
  try {
    return await packUp(deps, input, link, natives, began)
  } catch (error) {
    // Nothing recorded it gone: it runs here again, and the device hears why.
    const reason = errorMessage({ error })
    hostWarn("moves", "a departure failed after its release; the Thread runs here again", { move: input.move, reason })
    stayMove(deps, { move: input.move, device: input.device, reason: `The departure failed: ${reason}`.slice(0, 2_000) })
    throw error
  }
}

/** The checkout and the records, sent up once the Thread is released here. */
async function packUp(deps: MoveDepartureDeps, input: MoveDepartureInput, link: RecordsLink, natives: Array<{ harness: string; nativeId: string; path: string }>, began: number): Promise<ReturnDeparture> {
  await mkdir(deps.scratch, { recursive: true })
  const scratch = await mkdtemp(join(deps.scratch, "depart-"))
  let checkpoint: ReturnDeparture["checkpoint"]
  try {
    const captured = await captureMoveCheckpoint(deps.git, input.folder, scratch)
    checkpoint = captured.checkpoint
    const url = `${link.base}/checkpoints/${checkpoint.sha256}`
    const kept = await fetchWith(url, { method: "HEAD", headers: { authorization: link.authorization }, signal: AbortSignal.timeout(30_000) })
    if (kept.status === 404) {
      const put = await fetchWith(url, {
        method: "PUT",
        headers: { authorization: link.authorization, "content-type": "application/octet-stream", "content-length": String(checkpoint.bytes) },
        body: createReadStream(captured.file),
        duplex: "half",
        signal: AbortSignal.timeout(10 * 60_000),
      })
      if (!put.ok) throw new Error(`The checkout couldn't be sent back: the cloud answered ${put.status}`)
    } else if (!kept.ok) throw new Error(`The cloud couldn't say whether it has the checkout: it answered ${kept.status}`)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
  const sent = await withFreshLink(() => deps.records() ?? link, (current) => deps.send(current, natives.map((native) => native.path)))
  const sessions = natives.map((native) => {
    const went = sent.find((each) => each.harness === native.harness && each.nativeId === native.nativeId)
    if (!went) throw new Error(`${native.harness}'s session ${native.nativeId} wasn't sent.`)
    return { harness: native.harness, nativeId: native.nativeId, holdings: went.holdings }
  })
  const departure = ReturnDepartureSchema.parse({ checkpoint, sessions })
  hostLog("moves", "a Thread left for its device", { move: input.move, folder: input.folder, sessions: sessions.length, checkpointBytes: checkpoint.bytes, ms: Math.round(performance.now() - began) })
  return departure
}
