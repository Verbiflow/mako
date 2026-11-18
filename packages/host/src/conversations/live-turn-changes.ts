import type { LiveRequest } from "../contracts/live-conversations.js"
import { countedChanges, TURN_CHANGES_VERSION, type RequestChanges, type TurnChanges } from "../contracts/turn-changes.js"
import { hostWarn } from "../base/host-log.js"
import { errorMessage } from "../base/error-message.js"
import type { Resident } from "./live-runtime.js"

/** What counting a turn's changes asks of the attribution journal. */
export interface TurnLedger {
  /** The Thread and Session a conversation's turns are journaled under. */
  placement(conversationId: string): { thread: string; session: string } | undefined
  /** The checkout's heard changes journaled; false keeps the final count pending until its existing give-up deadline. */
  flushed(checkout?: string): Promise<void | boolean>
  /** Count a turn off the host's thread; undefined while its journal is closed or has been replaced. */
  countTurn(thread: string, turn: string, state: TurnChanges["state"]): Promise<TurnChanges | undefined>
  /** Whether every change by `at` has its author for good. */
  settledThrough(at: number): boolean
  /**
   * Resolves once the journal says every change by `at` has its author for good, or after `withinMs` at the latest
   * (sooner where this host can't hear the journal's writer say so). Absent, the count asks again every quarter of
   * `settleMs`.
   */
  settledAfter?(at: number, withinMs: number): Promise<void>
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
  /** The count under way, if any: one runs at a time, so a count that began later is never written over by one that began before it. */
  private counting: Promise<unknown> = Promise.resolve()

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
    const failed = (error: Error) =>
      hostWarn("attribution", "a turn's changes could not be counted", { conversation: resident.snapshot.session.id, request: requestId, error: errorMessage({ error }) })
    let flushFailed = false
    const settle = () => {
      void (async () => {
        // A shell reconciliation (or its lag window) can have completed since the initial settling count.
        let flushed: boolean
        try { flushed = (await ledger.flushed(resident.snapshot.session.cwd)) !== false; flushFailed = false } catch (error) {
          flushed = false
          if (!flushFailed) failed(error instanceof Error ? error : new Error("The journal could not be flushed", { cause: error }))
          flushFailed = true
        }
        if ((!flushed || !ledger.settledThrough(endedAt)) && Date.now() - endedAt < GIVE_UP_MS) {
          // Heard and not settled yet: the journal's writer says when it is, so nothing is asked meanwhile. Each try
          // was a command to the writer, a request to the journal's owner and a read, every 2.5 s for up to two minutes.
          if (flushed && ledger.settledAfter) void ledger.settledAfter(endedAt, Math.max(0, endedAt + GIVE_UP_MS - Date.now())).then(settle, settle)
          else setTimeout(settle, ledger.settleMs / 4).unref?.()
          return false
        }
        const summary = await this.count(resident, ledger, placed.thread, requestId, "settled")
        if (summary) {
          ledger.counted(summary, placed.session)
          await this.recountBehind(resident, ledger, placed, requestId)
        }
        this.host.flush(resident)
        return true
      })().then((ended) => ended && done(), (error: Error) => {
        done()
        failed(error)
      })
    }
    void ledger.flushed(resident.snapshot.session.cwd).then(
      async () => {
        if (await this.count(resident, ledger, placed.thread, requestId, "settling")) this.host.flush(resident)
      },
      () => undefined,
    ).catch(failed).finally(() => {
      setTimeout(settle, Math.max(0, endedAt + ledger.settleMs - Date.now())).unref?.()
    })
  }

  /** Count one turn into its request, after any count under way; undefined when the journal isn't open or the request is gone. */
  private count(resident: Resident, ledger: TurnLedger, thread: string, requestId: string, state: TurnChanges["state"]): Promise<TurnChanges | undefined> {
    const due = () => {
      const request = resident.snapshot.requests.find((item) => item.id === requestId)
      // A settled count stands until another settled one replaces it.
      return request !== undefined && !(state === "settling" && countedChanges(request.changes)?.state === "settled")
    }
    const counted = this.counting.then(async () => {
      if (!due()) return undefined
      const summary = await ledger.countTurn(thread, requestId, state)
      // Read again: the request may have gone, or a settled count landed, while this one ran.
      if (!summary || !due()) return undefined
      this.write(resident, requestId, summary)
      return summary
    })
    this.counting = counted.catch(() => undefined)
    return counted
  }

  /** Earlier turns the journal has newer entries for (their background work wrote since): counted again. */
  private async recountBehind(resident: Resident, ledger: TurnLedger, placed: { thread: string; session: string }, except: string): Promise<void> {
    const counted = resident.snapshot.requests.flatMap((request) => {
      const changes = countedChanges(request.changes)
      return changes?.state === "settled" && request.id !== except ? [{ request, changes }] : []
    })
    if (!counted.length) return
    const newest = ledger.turnsChangedAfter(placed.thread, Math.min(...counted.map((item) => item.changes.through)))
    for (const { request, changes } of counted) {
      if ((newest.get(request.id) ?? 0) <= changes.through) continue
      const summary = await this.count(resident, ledger, placed.thread, request.id, "settled")
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
