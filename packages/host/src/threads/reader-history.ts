import type { SessionReaderEvent, SessionReaderHistory, SessionReaderKind } from "../contracts/session-reader.js"
import { hostLog, hostWarn } from "../base/host-log.js"

/** Events kept in memory: enough to see a restart loop, bounded however long it runs. */
export const READER_EVENTS_KEPT = 50

/**
 * Each time the reader serving this host's session list is adopted, lost,
 * exits or can't be joined, with the reason the host knows and when: a
 * reader that restarted every 20 to 60 s once left no trace anywhere. Each
 * event is also a `host.log` line. `lost` counts every loss; the events are
 * the newest `READER_EVENTS_KEPT`.
 */
export class ReaderHistory {
  private readonly now: () => Date
  private readonly since: Date
  private readonly events: SessionReaderEvent[] = []
  private lost = 0

  constructor(now: () => Date = () => new Date()) {
    this.now = now
    this.since = now()
  }

  note(event: SessionReaderEvent["event"], kind: SessionReaderKind, details: { reason?: string | undefined; pid?: number | undefined } = {}): void {
    const entry: SessionReaderEvent = {
      at: this.now().toISOString(),
      event,
      kind,
      ...details.reason !== undefined && { reason: details.reason },
      ...details.pid !== undefined && { pid: details.pid },
    }
    if (event === "lost") this.lost += 1
    this.events.unshift(entry)
    this.events.length = Math.min(this.events.length, READER_EVENTS_KEPT)
    const fields = { kind, reason: details.reason, pid: details.pid }
    if (event === "adopted") hostLog("threads", "session reader adopted", fields)
    else hostWarn("threads", `session reader ${event}`, { ...fields, lost: this.lost })
  }

  snapshot(logPath: string): SessionReaderHistory {
    return { since: this.since.toISOString(), lost: this.lost, events: [...this.events], logPath }
  }
}
