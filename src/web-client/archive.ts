import { CloudArchiver, listedArchiveInputs, readCloudArchivePlan, type CloudArchivePlans, type CloudReturnSteps } from "@mako/host/contracts/cloud-archive"
import { clipReason } from "@mako/host/contracts/cloud-threads"
import { gatewayHostCalls, sendWithRepeats } from "@mako/host/contracts/gateway-host-calls"
import type { JsonValue } from "@mako/host/contracts/json"
import type { CloudArchiveOutcome, CloudArchiveStep } from "@mako/host/contracts/thread-lifecycle"
import { ReturnReleaseRequestSchema, ReturnStateSchema, type ReturnBeginRequest, type ReturnReasonRequestSchema, type ReturnState } from "@mako/protocol/moves"
import type { ClientSession } from "@mako/protocol"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { z } from "zod"
import { whileBusy } from "./busy"
import { ARCHIVE_PLANS, CONSOLE_LOG, GatewayError } from "./gateway"

/**
 * A cloud Thread archived from this browser exactly as a Mac archives one (`contracts/cloud-archive.ts`): the same
 * steps, refusals and plans, with the plans kept in this browser's storage, the account's return steps asked over the
 * gateway's API with this browser's token, and the Thread's machine called as this browser's device.
 */

/**
 * What an archive takes of the page's `Gateway`: the account's API with this browser's token (a refusal thrown as a
 * `GatewayError`), its sessions, and who is signed in.
 */
export type ArchiveGateway = {
  rest(method: "GET" | "POST", path: string, body?: ReturnRequest): Promise<JsonValue | undefined>
  readonly session: ClientSession
  connection(): Promise<{ account: { id: string } }>
}

/** What a step of a return sends, as the gateway reads it: where it goes, what the machine packed, or why it stopped. */
export type ReturnRequest = ReturnBeginRequest | z.input<typeof ReturnReleaseRequestSchema> | z.input<typeof ReturnReasonRequestSchema>

export type ArchiveCloudThreadOptions = {
  /** Archive it though its machine can't start: its records are kept, its checkout's changes since it last moved aren't. */
  anyway?: boolean
  /** The archive's ID: the same ID asked again answers how it went. A new one by default. */
  op?: string
  /** Each step as the archive takes it, for the screen that asked: its machine packing, then ending. */
  step?: (step: CloudArchiveStep["kind"]) => void
}

/**
 * Archives the cloud Thread `threadId` from this browser, packing what the account's list (`rows`) says runs on its
 * machine, or answers how the archive under `options.op` went. Archived, or refused with the person's reason, and
 * `anyway` when its machine couldn't start, to offer archiving it all the same. An archive of the Thread already
 * running from this page is joined. Rejects only when this browser can't keep the archive's plan.
 */
export function archiveCloudThread(gateway: ArchiveGateway, deviceId: string, threadId: string, rows: readonly ListedSession[], options: ArchiveCloudThreadOptions = {}): Promise<CloudArchiveOutcome> {
  const { archiver, steps } = archiverOf(gateway, deviceId)
  const { step } = options
  const heard = step && ((each: CloudArchiveStep) => {
    if (each.thread === threadId) step(each.kind)
  })
  if (heard) steps.add(heard)
  return whileBusy(archiver.archive(threadId, options.op ?? crypto.randomUUID(), options.anyway ?? false, () => listedArchiveInputs(rows, threadId))).finally(() => {
    if (heard) steps.delete(heard)
  })
}

/**
 * Settles every archive this browser left under way, as its plan stands (a page closed or reloaded mid-archive), so
 * none leaves its Thread fenced. Called once as the client starts; finished plans older than a week are forgotten.
 */
export async function settleArchives(gateway: ArchiveGateway, deviceId: string): Promise<void> {
  const plans = storedPlans(gateway)
  const forgetBefore = Date.now() - FORGET_AFTER_MS
  for (const op of await plans.list()) {
    const text = await plans.read(op)
    const plan = text === undefined ? undefined : readCloudArchivePlan(text)
    if (!plan || ((plan.phase === "archived" || plan.phase === "cancelled") && plan.began < forgetBefore)) await plans.forget(op)
  }
  await archiverOf(gateway, deviceId).archiver.settle()
}

/** How long a finished archive's plan is kept: asked again under its ID within it, it answers the same. */
const FORGET_AFTER_MS = 7 * 24 * 60 * 60 * 1000

type Archiving = { archiver: CloudArchiver; steps: Set<(step: CloudArchiveStep) => void> }
/** By gateway (one per signed-in page), its archiver: two asks for one Thread on the page join one archive. */
const archivers = new WeakMap<ArchiveGateway, Archiving>()

function archiverOf(gateway: ArchiveGateway, deviceId: string): Archiving {
  let archiving = archivers.get(gateway)
  if (archiving) return archiving
  const steps = new Set<(step: CloudArchiveStep) => void>()
  const account = returnSteps(gateway, deviceId)
  const archiver = new CloudArchiver({
    plans: storedPlans(gateway),
    account: () => account,
    callThread: (threadId, channel, args, conversationId, how) => {
      const calls = gatewayHostCalls(gateway.session, { threadId, actor: { kind: "client", client: "web", deviceId }, history: true, log: CONSOLE_LOG, ...(how?.refuseUnstarted && { refuseUnstarted: true }) })
      return sendWithRepeats(channel, calls.call(channel, args), { threadId, ...(conversationId && { conversationId }), log: CONSOLE_LOG })
    },
    step: (step) => {
      for (const heard of steps) heard(step)
    },
    log: CONSOLE_LOG,
    self: "This browser",
  })
  archiving = { archiver, steps }
  archivers.set(gateway, archiving)
  return archiving
}

/** A step the record went past, answered with the record (`returns.ts` at the gateway), as a Mac's account reads it. */
const PastStepSchema = z.object({ record: ReturnStateSchema })

/** The account's return steps over the gateway's API, as a Mac's `CloudAccount` asks them, with this browser's token. */
function returnSteps(gateway: ArchiveGateway, deviceId: string): CloudReturnSteps {
  const path = (threadId: string, move: string, step = "") => `/v1/threads/${encodeURIComponent(threadId)}/returns/${encodeURIComponent(move)}${step}`
  const ask = async (threadId: string, move: string, step: string, body: ReturnRequest): Promise<ReturnState> => {
    try {
      return ReturnStateSchema.parse(await gateway.rest("POST", path(threadId, move, step), body))
    } catch (error) {
      const past = error instanceof GatewayError && error.status === 409 ? PastStepSchema.safeParse(error.problem).data : undefined
      if (past) return past.record
      throw error
    }
  }
  return {
    deviceId: async () => deviceId,
    beginReturn: (threadId, move, to) => ask(threadId, move, "", to ? { to } : {}),
    archiveReturn: (threadId, move) => ask(threadId, move, "/archive", {}),
    releaseReturn: (threadId, move, departure) => ask(threadId, move, "/release", ReturnReleaseRequestSchema.parse({ departure })),
    cancelReturn: (threadId, move, reason) => ask(threadId, move, "/cancel", { reason: clipReason(reason) }),
    returnState: async (threadId, move) => {
      try {
        return ReturnStateSchema.parse(await gateway.rest("GET", path(threadId, move)))
      } catch (error) {
        // Not begun: the cloud recorded nothing under this ID.
        if (error instanceof GatewayError && error.status === 404) return undefined
        throw error
      }
    },
  }
}

/**
 * Archives' plans in this browser's storage, one key per archive under the signed-in account's, so a page reloaded
 * mid-archive finds its plan, and a browser signed in as someone else never settles another account's.
 */
function storedPlans(gateway: ArchiveGateway): CloudArchivePlans & { forget(op: string): Promise<void> } {
  const prefix = async () => `${ARCHIVE_PLANS}${(await gateway.connection()).account.id}:`
  return {
    read: async (op) => localStorage.getItem(`${await prefix()}${op}`) ?? undefined,
    write: async (op, text) => localStorage.setItem(`${await prefix()}${op}`, text),
    list: async () => {
      const mine = await prefix()
      const ops: string[] = []
      for (let index = 0; index < localStorage.length; index++) {
        const key = localStorage.key(index)
        if (key?.startsWith(mine)) ops.push(key.slice(mine.length))
      }
      return ops
    },
    forget: async (op) => localStorage.removeItem(`${await prefix()}${op}`),
  }
}
