import type { ThreadMoveOutcome, ThreadReturnOutcome } from "@mako/host/contracts/cloud-threads"
import { OwnerUnavailableError, RuntimeDisconnectedError } from "@mako/host/contracts/host-connection"
import { continueTreeCut } from "@mako/protocol/continues"
import { treeCutWords } from "@mako/protocol/moves"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { whileBusy } from "./busy"
import type { WebClient } from "./client"
import type { MoveWay } from "./move-progress"
import { endMove, movesStore, putMove, settledEnd, type MoveEnd } from "./moves"
import { macCall } from "./start"
import type { WebThread } from "./threads"

/** A Mac a move leaves, or comes back to. */
export type MoveMac = { deviceId: string; name: string }

/** A move asked of a Mac, by its ID: the Thread, the conversation it was asked from, which way and which Mac. */
export interface MoveAsk {
  thread: string
  conversation: string
  way: MoveWay
  mac: MoveMac
  move: string
}

/**
 * Why its tree of agents keeps a Thread on its Mac, before the move is asked: the Mac's own rule (`treeCut`) read from
 * the account's list, where an Apex's row says its Fins and names each Fin's Thread, in the Mac's own sentence with
 * its name. The sheet says it in place of its button. Undefined when nothing the list says keeps it; the Mac still
 * weighs the move itself.
 */
export function moveKept(row: ListedSession, rows: readonly ListedSession[], mac: string): string | undefined {
  const cut = continueTreeCut(row, rows)
  return cut && treeCutWords(cut, mac)
}

/** How long this browser waits before asking again after a move's answer was lost: soon, then less and less often. */
export const ASK_AGAIN_MS = [2_000, 5_000, 10_000, 30_000] as const

/**
 * Asks the Mac to move a Thread up to the cloud (`mako:thread-move`), or to bring it back from there
 * (`mako:thread-return`), as the desk's own move does, and follows it until its end. A turn at work goes along: paused
 * on the Mac and carried on in the cloud. A refusal says why and offers Retry, a new move; never repeated by itself.
 * One by its tree of agents offers none: asked again, the Mac would say the same.
 */
export async function startMove(client: WebClient, ask: { thread: WebThread; conversation: string; way: MoveWay; mac: MoveMac; handOff: boolean }): Promise<void> {
  const move = crypto.randomUUID()
  putMove({ thread: ask.thread.id, conversation: ask.conversation, way: ask.way, mac: ask.mac, move, step: "asking", stepAt: Date.now(), handOff: ask.handOff, ours: true })
  // A way back's steps are the Mac's, which isn't the conversation's owner while it's in the cloud: followed there.
  const conversations = await client.conversations()
  const stop = ask.way === "device" ? conversations.followMac(ask.mac.deviceId, ask.conversation) : undefined
  try {
    await followAnswer({ thread: ask.thread.id, conversation: ask.conversation, way: ask.way, mac: ask.mac, move }, (attempt) => askMac(client, ask.way, ask.mac, ask.conversation, move, attempt))
  } finally {
    stop?.()
  }
}

/** One ask of the Mac for a move by its ID: the first starts it, a repeat joins it or answers how it went. */
function askMac(client: WebClient, way: MoveWay, mac: MoveMac, conversation: string, move: string, attempt: number): Promise<MoveEnd> {
  const ask = way === "cloud"
    ? macCall<ThreadMoveOutcome>(client.gateway, client.deviceId, mac.deviceId, "mako:thread-move", [conversation, move, { why: "asked" }]).then(cloudEnd)
    : macCall<ThreadReturnOutcome>(client.gateway, client.deviceId, mac.deviceId, "mako:thread-return", [conversation, move]).then(deviceEnd)
  return attempt === 0 ? whileBusy(ask) : ask
}

function cloudEnd(outcome: ThreadMoveOutcome): MoveEnd {
  if (outcome.kind === "moved" || outcome.kind === "released") return { kind: "done" }
  return outcome.kind === "unsettled" ? { kind: "unsettled", reason: outcome.reason } : { kind: "failed", reason: outcome.reason, ...outcome.tree && { tree: true as const } }
}

function deviceEnd(outcome: ThreadReturnOutcome): MoveEnd {
  return outcome.kind === "back" ? { kind: "done" } : { kind: outcome.kind === "unsettled" ? "unsettled" : "failed", reason: outcome.reason }
}

/** Asks waiting to ask again, by move: Ask again ends the wait at once. */
const waits = new Map<string, () => void>()

/** Asks the Mac again now for a move whose answer was lost, under the same ID: never a second move. */
export function askAgain(move: string): void {
  waits.get(move)?.()
}

/**
 * Follows a move's answer to its end, by its ID. The owner's answer ends it. A call the transport lost (the phone slept
 * mid-move, the network went) says nothing of the move, which goes on on the Mac: it's not confirmed, said so, and the
 * Mac is asked again under the same move ID, which it settles by (a repeat joins the move or answers how it went),
 * until it answers or a step it sends meanwhile says the end. Only a first ask the Mac never took (it's off) has
 * started nothing, and says so as a failure.
 */
export async function followAnswer(ask: MoveAsk, call: (attempt: number) => Promise<MoveEnd>, wait: (ms: number, move: string) => Promise<void> = pause): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return endMove(ask.thread, ask.move, await call(attempt))
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (!(error instanceof RuntimeDisconnectedError)) return endMove(ask.thread, ask.move, { kind: "failed", reason })
      if (attempt === 0 && error instanceof OwnerUnavailableError && !error.unconfirmed) return endMove(ask.thread, ask.move, { kind: "failed", reason })
      endMove(ask.thread, ask.move, { kind: "unconfirmed", reason })
    }
    await wait(ASK_AGAIN_MS[Math.min(attempt, ASK_AGAIN_MS.length - 1)]!, ask.move)
    // Heard meanwhile from its steps, put away, or followed by another move: nothing more to ask.
    const held = movesStore.get().moves.get(ask.thread)
    if (!held || held.move !== ask.move || settledEnd(held.end)) return
  }
}

/** Waits `ms`, or less if Ask again is pressed, and while the page is hidden until it's back. */
function pause(ms: number, move: string): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      document.removeEventListener("visibilitychange", shown)
      waits.delete(move)
      resolve()
    }
    const shown = () => {
      if (document.visibilityState === "visible") done()
    }
    const timer = setTimeout(() => {
      if (document.visibilityState === "visible") done()
      else document.addEventListener("visibilitychange", shown)
    }, ms)
    waits.set(move, done)
  })
}
