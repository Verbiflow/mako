import { carryContinue, ContinueRecorder, type ContinueAsk } from "@mako/host/contracts/cloud-continues"
import { continueRefusal, continueRefusalText, ContinueOfferSchema, type ContinueOffer, type ContinueRefusal, type ContinueState } from "@mako/protocol/continues"
import { quietDevice, type ListedSession } from "@mako/protocol/thread-listing"
import { whileBusy } from "./busy"
import type { WebClient } from "./client"
import { useAccountList } from "./account-list"
import { CONSOLE_LOG, GatewayError, type Gateway } from "./gateway"
import type { MoveMac } from "./move-actions"
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

/** What the gateway says the continue would take, before the press: its branch, and how fresh each Session's copy is. */
export async function askContinueOffer(client: WebClient, session: string): Promise<ContinueOffer> {
  return ContinueOfferSchema.parse(await client.gateway.rest("GET", `/v1/sessions/${encodeURIComponent(session)}/continue`))
}

/** Each continue this browser pressed, for its Diagnostics (`ContinueRecorder`), as a Mac's host keeps its own. */
export const webContinues = new ContinueRecorder()

/** The account's continue routes as this browser asks them: the press shown busy, a refusal read as its answer. */
export function gatewayContinueAsk(gateway: Pick<Gateway, "rest">): ContinueAsk {
  return async ({ method, path, correlationId, first }) => {
    try {
      const answer = gateway.rest(method, path, method === "POST" ? {} : undefined, { correlationId })
      return { status: 200, body: await (first ? whileBusy(answer) : answer) }
    } catch (error) {
      if (error instanceof GatewayError) return { status: error.status, body: error.problem ?? { title: error.message } }
      throw error
    }
  }
}

/**
 * Presses Continue in the cloud for a Thread, under a new op ID, and follows it to its end as a move up to the cloud
 * (`carryContinue`, the loop a Mac's host carries its own press with): made, arriving, then continued or failed with
 * the account's reason. A refusal says why; an answer lost on the way is not confirmed, and asked again under the same
 * ID until one comes.
 */
export async function startContinue(client: { gateway: Pick<Gateway, "rest"> }, ask: { thread: WebThread; session: WebSession; mac: MoveMac }, wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))): Promise<void> {
  const op = crypto.randomUUID()
  const thread = ask.thread.id
  const session = ask.session.row.session
  putMove({ thread, conversation: ask.session.row.conversation, way: "cloud", mac: ask.mac, move: op, step: "asking", stepAt: Date.now(), handOff: false, ours: true, continued: true })
  webContinues.pressed(op, session, { thread, title: ask.thread.title })
  CONSOLE_LOG.info("continue in the cloud pressed", { op, thread, session, mac: ask.mac.deviceId })
  const end = await carryContinue({
    session,
    op,
    ask: gatewayContinueAsk(client.gateway),
    wait,
    heard: (heard) => {
      webContinues.heard(op, heard)
      const { asked, correlationId } = heard
      if (asked.kind === "state") stepped(thread, asked.state)
      else if (asked.kind === "refused") CONSOLE_LOG.warn("continue in the cloud refused", { op, status: asked.status, correlationId, reason: asked.reason })
      else {
        CONSOLE_LOG.warn("continue in the cloud: an answer was lost; asked again under its op", { op, method: heard.method, correlationId, reason: asked.reason })
        endMove(thread, op, { kind: "unconfirmed", reason: asked.reason })
      }
    },
    goOn: () => {
      const held = movesStore.get().moves.get(thread)
      return held !== undefined && held.move === op && !settledEnd(held.end)
    },
  })
  if (end.kind === "continued") endMove(thread, op, { kind: "done" })
  else if (end.kind === "failed") endMove(thread, op, { kind: "failed", reason: end.reason })
  CONSOLE_LOG.info("continue in the cloud ended here", { op, thread, end: end.kind, ...(end.kind === "failed" && { reason: end.reason }) })
}

/** A continue under way, as the strip says it: its step, once the account says it's on to another (or answered again). */
function stepped(thread: string, state: ContinueState): void {
  if (state.phase === "continued" || state.phase === "failed") return
  const held = movesStore.get().moves.get(thread)
  if (held && held.move === state.op && (held.step !== state.phase || held.end)) putMove({ thread: held.thread, conversation: held.conversation, way: held.way, mac: held.mac, move: held.move, step: state.phase, stepAt: held.step === state.phase ? held.stepAt : Date.now(), handOff: false, ours: held.ours, continued: true })
}
