import { randomUUID } from "node:crypto"
import { isTurnStart, type LiveBlock } from "./contracts/live-content.js"
import type { LiveRequest } from "./contracts/live-conversations.js"
import type { ThreadTitleEntry } from "./contracts/thread-titles.js"
import type { ThreadId } from "./contracts/thread-identity.js"
import { hostWarn } from "./host-log.js"
import { TITLE_ANSWER_CHARS, TITLE_PROMPT_CHARS, type ThreadStore, type TitleContext } from "./thread-store.js"

/** A request a conversation finished answering, as `LiveConversations` reports it once. */
export interface CompletedExchange {
  conversationId: string
  requestId: string
  completedAt: number
  prompt: string
  answer: string
  /** The conversation's own title when it finished, kept as the Thread's original name. */
  nativeTitle?: string
}

/** The model that names Threads, or why there is none; never another one in its place. */
export type TitleModel =
  | { kind: "off" }
  | { kind: "unavailable"; reason: string }
  | { kind: "ready"; id: string; complete(instructions: string, prompt: string, signal: AbortSignal): Promise<string> }

/** A model's refusal; `pause` when repeating the request soon would be refused the same way (a bad key, a rate limit). */
export class TitleModelError extends Error {
  readonly kind: string
  readonly pause: boolean

  constructor(kind: string, message: string, pause: boolean) {
    super(message)
    this.name = "TitleModelError"
    this.kind = kind
    this.pause = pause
  }
}

export interface ThreadTitlerOptions {
  store: ThreadStore
  model(): Promise<TitleModel>
  emit(titles: ThreadTitleEntry[]): void
  /** How long a Thread stays quiet after an exchange before it is named. */
  quietMs?: number
  /** The least time between two requests for one Thread. */
  spacingMs?: number
  /** How long a burst of exchanges may hold a Thread's naming back. */
  maxWaitMs?: number
  /** Requests in flight at once, across Threads. */
  concurrency?: number
  timeoutMs?: number
  /** How long a provider that refused the key or the rate is left alone. */
  pauseMs?: number
  now?: () => number
}

export const TITLE_INSTRUCTIONS = [
  "You name conversations between a person and a coding agent, for a list of conversations.",
  "Reply with the title only: two to six words in sentence case, with no quotes, no markdown and no closing period.",
  "Name what the conversation is about now. When the topic has changed, the latest exchange decides.",
  "If the current title still describes the conversation, reply with the current title unchanged.",
].join(" ")
const TITLE_MAX_CHARS = 80

/**
 * The exchange `request` asked, from the conversation's blocks: its prompt
 * and the answer's prose, without thinking or tool output. Undefined when
 * the blocks hold no prompt for it.
 */
export function completedExchange(blocks: readonly LiveBlock[], request: LiveRequest): Pick<CompletedExchange, "prompt" | "answer"> | undefined {
  let start = -1
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block?.type === "user" && !block.steeringFor && block.requestId === request.id) {
      start = index
      break
    }
  }
  if (start < 0) return undefined
  const prompt = request.continues?.auto ? "" : boundedText(promptText(blocks[start], request), TITLE_PROMPT_CHARS)
  const parts: string[] = []
  let length = 0
  for (let index = start + 1; index < blocks.length && length < TITLE_ANSWER_CHARS; index += 1) {
    const block = blocks[index]
    if (isTurnStart(block)) break
    if (block?.type !== "text" || !block.text.trim()) continue
    parts.push(block.text.trim())
    length += block.text.length
  }
  return { prompt, answer: boundedText(parts.join("\n\n"), TITLE_ANSWER_CHARS) }
}

function promptText(block: LiveBlock | undefined, request: LiveRequest): string {
  return block?.type === "user" && block.text.trim() ? block.text : request.displayText ?? request.text
}

function boundedText(text: string, limit: number): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 1)}…` : trimmed
}

/** The words a model is asked about: the current title and the window, oldest first. */
export function titlePrompt(context: Pick<TitleContext, "current" | "exchanges">): string {
  const exchanges = context.exchanges.map((exchange, index) => [
    index === context.exchanges.length - 1 ? "Latest exchange" : "Earlier exchange",
    `Person: ${exchange.prompt || "(Mako continued an interrupted turn.)"}`,
    `Agent: ${exchange.answer || "(The agent answered with tool calls only.)"}`,
  ].join("\n"))
  return [context.current ? `Current title: ${context.current}` : "The conversation has no title yet.", ...exchanges].join("\n\n")
}

/**
 * A model's reply as a title, or undefined when it isn't one: its first
 * line without a label, quotes, markdown or a closing stop, cut at a word
 * within `TITLE_MAX_CHARS`.
 */
export function parseTitle(reply: string): string | undefined {
  const line = reply.split("\n").map((part) => part.trim()).find(Boolean)
  if (!line) return undefined
  let title = line
    .replace(/^(#+\s*|[-*]\s+)/, "")
    .replace(/^(title|thread title|conversation title)\s*[:-]\s*/i, "")
    .replace(/[*_`]/g, "")
    .replace(/^["'“‘«]+|["'”’»]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.:;,]+$/, "")
    .trim()
  if (title.length > TITLE_MAX_CHARS) {
    const cut = title.slice(0, TITLE_MAX_CHARS + 1)
    const space = cut.lastIndexOf(" ")
    title = (space > TITLE_MAX_CHARS / 2 ? cut.slice(0, space) : cut.slice(0, TITLE_MAX_CHARS)).replace(/[\s.:;,-]+$/, "")
  }
  if (title.length < 2 || !/[\p{L}\p{N}]/u.test(title) || /^untitled( (session|conversation|thread))?$/i.test(title)) return undefined
  return title
}

interface Pending {
  timer?: ReturnType<typeof setTimeout>
  /** When the first exchange of the current burst finished. */
  since?: number
  lastCall?: number
  controller?: AbortController
}

/**
 * Names Threads from their latest exchanges, after the fact and off the
 * turn's path. A finished exchange is kept in the Thread store and its
 * Thread is named once it has been quiet for `quietMs`; a burst of
 * exchanges is one request, a window already answered is none, and a
 * Thread is asked about at most once per `spacingMs`. The store decides
 * whether an answer still applies, so a rename, a newer exchange, another
 * host's title or a merged Thread wins over a late one.
 */
export class ThreadTitler {
  private readonly options: ThreadTitlerOptions
  private readonly pending = new Map<ThreadId, Pending>()
  private readonly waiting: ThreadId[] = []
  private readonly originals = new Map<ThreadId, string>()
  /** Which host asked; a lease another host holds is left alone. */
  private readonly holder = randomUUID()
  private enabled = false
  private running = 0
  private pausedUntil = 0
  private unavailable?: string
  private closed = false

  constructor(options: ThreadTitlerOptions) {
    this.options = options
  }

  /** Whether a model is chosen; with none, exchanges are not kept and nothing is asked. */
  configure(enabled: boolean): void {
    this.enabled = enabled
    this.unavailable = undefined
    this.pausedUntil = 0
  }

  exchange(exchange: CompletedExchange): void {
    if (!this.enabled || this.closed) return
    try {
      const { store } = this.options
      const placed = store.journalPlacement(exchange.conversationId)
      if (!placed) return
      const fresh = store.noteExchange({
        session: placed.session,
        exchange: exchange.requestId,
        completedAt: exchange.completedAt,
        prompt: exchange.prompt,
        answer: exchange.answer,
      })
      if (!fresh) return
      if (exchange.nativeTitle) this.originals.set(placed.thread, exchange.nativeTitle)
      this.schedule(placed.thread)
    } catch (error) {
      hostWarn("thread-titles", "an exchange could not be kept for naming its Thread", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** A person named the Thread: whatever was being asked for it is moot. */
  cancel(thread: ThreadId): void {
    const entry = this.pending.get(thread)
    if (!entry) return
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.since = undefined
    entry.controller?.abort()
  }

  close(): void {
    this.closed = true
    for (const thread of this.pending.keys()) this.cancel(thread)
    this.pending.clear()
    this.waiting.length = 0
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  private schedule(thread: ThreadId): void {
    const entry = this.pending.get(thread) ?? {}
    this.pending.set(thread, entry)
    const now = this.now()
    entry.since ??= now
    if (entry.timer) clearTimeout(entry.timer)
    const quiet = Math.min(now + (this.options.quietMs ?? 4_000), entry.since + (this.options.maxWaitMs ?? 20_000))
    const due = Math.max(quiet, (entry.lastCall ?? -Infinity) + (this.options.spacingMs ?? 30_000))
    entry.timer = setTimeout(() => this.due(thread), Math.max(0, due - now))
    entry.timer.unref?.()
  }

  private due(thread: ThreadId): void {
    const entry = this.pending.get(thread)
    if (!entry || this.closed) return
    entry.timer = undefined
    entry.since = undefined
    // A newer window is due: the answer about the older one could only lose.
    entry.controller?.abort()
    if (this.running >= (this.options.concurrency ?? 2)) {
      if (!this.waiting.includes(thread)) this.waiting.push(thread)
      return
    }
    void this.name(thread, entry)
  }

  private next(): void {
    const thread = this.waiting.shift()
    const entry = thread && this.pending.get(thread)
    if (thread && entry && !this.closed) void this.name(thread, entry)
  }

  private async name(thread: ThreadId, entry: Pending): Promise<void> {
    this.running += 1
    const { store } = this.options
    let claimed: { thread: ThreadId; digest: string } | undefined
    let controller: AbortController | undefined
    try {
      if (this.now() < this.pausedUntil) return
      const model = await this.options.model()
      if (model.kind !== "ready") {
        if (model.kind === "unavailable" && model.reason !== this.unavailable)
          hostWarn("thread-titles", "Threads keep their names: the model chosen for titles is unavailable", { reason: model.reason })
        this.unavailable = model.kind === "unavailable" ? model.reason : undefined
        return
      }
      this.unavailable = undefined
      const context = store.titleContext(thread)
      if (!context || context.manual || !context.exchanges.length || context.answered === context.digest) return
      const revision = store.claimTitle({ thread: context.thread, digest: context.digest, holder: this.holder })
      if (revision === undefined) return
      claimed = { thread: context.thread, digest: context.digest }
      controller = new AbortController()
      entry.controller = controller
      entry.lastCall = this.now()
      const reply = await model.complete(TITLE_INSTRUCTIONS, titlePrompt(context),
        AbortSignal.any([controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 30_000)]))
      const title = parseTitle(reply)
      if (!title) {
        hostWarn("thread-titles", "the model's reply was not a usable title; the Thread keeps its name", { model: model.id, characters: reply.length })
        return
      }
      const outcome = store.applyAutoTitle({ ...claimed, revision, title, holder: this.holder, original: this.originals.get(thread) })
      claimed = undefined
      if (outcome === "applied") {
        const named = store.titleEntry(context.thread)
        if (named) this.options.emit([named])
      }
    } catch (error) {
      if (controller?.signal.aborted) return
      const kind = error instanceof TitleModelError ? error.kind : "request"
      if (error instanceof TitleModelError && error.pause) this.pausedUntil = this.now() + (this.options.pauseMs ?? 10 * 60_000)
      hostWarn("thread-titles", "a Thread could not be named; it keeps its name", { kind, error: error instanceof Error ? error.message : String(error) })
    } finally {
      if (claimed) {
        try {
          store.releaseTitle({ ...claimed, holder: this.holder })
        } catch (error) {
          hostWarn("thread-titles", "a Thread's naming lease could not be released", { error: error instanceof Error ? error.message : String(error) })
        }
      }
      if (entry.controller === controller) entry.controller = undefined
      this.running -= 1
      this.next()
    }
  }
}
