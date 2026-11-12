import { hostLog } from "../base/host-log.js"
import type { SessionSettings } from "@mako/sessions/settings"
import type { ContextTransfer, TransferInput } from "../contracts/conversation-control.js"
import type { LiveSnapshot, TurnContinuation } from "../contracts/live-conversations.js"
import type { PromptAttachment } from "../contracts/providers-acp.js"
import type { Actor } from "../contracts/thread-identity.js"
import type { LiveConversations } from "./live-conversations.js"

/** Where a Thread goes next: a harness, or the one it's on with another account or a connection's model (`tuning`). */
export interface ThreadTarget {
  harness: string
  account?: string
  tuning?: SessionSettings
  modeId?: string
}

/**
 * A Thread moved as an agent or Mako moves one, whoever's Thread it is: an Apex's own or its Fin's. Nothing is asked of
 * the harness it leaves. It has no message of its own: every waiting row stays a row and goes on the target at commit,
 * in order, the transcript going with the first, and a hold about the account it leaves goes (`arriving`).
 */
export interface ThreadMove {
  /** The move's own ID: `switchSettled` follows it, and a repeat is the same move. */
  id: string
  to: ThreadTarget
  /** The row that goes first at commit, ahead of what waited longer: a digest held for an Apex. */
  first?: string
  /** It yields to a Stop: an automatic move sets this, and is declined while the Stop's latch stands. */
  unlessStopped?: true
}

/** A reply to one of a conversation's dormant bindings: the person going back to a session they left. */
export interface BindingReply {
  bindingId: string
  provider: string
  requestId: string
  text: string
  attachments?: PromptAttachment[]
  tuning?: SessionSettings
}

/** What goes on the destination: the person's words (their switch), a move, or a reply to a dormant binding. */
export type Continuation =
  | { kind: "words"; input: TransferInput; continues?: TurnContinuation }
  | { kind: "move"; move: ThreadMove }
  | { kind: "reply"; reply: BindingReply }

export interface ContinueOnDeps {
  live: Pick<LiveConversations, "session" | "historyReady" | "transfer" | "moveOn" | "continueBinding" | "admitInOrder" | "stopMark" | "stopHolds">
  /** Whether `harness`'s session goes on under another account (`ProviderLiveDriver.accountContinuation`); without it, another account is a hand-over. */
  resumesUnderAccount?(harness: string): boolean
  /** The selection as the harness takes it (`HarnessProfiles.resolveLaunch`). */
  resolveLaunch(provider: string, cwd: string | undefined, tuning: SessionSettings | undefined): Promise<SessionSettings | undefined>
  /**
   * A selection carried onto another harness as that harness lists it (`HarnessProfiles.carried`): never a model it
   * doesn't list, nor another harness's encoding of one, which it would refuse at every send.
   */
  carried?(provider: string, cwd: string | undefined, tuning: SessionSettings | undefined): Promise<SessionSettings | undefined>
  /** Counts a harness switched to (`HostTelemetry.feature`). */
  switched(provider: string): void
}

/** `continueOn`: the one way a Thread goes on on another harness, whoever asks. */
export type ContinueOn = (id: string, continuation: Continuation, actor?: Actor, stillDecided?: () => boolean) => Promise<LiveSnapshot | undefined>

function destination(continuation: Continuation) {
  if (continuation.kind === "move") return { provider: continuation.move.to.harness, tuning: continuation.move.to.tuning }
  const { provider, tuning } = continuation.kind === "words" ? continuation.input : continuation.reply
  return { provider, tuning }
}

/**
 * This Thread continues on that harness. The person's switch, `agents_move`, a Fin's relaunch and a Fin's automatic
 * move all come here, with `actor` saying who asked: the selection is resolved, the history the transcript is written
 * from is read, and the switch is admitted (`LiveTransfers.accept`), its transcript carrying the conversation over.
 * Nothing but this reaches `LiveConversations.transfer` for another harness (`scripts/test-fin-move.ts` fails on a
 * caller that does). A Stop that lands in those waits wins: a move is declined, and what a person asked for is accepted
 * and held. `stillDecided` is what a move was decided on, which the waits may have changed too: read at admission and,
 * for a switch, again with nothing awaited before its commit. False declines it: the answer is undefined, or, past
 * admission, its switch settles failed.
 */
export function continueOn(deps: ContinueOnDeps): ContinueOn {
  /** Whether the session goes on where it is: no switch, only another model, or an account it can go on under. */
  const stays = (harness: string | undefined, to: ThreadTarget) =>
    harness === to.harness && (to.account === undefined || deps.resumesUnderAccount?.(to.harness) === true)
  return async (id, continuation, actor, stillDecided) => {
    const { live } = deps
    // Owned before anything is waited for: a Stop that lands in these waits is read here, not guessed from what it left.
    const mark = live.stopMark(id)
    const stoppedSince = () => live.stopMark(id) !== mark
    const before = live.session(id)
    const { provider, tuning: asked } = destination(continuation)
    // A reply to the active binding sends what it would with or without the history; a read that fails doesn't refuse it.
    const history = continuation.kind === "reply" ? live.historyReady(id).catch(() => undefined) : live.historyReady(id)
    // Onto another harness, what was chosen on the one it leaves goes only as far as the target lists it.
    const fitted = before && before.harness !== provider && deps.carried ? deps.carried(provider, before.cwd, asked) : Promise.resolve(asked)
    const ready = Promise.all([fitted.then((tuning) => deps.resolveLaunch(provider, before?.cwd, tuning)), history]).then(([tuning]) => tuning)
    const admitted = await live.admitInOrder(id, ready, (tuning) => {
      // The resolved selection replaces what was asked, an empty one too: what the target doesn't list never rides along.
      const withTuning = { tuning }
      if (continuation.kind === "move") {
        const { move } = continuation
        return live.moveOn(id, { ...move, to: { ...move.to, ...withTuning } }, stays(before?.harness, move.to), actor, () => !stoppedSince() && (stillDecided?.() ?? true))
      }
      // What Mako decided yields to the Stop. What someone asked for was asked first: it's accepted, and the Stop holds it.
      if (stillDecided && (stoppedSince() || !stillDecided())) return undefined
      const taken = continuation.kind === "words"
        ? live.transfer(id, { ...continuation.input, ...withTuning }, actor, continuation.continues)
        : live.continueBinding(id, continuation.reply.bindingId, continuation.reply.requestId, continuation.reply.text, continuation.reply.attachments, tuning, undefined, actor)
      if (stoppedSince()) live.stopHolds(id)
      return taken
    })
    if (admitted) {
      hostLog("transfer", "a Thread continues on a harness", { conversation: id, from: before?.harness ?? "", to: provider, by: actor?.kind ?? "person" })
      if (before?.harness !== provider) deps.switched(provider)
    }
    return admitted
  }
}

/** How a switch settled, or undefined while it's still under way after `withinMs`. */
export async function settledWithin(settled: Promise<ContextTransfer>, withinMs: number): Promise<ContextTransfer | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((done) => { timer = setTimeout(() => done(undefined), withinMs) })
  try {
    return await Promise.race([settled, late])
  } finally {
    clearTimeout(timer)
  }
}
