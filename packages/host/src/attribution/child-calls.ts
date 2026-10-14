import { createHash } from "node:crypto"
import type { ActivityMark, ReportedCall } from "@mako/protocol"
import type { ChildSource } from "@mako/sessions"
import { savedToolEffects } from "@mako/sessions/tool-effect-reading"
import { reportedEffect } from "./live-activity.js"

/*
 * The calls a session's child agents make, foreground or in the
 * background, read from each child's own record: no harness's live wire
 * reports them all (Claude's carries a subagent's calls only inside its
 * parent's, and nothing carries a background agent's after its parent's
 * turn ends). Each is the parent Session's call, so a subagent's edit is as
 * exact as the Session's own.
 *
 * A record is read only when it may name an author: a change came out
 * uncertain while the Session was running, its turn or background work
 * ended, or a call of its ended while a change is still unsure. A call read
 * after its change settled names it by its content. Listing children can be slow (a Devin session
 * keeps them in its database), so each Session waits ten times its last
 * listing before the next.
 */

/** A Session's records are read at most this often. */
const MIN_GAP_MS = 2_000
/** And at least this often while wanted, however slow its listing. */
const MAX_GAP_MS = 60_000
/** A harness writes its record a moment after the call: a read this soon after an end finds it. */
const END_DELAY_MS = 400
/** A read that takes longer stops holding changes open. */
const READ_TIMEOUT_MS = 15_000
/** A call that started this long before the Session was first followed is history: its content still counts, its timing doesn't. */
const SINCE_SLACK_MS = 60_000
/** `ReportedCall.call`'s limit. */
const CALL_ID_MAX = 200

export interface ChildCallsDeps {
  records: ChildSource
  /** A child's call that ran while the Session was followed, as the Session's own. */
  reported(call: ReportedCall): void
  /** Calls without timing, or from before the Session was followed: for their content alone. */
  reconcile(calls: readonly ReportedCall[]): Promise<{ entries: number; lines: number }>
  /** Keep open changes open; the returned function lets go. */
  hold(): () => void
  /** Whether any open change is still uncertain. */
  unsure(): boolean
  now(): number
  log?(message: string, facts: Readonly<Record<string, string | number | boolean>>): void
}

interface Child {
  stamp: string
  /** Each call sent, by its id, with what it said when sent. */
  sent: Map<string, string>
}

interface Followed {
  thread: string
  session: string
  record?: string
  checkout?: string
  turn?: string
  since: number
  children: Map<string, Child>
  nextAt: number
  timer?: ReturnType<typeof setTimeout>
  reading: boolean
  again: boolean
}

export class ChildCalls {
  private readonly deps: ChildCallsDeps
  private readonly sessions = new Map<string, Followed>()
  private closed = false

  constructor(deps: ChildCallsDeps) {
    this.deps = deps
  }

  /** A mark the live conversations sent: who runs where, and what just ended. */
  marked(mark: ActivityMark): void {
    let followed = this.sessions.get(mark.session)
    if (!followed) {
      followed = { thread: mark.thread, session: mark.session, since: mark.at, children: new Map(), nextAt: 0, reading: false, again: false }
      this.sessions.set(mark.session, followed)
    }
    followed.thread = mark.thread
    if (mark.record) followed.record = mark.record
    if (mark.checkout) followed.checkout = mark.checkout
    if (mark.kind === "turn") followed.turn = mark.edge === "start" ? mark.id : undefined
    // A turn or background work ending is when its last calls reach the record; a change may have settled unsure before.
    if (mark.edge === "end" && (mark.kind !== "call" || this.deps.unsure())) this.want(followed, END_DELAY_MS)
  }

  /** A change came out uncertain while these Sessions were running. */
  uncertain(sessions: Iterable<string>): void {
    for (const session of sessions) {
      const followed = this.sessions.get(session)
      if (followed) this.want(followed, 0)
    }
  }

  /** Whether no read is waiting or running. */
  idle(): boolean {
    for (const followed of this.sessions.values()) if (followed.timer || followed.reading) return false
    return true
  }

  close(): void {
    this.closed = true
    for (const followed of this.sessions.values()) clearTimeout(followed.timer)
  }

  private want(followed: Followed, delay: number): void {
    if (this.closed || !followed.record) return
    if (followed.reading) {
      followed.again = true
      return
    }
    if (followed.timer) return
    const wait = Math.max(delay, followed.nextAt - this.deps.now())
    followed.timer = setTimeout(() => {
      followed.timer = undefined
      void this.read(followed)
    }, wait)
    followed.timer.unref?.()
  }

  private async read(followed: Followed): Promise<void> {
    const record = followed.record
    if (this.closed || !record) return
    followed.reading = true
    const release = this.deps.hold()
    const timeout = setTimeout(release, READ_TIMEOUT_MS)
    timeout.unref?.()
    const started = this.deps.now()
    let listed = 0
    try {
      const found = await this.deps.records.children(record)
      listed = this.deps.now() - started
      const late: ReportedCall[] = []
      for (const child of found?.children ?? []) {
        if (!child.path || child.state.kind === "missing") continue
        let known = followed.children.get(child.nativeId)
        const stamp = `${child.updatedAt ?? ""}|${child.state.kind}`
        if (known && child.updatedAt && known.stamp === stamp) continue
        const thread = await this.deps.records.open(child.path)
        if (!thread) continue
        known ??= { stamp, sent: new Map() }
        known.stamp = stamp
        followed.children.set(child.nativeId, known)
        for (const call of savedToolEffects(thread.ref.harness, thread.entries, thread.ref.cwd)) {
          if (!call.effects.length) continue
          const id = callId(child.nativeId, call.callId)
          const said = `${call.status}|${call.endedAt ?? ""}|${call.effects.length}`
          if (known.sent.get(id) === said) continue
          known.sent.set(id, said)
          const reported: ReportedCall = {
            thread: followed.thread,
            session: followed.session,
            call: id,
            status: call.status,
            effects: call.effects.map(reportedEffect),
          }
          if (followed.turn) reported.turn = followed.turn
          if (followed.checkout) reported.checkout = followed.checkout
          if (call.startedAt !== undefined) reported.startedAt = call.startedAt
          if (call.endedAt !== undefined) reported.endedAt = call.endedAt
          const timed = call.startedAt !== undefined && call.startedAt >= followed.since - SINCE_SLACK_MS
          if (timed) this.deps.reported(reported)
          // A late report reaches a change that settled before it was read, by its content.
          late.push(reported)
        }
      }
      if (late.length) await this.deps.reconcile(late)
    } catch (error) {
      this.deps.log?.("child records could not be read", { record, error: error instanceof Error ? error.message : String(error) })
    } finally {
      clearTimeout(timeout)
      release()
      followed.reading = false
      followed.nextAt = this.deps.now() + Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, listed * 10))
      if (followed.again) {
        followed.again = false
        this.want(followed, 0)
      }
    }
  }
}

/** A child's call as its parent's: the child's id before the call's, hashed when too long to keep. */
export function callId(child: string, call: string): string {
  const id = `${child}/${call}`
  return id.length <= CALL_ID_MAX ? id : `${id.slice(0, CALL_ID_MAX - 17)}~${createHash("sha256").update(id).digest("hex").slice(0, 16)}`
}
