import { randomUUID } from "node:crypto"
import type { LiveBatch, LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { LiveActionResultSchema, type LiveActionResult } from "@mako/host/contracts/live-actions"
import type { LivePermissionResponse } from "@mako/host/contracts/providers-acp"
import { z } from "zod"
import { type ConversationChange, ConversationView } from "./conversation.js"
import type { HostEvent, HostTransport } from "./transport.js"

/**
 * Everything the desktop does with a conversation, as calls any client makes: start one, send to it, steer its running
 * turn, answer its questions, stop it, read it, and watch it as it goes. The same against a local host and a cloud
 * Thread, since the transport carries the host's own calls and events.
 */

/** A request is settled once it's none of these. */
const UNSETTLED = new Set<LiveRequest["status"]>(["queued", "held", "dispatching"])

const StartedSchema = z.looseObject({ id: z.string().optional() })
/** What the client reads of a snapshot before taking the rest of it as the host's `LiveSnapshot`. */
const SnapshotHeadSchema = z.looseObject({ revision: z.number(), blocks: z.array(z.unknown()), requests: z.array(z.unknown()), permissions: z.array(z.unknown()) })
const LiveSnapshotSchema = z.custom<LiveSnapshot>((value) => SnapshotHeadSchema.safeParse(value).success, "The host's answer isn't a conversation")
const LiveBatchEventSchema = z.looseObject({ type: z.literal("live-batch"), batch: z.looseObject({ id: z.string(), revision: z.number(), updates: z.array(z.unknown()) }) })

/** A conversation started, and the request its first message is, when it had one. */
export type Started = { conversationId: string; requestId?: string }
/** What `mako:live-start` takes as its third argument, as far as a client gives it. */
type LiveStartInit = { conversationId: string; initialRequest?: { id: string; text: string; attachments: [] }; tuning?: { model: string } }

export type StartOptions = {
  harness: string
  /** The folder the agent works in: on a cloud Thread, its machine's. */
  cwd: string
  text?: string
  model?: string
  conversationId?: string
}

export class MakoClient {
  readonly #transport: HostTransport

  constructor(transport: HostTransport) {
    this.#transport = transport
  }

  get where(): string {
    return this.#transport.where
  }

  /** A new conversation with `harness` in `cwd`, its first message `text` if given. */
  async start(options: StartOptions): Promise<Started> {
    const conversationId = options.conversationId ?? randomUUID()
    const init: LiveStartInit = { conversationId }
    const result: Started = { conversationId }
    if (options.text) {
      result.requestId = randomUUID()
      init.initialRequest = { id: result.requestId, text: options.text, attachments: [] }
    }
    if (options.model) init.tuning = { model: options.model }
    const started = StartedSchema.parse((await this.#transport.call("mako:live-start", [options.harness, options.cwd, init])) ?? {})
    if (started.id) result.conversationId = started.id
    return result
  }

  /** A message, queued behind a running turn as the composer queues one. */
  async send(conversationId: string, text: string, model?: string): Promise<{ requestId: string }> {
    const requestId = randomUUID()
    const args: unknown[] = [conversationId, requestId, text, []]
    if (model) args.push({ model })
    await this.#transport.call("mako:live-prompt", args)
    return { requestId }
  }

  /** A message into the running turn, where its harness takes one; refused where it doesn't. */
  async steer(conversationId: string, requestId: string, text: string): Promise<LiveActionResult> {
    return LiveActionResultSchema.parse(await this.#transport.call("mako:live-action", [conversationId, { kind: "steer", id: randomUUID(), requestId, text, attachments: [] }]))
  }

  /** Answers a question or an approval with one of its options (`null` refuses), and words where it takes them. */
  async answer(conversationId: string, permissionId: string, optionId: string | null, feedback?: string): Promise<void> {
    const response: LivePermissionResponse = { kind: "choice", optionId }
    if (feedback) response.feedback = feedback
    await this.#transport.call("mako:live-permission", [conversationId, permissionId, response])
  }

  /** Stops the running turn. */
  async stop(conversationId: string): Promise<void> {
    await this.#transport.call("mako:live-cancel", [conversationId])
  }

  /** The conversation as the host holds it now. */
  async snapshot(conversationId: string): Promise<LiveSnapshot> {
    const snapshot = await this.#transport.call("mako:live-snapshot", [conversationId])
    if (!snapshot) throw new Error(`No conversation ${conversationId} on ${this.#transport.where}`)
    return LiveSnapshotSchema.parse(snapshot)
  }

  /**
   * Watches the conversation: `onChange` hears each change from the moment it's read, until `until` says to stop,
   * then the view is returned. Events are listened to before it's read, so nothing between is missed.
   */
  async watch(conversationId: string, onChange: (change: ConversationChange, view: ConversationView) => void, until: (view: ConversationView) => boolean = () => false): Promise<ConversationView> {
    const pending: LiveBatch[] = []
    let view: ConversationView | undefined
    let done: (() => void) | undefined
    const finished = new Promise<void>((resolve) => (done = resolve))
    const take = async (batch: LiveBatch) => {
      if (!view) return void pending.push(batch)
      for (const change of view.apply(batch)) {
        if (change.kind === "reread") {
          view = new ConversationView(conversationId, await this.snapshot(conversationId))
          continue
        }
        onChange(change, view)
      }
      if (until(view)) done?.()
    }
    // In the order they came, each after the last: a read again of the conversation waits its turn among them.
    let queue = Promise.resolve()
    const stop = this.#transport.events((event: HostEvent) => {
      const batch = LiveBatchEventSchema.safeParse(event)
      if (!batch.success || batch.data.batch.id !== conversationId) return
      // SAFETY: a live-batch event's batch is the host's `LiveBatch`; its routing fields were checked just above.
      const live = batch.data.batch as LiveBatch
      queue = queue.then(() => take(live)).catch(() => undefined)
    })
    try {
      view = new ConversationView(conversationId, await this.snapshot(conversationId))
      const held = pending.splice(0)
      queue = queue.then(async () => {
        for (const batch of held) await take(batch)
      })
      await queue
      if (!until(view)) await finished
      return view
    } finally {
      stop()
    }
  }

  /** Watches until the request settles: its turn done, failed, stopped or uncertain. */
  async turn(conversationId: string, requestId: string, onChange: (change: ConversationChange, view: ConversationView) => void): Promise<LiveRequest | undefined> {
    const view = await this.watch(conversationId, onChange, (current) => {
      const request = current.requests.find((candidate) => candidate.id === requestId)
      return request !== undefined && !UNSETTLED.has(request.status)
    })
    return view.requests.find((request) => request.id === requestId)
  }

  close(): void {
    this.#transport.close()
  }
}
