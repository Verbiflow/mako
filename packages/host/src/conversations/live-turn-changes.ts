import type { LiveRequest } from "../contracts/live-conversations.js"
import { countedChanges, TURN_CHANGES_VERSION, type RequestChanges, type TurnChanges } from "../contracts/turn-changes.js"
import { hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import type { Resident } from "./live-runtime.js"

/** What counting a turn's changes asks of the attribution journal. */
export interface TurnLedger {
  /** The Thread and Session a conversation's turns are journaled under. */
  placement(conversationId: string): { thread: string; session: string } | undefined
  /** Every change heard so far journaled. */
  flushed(): Promise<void>
  /** Count a turn from the journal as it stands; undefined while the journal isn't open. */
  countTurn(thread: string, turn: string, state: TurnChanges["state"]): TurnChanges | undefined
  /** Whether every change by `at` has its author for good. */
  settledThrough(at: number): boolean
  /** Keep the summary beside the entries, for "changes made". */
  counted(summary: TurnChanges, session: string): void
  /** The Thread's turns with entries after `after`, each with its newest. */
  turnsChangedAfter(thread: string, after: number): Map<string, number>
  /** How long after a change the journal may still give it another author. */
  settleMs: number
}

/** Past this, a turn whose changes the journal holds open (a record still being read back) is counted as it stands. */
const GIVE_UP_MS = 120_000

/**
 * What each turn changed, counted by the attribution journal and kept with
 * its request (`LiveRequest.changes`), so the line under an answer, the
 * file links in it and "changes made" read one record, live or reopened.
 *
 * When a turn ends its request is marked `pending`, counted once the
 * journal has every change heard so far (`settling`), and counted for good
 * once the journal settles the changes up to its end (`settled`). A turn's
 * background work can write later, under the same turn: each settled count
 * also counts again any earlier turn of the conversation the journal has
 * newer entries for. A conversation stays in memory while a count is due;
 * one reopened with a count still due is counted when it loads.
 */
/** What counting asks of the conversations: the journal, and writing a conversation once its record changed. */
export interface TurnChangesHost {
  ledger(): TurnLedger | undefined
  flush(resident: Resident): void
}

export class LiveTurnChanges {
  private readonly host: TurnChangesHost

  constructor(host: TurnChangesHost) {
    this.host = host
  }

  private ledger(): TurnLedger | undefined {
    return this.host.ledger()
  }

  /** A request's turn ended, however it ended. */
  ended(resident: Resident, requestId: string): void {
    if (!resident.snapshot.requests.some((request) => request.id === requestId)) return
    this.write(resident, requestId, { version: TURN_CHANGES_VERSION, state: "pending" })
    this.host.flush(resident)
    this.follow(resident, requestId, Date.now())
  }

  /** A conversation read back in: its turns whose count was still due are counted now. */
  loaded(resident: Resident): void {
    for (const request of resident.snapshot.requests)
      if (request.changes && request.changes.state !== "settled") this.follow(resident, request.id, request.changes.state === "pending" ? Date.now() : request.changes.at)
  }

  private follow(resident: Resident, requestId: string, endedAt: number): void {
    const ledger = this.ledger()
    const placed = ledger?.placement(resident.snapshot.session.id)
    if (!ledger || !placed) return
    resident.counting = (resident.counting ?? 0) + 1
    const done = () => {
      resident.counting = Math.max(0, (resident.counting ?? 1) - 1)
    }
    const settle = () => {
      try {
        const now = Date.now()
        if (!ledger.settledThrough(endedAt) && now - endedAt < GIVE_UP_MS) {
          setTimeout(settle, ledger.settleMs / 4).unref?.()
          return
        }
        const summary = this.count(resident, ledger, placed.thread, requestId, "settled")
        if (summary) {
          ledger.counted(summary, placed.session)
          this.recountBehind(resident, ledger, placed, requestId)
        }
        this.host.flush(resident)
        done()
      } catch (error) {
        done()
        hostWarn("attribution", "a turn's changes could not be counted", { conversation: resident.snapshot.session.id, request: requestId, error: errorMessage({ error }) })
      }
    }
    void ledger.flushed().then(
      () => {
        if (this.count(resident, ledger, placed.thread, requestId, "settling")) this.host.flush(resident)
      },
      () => undefined,
    ).finally(() => {
      setTimeout(settle, Math.max(0, endedAt + ledger.settleMs - Date.now())).unref?.()
    })
  }

  /** Count one turn into its request; undefined when the journal isn't open or the request is gone. */
  private count(resident: Resident, ledger: TurnLedger, thread: string, requestId: string, state: TurnChanges["state"]): TurnChanges | undefined {
    const request = resident.snapshot.requests.find((item) => item.id === requestId)
    // A settled count stands until another settled one replaces it.
    if (!request || (state === "settling" && countedChanges(request.changes)?.state === "settled")) return undefined
    const summary = ledger.countTurn(thread, requestId, state)
    if (summary) this.write(resident, requestId, summary)
    return summary
  }

  /** Earlier turns the journal has newer entries for (their background work wrote since): counted again. */
  private recountBehind(resident: Resident, ledger: TurnLedger, placed: { thread: string; session: string }, except: string): void {
    const counted = resident.snapshot.requests.flatMap((request) => {
      const changes = countedChanges(request.changes)
      return changes?.state === "settled" && request.id !== except ? [{ request, changes }] : []
    })
    if (!counted.length) return
    const newest = ledger.turnsChangedAfter(placed.thread, Math.min(...counted.map((item) => item.changes.through)))
    for (const { request, changes } of counted) {
      if ((newest.get(request.id) ?? 0) <= changes.through) continue
      const summary = this.count(resident, ledger, placed.thread, request.id, "settled")
      if (summary) ledger.counted(summary, placed.session)
    }
  }

  private write(resident: Resident, requestId: string, changes: RequestChanges): void {
    resident.snapshot = {
      ...resident.snapshot,
      requests: resident.snapshot.requests.map((request): LiveRequest => (request.id === requestId ? { ...request, changes } : request)),
    }
  }
}
