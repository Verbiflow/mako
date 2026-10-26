import type { OpenCodeEvent } from "@opencode/client"
import { liveCallBounds } from "../call-bounds.js"

/** Calls whose start is remembered, at most; far more than run at once. */
const OPEN_CALLS = 256

/**
 * OpenCode stamps every event with its own clock on this machine: a tool's
 * `session.tool.called` (its input complete, the tool about to run) and its
 * `session.tool.success` or `failed` bound the call more closely than when
 * the host heard them, and without the time the model spent writing it. They
 * still take in an approval the tool waited for, and no hook reads the file
 * before the tool runs, so they carry no file record (`LiveCallBounds`).
 */
export class OpenCodeCallBounds {
  private readonly conversation: string
  private readonly started = new Map<string, number>()

  constructor(conversation: string) {
    this.conversation = conversation
  }

  observe(event: OpenCodeEvent): void {
    if (!liveCallBounds.heard) return
    if (event.type === "session.tool.called") {
      this.started.set(`${event.data.sessionID}:${event.data.id}`, event.created)
      if (this.started.size > OPEN_CALLS) this.started.delete(this.started.keys().next().value!)
      return
    }
    if (event.type !== "session.tool.success" && event.type !== "session.tool.failed") return
    const call = `${event.data.sessionID}:${event.data.id}`
    const start = this.started.get(call)
    this.started.delete(call)
    if (start === undefined || event.created < start) return
    liveCallBounds.publish({ conversation: this.conversation, call, status: event.type === "session.tool.success" ? "completed" : "failed", exact: { start, end: event.created } })
  }
}
