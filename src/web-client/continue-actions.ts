import { continueRefusal, continueRefusalText, ContinueOfferSchema, ContinueStateSchema, CONTINUE_WAIT_MS, type ContinueOffer, type ContinueRefusal, type ContinueState } from "@mako/protocol/continues"
import { quietDevice, type ListedSession } from "@mako/protocol/thread-listing"
import { whileBusy } from "./busy"
import type { WebClient } from "./client"
import { useAccountList } from "./account-list"
import { CONSOLE_LOG, GatewayError, type Gateway } from "./gateway"
import { ASK_AGAIN_MS, type MoveMac } from "./move-actions"
import { endMove, movesStore, putMove, settledEnd } from "./moves"
import type { WebSession, WebThread } from "./threads"

/**
 * Continue in the cloud, from any device of the account: a Thread whose Mac is off (asleep, offline, quit) goes on in
 * a cloud machine from what the account holds of it (`@mako/protocol/continues`). The account carries it through for
 * the Mac; this browser presses it under an op ID, follows it as a move up to the cloud (`moves.ts`), and asks again
 * under the same ID when an answer is lost, so a press is never made twice.
 */

/** Whether a Session's Thread may continue in the cloud now, by every device's one rule, and why not in words. */
export type ContinueChoice = { offer: true; mac: MoveMac } | { offer: false; why: ContinueRefusal; text: string }

/**
 * The offer as the list says it: the Session's row and its Thread's, the quiet Macs and which of them take a continue
 * back. The gateway holds the press to the same rule, and says how fresh the account's copy of the Session is.
 */
export function continueChoice(session: WebSession, rows: readonly ListedSession[], quiet: ReadonlyMap<string, string>, continues: ReadonlySet<string>): ContinueChoice {
  const devices = [...quiet].map(([deviceId, since]) => quietDevice(deviceId, since, continues.has(deviceId)))
  const why = continueRefusal(session.row, rows, devices)
  if (why) return { offer: false, why, text: continueRefusalText(why, session.where) }
  if (session.row.runsOn.kind !== "device") return { offer: false, why: "cloud", text: continueRefusalText("cloud", session.where) }
  return { offer: true, mac: { deviceId: session.row.runsOn.deviceId, name: session.where } }
}

/** The offer, by every device's rule, for a Session of the list: undefined while the list has no word on its Mac. */
export function useContinueChoice(session: WebSession | undefined): ContinueChoice | undefined {
  const rows = useAccountList((state) => state.rows)
  const quiet = useAccountList((state) => state.quiet)
  const continues = useAccountList((state) => state.continues)
  return session ? continueChoice(session, rows, quiet, continues) : undefined
}

/**
 * Refusals worth saying beside the Thread: why it can't continue yet, and what would let it. The rest say nothing, a
 * Thread that never can (in the project folder, or not Mako's) among them: its Mac's quiet line is all there is to say.
 */
export function continueRefusalShown(why: ContinueRefusal): boolean {
  return why === "working" || why === "waiting" || why === "no-repository" || why === "older-device"
}

/** What the gateway says the continue would take, before the press: its branch, and how fresh each Session's copy is. */
export async function askContinueOffer(client: WebClient, session: string): Promise<ContinueOffer> {
  return ContinueOfferSchema.parse(await client.gateway.rest("GET", `/v1/sessions/${encodeURIComponent(session)}/continue`))
}

/**
 * Presses Continue in the cloud for a Thread, under a new op ID, and follows it to its end as a move up to the cloud:
 * made, arriving, then continued or failed with the account's reason. A refusal says why; an answer lost on the way is
 * asked again under the same ID until one comes.
 */
export async function startContinue(client: { gateway: Pick<Gateway, "rest"> }, ask: { thread: WebThread; session: WebSession; mac: MoveMac }, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<void> {
  const op = crypto.randomUUID()
  const thread = ask.thread.id
  putMove({ thread, conversation: ask.session.row.conversation, way: "cloud", mac: ask.mac, move: op, step: "asking", stepAt: Date.now(), handOff: false, ours: true, continued: true })
  const at = `/v1/sessions/${encodeURIComponent(ask.session.row.session)}/continue/${op}`
  CONSOLE_LOG.info("continue in the cloud pressed", { op, thread, session: ask.session.row.session, mac: ask.mac.deviceId })
  for (let attempt = 0; ; attempt++) {
    try {
      const answer = attempt === 0 ? whileBusy(client.gateway.rest("POST", at, {})) : client.gateway.rest("GET", `${at}?wait=${CONTINUE_WAIT_MS}`)
      const state = ContinueStateSchema.parse(await answer)
      if (heardContinue(thread, state)) return
      // Making or arriving: asked again at once, held open by the gateway while the machine arrives.
      attempt = Math.max(attempt, 1)
      continue
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      if (error instanceof GatewayError && error.status < 500 && error.status !== 408 && error.status !== 429) {
        CONSOLE_LOG.warn("continue in the cloud refused", { op, status: error.status, correlationId: error.correlationId ?? "", reason })
        return endMove(thread, op, { kind: "failed", reason })
      }
      endMove(thread, op, { kind: "unconfirmed", reason })
    }
    await wait(ASK_AGAIN_MS[Math.min(attempt, ASK_AGAIN_MS.length - 1)]!)
    const held = movesStore.get().moves.get(thread)
    if (!held || held.move !== op || settledEnd(held.end)) return
  }
}

/** A continue's state, as the strip says it: its step while it goes; whether it ended. */
function heardContinue(thread: string, state: ContinueState): boolean {
  if (state.phase === "continued") {
    endMove(thread, state.op, { kind: "done" })
    return true
  }
  if (state.phase === "failed") {
    endMove(thread, state.op, { kind: "failed", reason: state.reason ?? "It didn't continue in the cloud." })
    return true
  }
  const held = movesStore.get().moves.get(thread)
  if (held && held.move === state.op && (held.step !== state.phase || held.end)) putMove({ thread: held.thread, conversation: held.conversation, way: held.way, mac: held.mac, move: held.move, step: state.phase, stepAt: held.step === state.phase ? held.stepAt : Date.now(), handOff: false, ours: held.ours, continued: true })
  return false
}
