import { hostLog, hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import {
  turnWaitItemKey,
  turnWaitMet,
  turnWaitNote,
  WAIT_HORIZON_MAX_S,
  WAIT_ITEMS_MAX,
  WAIT_LATE_MS,
  type TurnWait,
  type TurnWaitCancel,
  type TurnWaitItem,
} from "../contracts/turn-waits.js"
import { namedUuid } from "./cloud-moves.js"

/** What `TurnWaits` keeps its waits in: the Thread store's `turn_waits` (`ThreadStore`). */
export interface TurnWaitStore {
  armTurnWait(wait: TurnWait): { wait: TurnWait; replaced: TurnWait[]; existed: boolean }
  turnWait(id: string): TurnWait | undefined
  armedTurnWaits(): TurnWait[]
  noteTurnWaitMet(id: string, key: string, met: { at: number; words: string }): TurnWait | undefined
  claimTurnWait(id: string, fired: NonNullable<TurnWait["fired"]>): { wait: TurnWait | undefined; claimed: boolean }
  markTurnWaitDelivered(id: string, at: number): void
  cancelTurnWait(id: string, at: number, by: TurnWaitCancel): { wait: TurnWait | undefined; ended?: "cancelled" | "retired" }
  undeliveredTurnWaits(): TurnWait[]
  turnWaitOfRequest(request: string): TurnWait | undefined
}

export interface TurnWaitsDeps {
  store(): TurnWaitStore | undefined
  now(): number
  /**
   * Hands a fired wait's note to its conversation's queue under `wait.fired.request`, as Mako's words: `taken` once
   * the queue holds it (or held it already: the queue takes one request once), `later` when the conversation can't
   * take it now, which leaves it for the next start (`start`).
   */
  deliver(wait: TurnWait): Promise<"taken" | "later">
  /** Runs `fire` at `at`, at the earliest; answers how to cancel it. The host's is an unreferenced timer, a test's its clock. */
  timer(at: number, fire: () => void): () => void
  /** A conversation's armed wait changed (armed, met, fired, ended): its waiting line reads it again. */
  changed?(conversation: string): void
}

/** What arming asks for: `seconds` or `at` (epoch ms), never both; `items` and a time may go together, the time then the cap. */
export interface ArmTurnWait {
  conversation: string
  thread: string
  clientKey: string
  description: string
  items?: readonly TurnWaitItem[]
  returnWhen?: "any" | "all"
  seconds?: number
  at?: number
  /** Items the caller found met already as it arms, by `turnWaitItemKey`. */
  met?: Readonly<Record<string, { at: number; words: string }>>
}

export type ArmTurnWaitResult =
  | { refused: "never" | "too-long" | "invalid"; why: string }
  /** Everything it names is met already, so nothing was armed: the turn goes on. */
  | { alreadyDone: true; met: Record<string, { at: number; words: string }> }
  | { wait: TurnWait; replaced: TurnWait[]; existed: boolean }

/**
 * A Thread's waits on what its turn can't finish without (`contracts/turn-waits.ts`): kept in the Thread store from
 * the moment they're armed, met item by item by whoever watches each thing (`met`), timed by one timer at the nearest
 * end, and fired once each. The store's claim takes a wait from armed to fired in one write; its note goes under
 * a request named by the wait, which the live queue takes once, so a host that dies between the claim and the
 * handoff sends that same request on its next start and the agent hears it once. A wait cancelled between the claim
 * and the handoff is retired, and its handoff refuses it (`admits`).
 */
export class TurnWaits {
  private readonly deps: TurnWaitsDeps
  private cancelTimer: (() => void) | undefined
  private timerAt: number | undefined
  private stopped = false
  private readonly sending = new Map<string, Promise<void>>()

  constructor(deps: TurnWaitsDeps) {
    this.deps = deps
  }

  /** Arms a wait, replacing the conversation's armed one; refuses one that can never end or ends past seven days. */
  arm(input: ArmTurnWait): ArmTurnWaitResult {
    const store = this.deps.store()
    if (!store) return { refused: "invalid", why: "Mako's Thread store isn't open, so nothing can wait." }
    const now = this.deps.now()
    const items = [...(input.items ?? [])]
    const description = input.description.trim()
    if (!description) return { refused: "invalid", why: "Say in a few words what the wait is for, such as \"Waiting for CI on #412\"." }
    if (items.length > WAIT_ITEMS_MAX) return { refused: "invalid", why: `A wait names at most ${WAIT_ITEMS_MAX} things.` }
    if (input.seconds !== undefined && input.at !== undefined) return { refused: "invalid", why: "Pass seconds or at, not both." }
    if (input.seconds !== undefined && !(input.seconds >= 1)) return { refused: "invalid", why: "seconds is at least 1." }
    if (input.at !== undefined && input.at <= now) return { refused: "never", why: "That time has passed already." }
    const endsBy = input.seconds !== undefined ? now + input.seconds * 1000 : input.at
    if (endsBy !== undefined && endsBy - now > WAIT_HORIZON_MAX_S * 1000) return { refused: "too-long", why: "A wait ends within 7 days." }
    if (!items.length && endsBy === undefined) return { refused: "never", why: "A wait names something to wait on, a time, or both." }
    const keys = new Set<string>()
    for (const item of items) {
      const key = turnWaitItemKey(item)
      if (keys.has(key)) return { refused: "invalid", why: `It names ${key} twice.` }
      keys.add(key)
    }
    const returnWhen = input.returnWhen ?? "any"
    const met = Object.fromEntries(Object.entries(input.met ?? {}).filter(([key]) => keys.has(key)))
    if (items.length && turnWaitMet({ items, returnWhen, met })) return { alreadyDone: true, met }
    const armed = store.armTurnWait({
      id: namedUuid(`mako turn wait\0${input.conversation}\0${input.clientKey}`),
      thread: input.thread,
      conversation: input.conversation,
      description,
      items,
      returnWhen,
      ...(endsBy !== undefined && { endsBy }),
      createdAt: now,
      met,
      state: "armed",
    })
    if (!armed.existed) hostLog("waits", "armed", { wait: armed.wait.id, conversation: input.conversation, items: items.length, returnWhen, ...(endsBy !== undefined && { endsInMs: endsBy - now }), ...(armed.replaced.length && { replaced: armed.replaced.map((wait) => wait.id).join(" ") }) })
    this.schedule()
    this.deps.changed?.(input.conversation)
    return armed
  }

  /** One of a wait's items is met: kept, then the wait fires if that's what it waited for. */
  met(id: string, item: TurnWaitItem, words: string): void {
    const store = this.deps.store()
    if (!store || this.stopped) return
    const wait = store.noteTurnWaitMet(id, turnWaitItemKey(item), { at: this.deps.now(), words })
    if (!wait || wait.state !== "armed") return
    this.deps.changed?.(wait.conversation)
    if (turnWaitMet(wait)) this.fire(wait, "met")
  }

  /** Ends a wait without waking anyone, whoever asks; a fired one whose note hasn't gone is retired. */
  cancel(id: string, by: TurnWaitCancel): TurnWait | undefined {
    const store = this.deps.store()
    if (!store) return undefined
    const { wait, ended } = store.cancelTurnWait(id, this.deps.now(), by)
    if (wait && ended) {
      hostLog("waits", ended, { wait: id, conversation: wait.conversation, by })
      this.deps.changed?.(wait.conversation)
      this.schedule()
    }
    return wait
  }

  /**
   * Ends the conversation's waits (its Thread stopped, archived or moved): its armed one, and any fired one whose note
   * hasn't gone. Answers the ones it ended, for a move to tell the agent on arrival.
   */
  cancelOf(conversation: string, by: TurnWaitCancel): TurnWait[] {
    const store = this.deps.store()
    if (!store) return []
    const open = [...store.armedTurnWaits(), ...store.undeliveredTurnWaits()].filter((wait) => wait.conversation === conversation)
    return open.flatMap((wait) => {
      const ended = this.cancel(wait.id, by)
      return ended?.cancelled?.by === by ? [ended] : []
    })
  }

  /** At a note's handoff: it goes only while its wait wasn't cancelled since it fired. Any other request goes. */
  admits(request: string): boolean {
    const wait = this.deps.store()?.turnWaitOfRequest(request)
    return !wait || wait.cancelled === undefined
  }

  /** On the host's start: sends once what fired and wasn't delivered, fires what came due while it was down, and times the rest. */
  start(): void {
    const store = this.deps.store()
    if (!store) return
    for (const wait of store.undeliveredTurnWaits()) void this.send(wait)
    this.check()
  }

  /** Fires every armed wait whose time has come, late ones saying so; then times the next. The timer's and the backstop job's. */
  check(): void {
    const store = this.deps.store()
    if (!store || this.stopped) return
    const now = this.deps.now()
    for (const wait of store.armedTurnWaits()) if (wait.endsBy !== undefined && wait.endsBy <= now) this.fire(wait, "time")
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.timerAt = undefined
  }

  /** Delivery under way, for a test to await. */
  settled(): Promise<void> {
    return Promise.all(this.sending.values()).then(() => undefined)
  }

  private fire(wait: TurnWait, why: "met" | "time"): void {
    const store = this.deps.store()!
    const at = this.deps.now()
    const lateMs = why === "time" && wait.endsBy !== undefined ? at - wait.endsBy : 0
    const { wait: fired, claimed } = store.claimTurnWait(wait.id, {
      at,
      why,
      ...(lateMs > WAIT_LATE_MS && { lateMs }),
      request: namedUuid(`mako turn wait\0${wait.id}\0fired`),
      text: turnWaitNote(wait, why, at),
    })
    if (!claimed || !fired) return
    hostLog("waits", "fired", { wait: wait.id, conversation: wait.conversation, why, ...(lateMs > WAIT_LATE_MS && { lateMs }) })
    this.deps.changed?.(wait.conversation)
    void this.send(fired)
  }

  private send(wait: TurnWait): Promise<void> {
    const going = this.sending.get(wait.id)
    if (going) return going
    const sent = (async () => {
      try {
        const answer = await this.deps.deliver(wait)
        if (answer === "taken") this.deps.store()?.markTurnWaitDelivered(wait.id, this.deps.now())
        else hostLog("waits", "note held for the next start", { wait: wait.id, conversation: wait.conversation })
      } catch (error) {
        hostWarn("waits", "a wait's note didn't reach its conversation; the next start sends it", { wait: wait.id, error: errorMessage({ error }) })
      } finally {
        this.sending.delete(wait.id)
      }
    })()
    this.sending.set(wait.id, sent)
    return sent
  }

  /** One timer, at the nearest armed wait's end. */
  private schedule(): void {
    if (this.stopped) return
    const next = this.deps.store()?.armedTurnWaits().map((wait) => wait.endsBy).filter((at): at is number => at !== undefined).sort((a, b) => a - b)[0]
    if (next === this.timerAt) return
    this.cancelTimer?.()
    this.cancelTimer = undefined
    this.timerAt = next
    if (next !== undefined) this.cancelTimer = this.deps.timer(next, () => {
      this.timerAt = undefined
      this.cancelTimer = undefined
      this.check()
    })
  }
}
