import type { ThreadMoveOutcome, ThreadReturnOutcome } from "@mako/host/contracts/cloud-threads"
import { whileBusy } from "./busy"
import type { WebClient } from "./client"
import type { MoveWay } from "./move-progress"
import { endMove, putMove } from "./moves"
import { macCall } from "./start"
import type { WebThread } from "./threads"

/** A Mac a move leaves, or comes back to. */
export type MoveMac = { deviceId: string; name: string }

/**
 * Asks the Mac to move a Thread up to the cloud (`mako:thread-move`), or to bring it back from there
 * (`mako:thread-return`), as the desk's own move does, and follows it until its end. A turn at work goes along: paused
 * on the Mac and carried on in the cloud. Asked once: a refusal says why and offers Retry, never repeats by itself.
 */
export async function startMove(client: WebClient, ask: { thread: WebThread; conversation: string; way: MoveWay; mac: MoveMac; handOff: boolean }): Promise<void> {
  const move = crypto.randomUUID()
  putMove({ thread: ask.thread.id, conversation: ask.conversation, way: ask.way, mac: ask.mac, move, step: "asking", stepAt: Date.now(), handOff: ask.handOff, ours: true })
  // A way back's steps are the Mac's, which isn't the conversation's owner while it's in the cloud: followed there.
  const conversations = await client.conversations()
  const stop = ask.way === "device" ? conversations.followMac(ask.mac.deviceId, ask.conversation) : undefined
  try {
    if (ask.way === "cloud") {
      const outcome = await whileBusy(macCall<ThreadMoveOutcome>(client.gateway, client.deviceId, ask.mac.deviceId, "mako:thread-move", [ask.conversation, move, { why: "asked" }]))
      endMove(ask.thread.id, move, outcome.kind === "moved" || outcome.kind === "released" ? { kind: "done" } : { kind: outcome.kind === "unsettled" ? "unsettled" : "failed", reason: outcome.reason })
    } else {
      const outcome = await whileBusy(macCall<ThreadReturnOutcome>(client.gateway, client.deviceId, ask.mac.deviceId, "mako:thread-return", [ask.conversation, move]))
      endMove(ask.thread.id, move, outcome.kind === "back" ? { kind: "done" } : { kind: outcome.kind === "unsettled" ? "unsettled" : "failed", reason: outcome.reason })
    }
  } catch (error) {
    endMove(ask.thread.id, move, { kind: "failed", reason: error instanceof Error ? error.message : String(error) })
  } finally {
    stop?.()
  }
}

