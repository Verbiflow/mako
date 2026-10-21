import type { LiveBatch, LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import type { LivePermissionRequest } from "@mako/host/contracts/providers-acp"
import type { Entry } from "@mako/sessions/entries"
import { liveToolFinished, reduceLiveUpdates, toolTitle } from "@mako/sessions/live-content"

/**
 * One conversation as a client holds it: its blocks, its requests and its open questions, kept current from the
 * host's batches by the same reducer the host and the window use, and what each batch changed, said as a client
 * prints it: text as it streams, a tool as it starts and ends, a question, a turn's end.
 */
export type ConversationChange =
  | { kind: "text"; block: string; text: string; started: boolean }
  | { kind: "thinking"; block: string; text: string; started: boolean }
  | { kind: "tool"; block: string; title: string; state: "started" | "done" | "failed" }
  | { kind: "user"; block: string; text: string }
  | { kind: "event"; block: string; label: string; detail?: string }
  | { kind: "question"; permission: LivePermissionRequest }
  | { kind: "request"; request: LiveRequest }
  /** The host rewrote history the batches don't carry: read the conversation again (`snapshot`). */
  | { kind: "reread" }

export class ConversationView {
  readonly id: string
  #blocks: Entry[]
  #revision: number
  #epoch: string | undefined
  #requests = new Map<string, LiveRequest>()
  #asked = new Set<string>()

  constructor(id: string, snapshot: LiveSnapshot) {
    this.id = id
    this.#blocks = snapshot.blocks
    this.#revision = snapshot.revision
    this.#epoch = snapshot.epoch
    for (const request of snapshot.requests) this.#requests.set(request.id, request)
    for (const permission of snapshot.permissions) this.#asked.add(permission.id)
  }

  get blocks(): readonly Entry[] {
    return this.#blocks
  }

  get requests(): readonly LiveRequest[] {
    return [...this.#requests.values()]
  }

  /** Every block of the conversation as changes, for a client that prints it from the start. */
  history(): ConversationChange[] {
    return this.#blocks.flatMap((block, index) => changeOf(block, undefined, keyOf(block, index)))
  }

  /** A batch from the host: applied when it's this conversation's and newer, and what it changed. */
  apply(batch: LiveBatch): ConversationChange[] {
    if (batch.id !== this.id) return []
    const sameEpoch = batch.epoch === undefined || this.#epoch === undefined || batch.epoch === this.#epoch
    if (sameEpoch && batch.revision <= this.#revision) return []
    // Another host's numbering, or history the batch doesn't carry: the client reads the conversation again.
    if (!sameEpoch || batch.historyChanged) return [{ kind: "reread" }]
    this.#revision = batch.revision
    const changes: ConversationChange[] = []
    if (batch.updates.length) {
      const before = new Map(this.#blocks.map((block, index) => [keyOf(block, index), block]))
      this.#blocks = reduceLiveUpdates(this.#blocks, batch.updates)
      this.#blocks.forEach((block, index) => {
        const key = keyOf(block, index)
        const previous = before.get(key)
        if (previous !== block) changes.push(...changeOf(block, previous, key))
      })
    }
    for (const permission of batch.permissions ?? [])
      if (!this.#asked.has(permission.id)) {
        this.#asked.add(permission.id)
        changes.push({ kind: "question", permission })
      }
    for (const request of batch.requests ?? batch.requestChanges ?? []) {
      const known = this.#requests.get(request.id)
      this.#requests.set(request.id, request)
      if (known?.status !== request.status) changes.push({ kind: "request", request })
    }
    return changes
  }
}

/** A block's identity across batches: its own id, or where it stands for one the harness gave none. */
function keyOf(block: Entry, index: number): string {
  return block.id ?? `#${index}`
}

/** What a block's arrival or growth is as a change: only the new end of streaming text, a tool's start and end. */
function changeOf(block: Entry, previous: Entry | undefined, key: string): ConversationChange[] {
  switch (block.type) {
    case "text":
    case "thinking": {
      const before = previous?.type === block.type ? previous.text : ""
      const text = block.text.startsWith(before) ? block.text.slice(before.length) : `\n${block.text}`
      return text ? [{ kind: block.type, block: key, text, started: !previous }] : []
    }
    case "tool": {
      // A call's words and when it's over, as every reader of the conversation has them.
      const title = toolTitle(block)
      const finished = liveToolFinished(block.status)
      const state = !finished ? "started" : block.status === "failed" ? "failed" : "done"
      if (!previous) return [{ kind: "tool", block: key, title, state }]
      const was = previous.type === "tool" ? liveToolFinished(previous.status) : false
      return finished && !was ? [{ kind: "tool", block: key, title, state }] : []
    }
    case "user":
      return previous ? [] : [{ kind: "user", block: key, text: block.text }]
    case "event":
      if (previous) return []
      return [block.detail ? { kind: "event", block: key, label: block.label, detail: block.detail } : { kind: "event", block: key, label: block.label }]
    default:
      return []
  }
}
