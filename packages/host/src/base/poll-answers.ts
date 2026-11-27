/**
 * Which of an agent's reads of Mako's own tools repeat an answer it already has: the same call (`agents_list`,
 * `agents_read` of one Fin and view, `agents_wait`, `pull_request_status` of one pull request) by the same
 * conversation, in the same turn, within `POLL_WINDOW_MS`, whose answer reads the same facts. A Fin's report and a
 * pull request's checks wake the agent, so reading again changes nothing but the turn's length: the first repeat still
 * gets the whole answer, with a `next` that says so, and each later one only that it's unchanged
 * (`contracts/poll-words.ts`).
 *
 * One per host, made where the host is composed (or per tool set), never at module scope. Bounded as `CallNotes` is:
 * past `limit` conversations the one heard from least recently is forgotten. No timer: what's past its window is
 * read as new.
 */
export const POLL_WINDOW_MS = 10 * 60_000

/** How a read stands against the caller's last read of the same call. */
export interface PollReading {
  /** The same answer this many times in a row before this one: 0 for a first read, a changed one or a new turn. */
  repeats: number
  /** Seconds since the last same answer, when it repeats one. */
  since?: number
}

interface Heard {
  facts: string
  turn: string | undefined
  at: number
  repeats: number
}

export class PollAnswers {
  private readonly heard = new Map<string, Map<string, Heard>>()
  private readonly limit: number
  private readonly windowMs: number

  constructor(limit = 1_024, windowMs = POLL_WINDOW_MS) {
    this.limit = limit
    this.windowMs = windowMs
  }

  /**
   * Notes that `conversation` made `call` (the tool and what it named) in `turn` and was answered `facts`, and says
   * how often in a row that answer was the same. A caller with no conversation (a terminal's `mako agents list`) is
   * never counted.
   */
  read(conversation: string | undefined, call: string, facts: string, turn: string | undefined, now: number): PollReading {
    if (!conversation) return { repeats: 0 }
    let calls = this.heard.get(conversation)
    if (calls) this.heard.delete(conversation)
    else calls = new Map()
    this.heard.set(conversation, calls)
    if (this.heard.size > this.limit) this.heard.delete(this.heard.keys().next().value!)
    const last = calls.get(call)
    const same = last !== undefined && last.facts === facts && last.turn === turn && now - last.at <= this.windowMs
    calls.delete(call)
    calls.set(call, { facts, turn, at: now, repeats: same ? last.repeats + 1 : 0 })
    // A conversation's own calls stay few: the calls it made least recently go first.
    if (calls.size > 32) calls.delete(calls.keys().next().value!)
    return same ? { repeats: last.repeats + 1, since: Math.max(0, Math.round((now - last.at) / 1000)) } : { repeats: 0 }
  }
}

/** The request a conversation's turn runs now (the one dispatched to its harness), or undefined between turns. */
export function turnOf(requests: readonly { id: string; status: string }[] | undefined): string | undefined {
  for (let at = (requests?.length ?? 0) - 1; at >= 0; at -= 1) if (requests![at]!.status === "dispatching") return requests![at]!.id
  return undefined
}
