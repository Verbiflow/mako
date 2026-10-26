import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import type { ContentRef, ExactBounds } from "@mako/protocol"
import { contentRef, STORE_LIMIT } from "../attribution/index.js"
import { topic } from "../base/topic.js"

/*
 * A tool call's exact bounds, where a harness runs Mako's code around the
 * tool itself (a hook), not only where its stream shows the call: when the
 * tool started and returned, and the content of each file it targeted just
 * before and just after. The stream's own times include the model writing
 * the call and the person approving it, so the journal allows a lead and a
 * trail around them; within exact bounds it allows none, and a person's save
 * just outside them is the person's.
 *
 * Harnesses with such a hook publish here; the attribution journal
 * subscribes. With nobody subscribed, a hook reads no file.
 */

export interface LiveCallBounds {
  /** The live conversation's id. */
  conversation: string
  /** The tool call's id, as the conversation's tool updates name it. */
  call: string
  status: "completed" | "failed"
  exact: ExactBounds
}

export const liveCallBounds = topic<LiveCallBounds>("mako:call-bounds")

/** Files a hook hashes for one call, at most. */
const MAX_FILES = 8

/**
 * A file's content address now, read in one piece; null when it isn't
 * there, undefined when it can't be told cheaply (past what the journal
 * keeps whole, or not a file). Synchronous: a hook answers before the tool
 * runs, and a file this size reads in well under a millisecond.
 */
export function fileRef(path: string): ContentRef | null | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT" ? null : undefined
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > STORE_LIMIT) return undefined
    const bytes = Buffer.allocUnsafe(stat.size)
    let read = 0
    while (read < stat.size) {
      const got = readSync(fd, bytes, read, stat.size - read, read)
      if (!got) break
      read += got
    }
    return contentRef(bytes.subarray(0, read))
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/**
 * Bounds for the calls of one conversation, from a hook before each tool
 * runs and one after it returns. `before` takes the targeted files' content
 * then; `after` publishes the call's bounds. A call whose `after` never comes
 * (the turn was stopped) is forgotten once enough newer ones begin.
 */
export class CallBounds {
  private readonly conversation: string
  private readonly now: () => number
  private readonly open = new Map<string, { at: number; files: { path: string; before: ContentRef | null }[] }>()

  constructor(conversation: string, now: () => number = Date.now) {
    this.conversation = conversation
    this.now = now
  }

  /** The tool is about to run: when, and what each targeted file holds. */
  before(call: string, paths: readonly string[]): void {
    if (!liveCallBounds.heard) return
    const files: { path: string; before: ContentRef | null }[] = []
    for (const path of paths.slice(0, MAX_FILES)) {
      const before = fileRef(path)
      if (before !== undefined) files.push({ path, before })
    }
    this.open.set(call, { at: this.now(), files })
    if (this.open.size > 256) this.open.delete(this.open.keys().next().value!)
  }

  /**
   * The tool returned. `ranMs`, when the harness measured it, is how long the
   * tool itself ran, without approval or hooks: the start is that long ago.
   * `detached`: it left work running, so its end bounds nothing.
   */
  after(call: string, status: LiveCallBounds["status"], options: { ranMs?: number; detached?: boolean } = {}): void {
    const opened = this.open.get(call)
    this.open.delete(call)
    if (!liveCallBounds.heard) return
    const end = this.now()
    const measured = options.ranMs !== undefined && Number.isFinite(options.ranMs) && options.ranMs >= 0 ? end - Math.ceil(options.ranMs) : undefined
    const start = Math.min(end, Math.max(opened?.at ?? -Infinity, measured ?? -Infinity))
    if (!Number.isFinite(start)) return
    const exact: ExactBounds = { start, end }
    const files = (opened?.files ?? []).flatMap((file) => {
      const after = fileRef(file.path)
      return after === undefined || after === file.before ? [] : [{ path: file.path, before: file.before, after }]
    })
    if (files.length) exact.files = files
    if (options.detached) exact.detached = true
    liveCallBounds.publish({ conversation: this.conversation, call, status, exact })
  }
}
