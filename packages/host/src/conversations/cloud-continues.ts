import { randomUUID } from "node:crypto"
import { ContinueOfferSchema, type ContinueOffer, type ContinuePhase } from "@mako/protocol/continues"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { hostLog, hostWarn } from "../base/host-log.js"
import { carryContinue, continuePath, ContinueProblemSchema, continueReadings, ContinueRecorder, problemWords, type ContinueAsk, type ContinueReading } from "../contracts/cloud-continues.js"
import type { ThreadContinueOffer, ThreadContinueOutcome, ThreadContinueStep } from "../contracts/cloud-threads.js"
import type { CloudAccount } from "../usage/index.js"

/** How long a follow is held open at the account at most: within a request's own time here (`REQUEST_MS`, 15 s). */
const HOLD_MS = 12_000

export interface CloudContinuesOptions {
  /** The account as this Mac's signed-in device asks it; undefined when signed out. */
  account(): Pick<CloudAccount, "askContinue"> | undefined
  /** The account's row for a conversation another device has, as its list says it now. */
  listed(conversationId: string): ListedSession | undefined
  /** Every row the account lists now, for the continues its rows say another device pressed. */
  rows(): Iterable<ListedSession>
  /** Messages waiting in the account for a Session, as its list says. */
  waiting(session: string): number
  /** A step of a continue pressed here, for every window (`thread-continue-step`). */
  step(conversationId: string, op: string, step: ThreadContinueStep): void
  now?: () => number
  wait?: (ms: number) => Promise<void>
}

/**
 * Continue in the cloud pressed on this Mac, for a Session of another device of the account that's off (asleep,
 * offline, quit), read here from its copy: the account carries it for that device (`@mako/protocol/continues`), and
 * this host carries the press, as a browser does (`carryContinue`, the one loop for both), so every window of this Mac
 * shows its steps and a window that closes mid-way loses nothing. A press is settled by its op ID: asked again under
 * the same one, it's the same continue, joined while it goes.
 */
export class CloudContinues {
  readonly #options: CloudContinuesOptions
  readonly #recorder: ContinueRecorder
  /** Presses under way here, by op, and the one each conversation's window follows now. */
  readonly #running = new Map<string, Promise<ThreadContinueOutcome>>()
  readonly #latest = new Map<string, string>()
  #closed = false

  constructor(options: CloudContinuesOptions) {
    this.#options = options
    this.#recorder = new ContinueRecorder(options.now)
  }

  /** What the account says a continue of the conversation's Thread would take now, and how many messages wait for it. */
  async offer(conversationId: string): Promise<ThreadContinueOffer> {
    const row = this.#row(conversationId)
    const correlationId = randomUUID()
    const answer = await this.#ask()({ method: "GET", path: continuePath(row.session), correlationId, first: false }, "continues.offer")
    if (answer.status < 200 || answer.status >= 300) throw new Error(problemWords(ContinueProblemSchema.safeParse(answer.body).data, answer.status))
    const offer: ContinueOffer = ContinueOfferSchema.parse(answer.body)
    hostLog("continues", "the account said whether a Thread may continue in the cloud", { session: row.session, thread: row.thread, offer: offer.offer, ...(!offer.offer && { why: offer.why }), correlationId })
    return { offer, waiting: this.#waitingFor(row) }
  }

  /** Presses Continue in the cloud for the conversation's Thread under `op`, and carries it to the account's last word. */
  press(conversationId: string, op: string): Promise<ThreadContinueOutcome> {
    const running = this.#running.get(op)
    if (running) return running
    const work = this.#press(conversationId, op).finally(() => this.#running.delete(op))
    this.#running.set(op, work)
    return work
  }

  /** Each continue this Mac pressed or its list says another device did, latest first, for Diagnostics. */
  readings(): ContinueReading[] {
    return continueReadings(this.#recorder.readings(), this.#options.rows())
  }

  /** The host is stopping: a press under way goes on in the account, and its windows read where it got to from the list. */
  close(): void {
    this.#closed = true
  }

  async #press(conversationId: string, op: string): Promise<ThreadContinueOutcome> {
    const row = this.#row(conversationId)
    const { session, thread } = row
    this.#latest.set(conversationId, op)
    this.#recorder.pressed(op, session, { thread, ...(row.threadTitle && { title: row.threadTitle }) })
    hostLog("continues", "continue in the cloud pressed here", { op, session, thread, from: row.runsOn.kind === "device" ? row.runsOn.deviceId : "cloud" })
    this.#options.step(conversationId, op, { kind: "asking" })
    let phase: ContinuePhase | undefined
    const ask = this.#ask()
    const end = await carryContinue({
      session,
      op,
      holdMs: HOLD_MS,
      ...(this.#options.now && { now: this.#options.now }),
      ...(this.#options.wait && { wait: this.#options.wait }),
      ask: (request) => ask(request, request.method === "POST" ? "continues.press" : "continues.follow"),
      goOn: () => !this.#closed && this.#latest.get(conversationId) === op,
      heard: (heard) => {
        this.#recorder.heard(op, heard)
        const { asked, correlationId, method, ms } = heard
        if (asked.kind === "state") {
          const state = asked.state
          if (state.phase === phase) return
          phase = state.phase
          hostLog("continues", "a continue pressed here went on", { op, phase, cloudThread: state.cloudThread, ...(state.machine && { machine: state.machine }), method, ms, correlationId })
          if (phase === "making" || phase === "arriving") this.#options.step(conversationId, op, { kind: phase })
        } else if (asked.kind === "refused") hostWarn("continues", "a continue pressed here was refused", { op, status: asked.status, reason: asked.reason, correlationId })
        else {
          hostWarn("continues", "a continue's answer was lost; asked again under its op", { op, method, ms, reason: asked.reason, correlationId })
          this.#options.step(conversationId, op, { kind: "unconfirmed", reason: asked.reason })
        }
      },
    })
    if (end.kind === "continued") {
      this.#options.step(conversationId, op, { kind: "continued", cloudThread: end.state.cloudThread })
      return { kind: "continued", cloudThread: end.state.cloudThread }
    }
    if (end.kind === "failed") {
      hostWarn("continues", "a continue pressed here failed", { op, session, reason: end.reason })
      this.#options.step(conversationId, op, { kind: "failed", reason: end.reason })
      return { kind: "failed", reason: end.reason }
    }
    hostLog("continues", "a continue pressed here stopped being followed; the account carries it on", { op, session })
    return { kind: "stopped" }
  }

  #row(conversationId: string): ListedSession {
    const row = this.#options.listed(conversationId)
    if (!row) throw new Error("This Session isn't in your account's list, so it can't continue in the cloud from here.")
    return row
  }

  #waitingFor(row: ListedSession): number {
    let count = 0
    for (const each of this.#options.rows()) if (each.thread === row.thread) count += this.#options.waiting(each.session)
    return count
  }

  /** The account's continue routes as this Mac asks them, as its device. */
  #ask(): (request: Parameters<ContinueAsk>[0], route: "continues.offer" | "continues.press" | "continues.follow") => ReturnType<ContinueAsk> {
    const account = this.#options.account()
    const askContinue = account?.askContinue
    if (!account || !askContinue) throw new Error("This Mac isn't signed in to Mako.")
    return ({ method, path, correlationId }, route) => askContinue.call(account, route, method, path, correlationId)
  }
}
