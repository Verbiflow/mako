import type { SessionNotification } from "@agentclientprotocol/sdk"
import { z } from "zod"
import { AcpUpdateDecoder, type AcpDecoderHooks, type AcpSessionPatch } from "./acp-decoder.js"
import { AcpContentBlockSchema } from "./acp-tool-details.js"
import type { AttachmentContent } from "./content.js"
import { cleanEntry, EntrySink, type ThreadEntry, type TurnUsage } from "./format.js"
import { reduceLiveUpdates, type LiveBlock, type LiveUpdate } from "./live-content.js"
import { liveEvent, liveToolEntry } from "./live-entries.js"

type AssistantEntry = Extract<ThreadEntry, { kind: "assistant" }>

/**
 * The saved updates the shared decoder reads, screened for every field
 * `decodeAcpUpdate` reads of their kind. The person's chunks are each
 * reader's own, since each store marks a prompt differently; usage and the
 * command list are the host's and stay out.
 */
const SavedUpdateSchema = z.discriminatedUnion("sessionUpdate", [
  z.looseObject({ sessionUpdate: z.literal("agent_message_chunk"), content: AcpContentBlockSchema }),
  z.looseObject({ sessionUpdate: z.literal("agent_thought_chunk"), content: AcpContentBlockSchema }),
  z.looseObject({ sessionUpdate: z.literal("tool_call"), toolCallId: z.string(), title: z.string().nullish(), kind: z.string().nullish(), status: z.string().nullish() }),
  z.looseObject({ sessionUpdate: z.literal("tool_call_update"), toolCallId: z.string(), title: z.string().nullish(), status: z.string().nullish() }),
  z.looseObject({ sessionUpdate: z.literal("plan"), entries: z.array(z.looseObject({ content: z.string(), status: z.string() })) }),
  z.looseObject({ sessionUpdate: z.literal("session_info_update"), title: z.string().nullish() }),
])

export const SavedAcpUpdateSchema = z.looseObject({ sessionUpdate: z.string() })
/** A saved `session/update` as its store keeps it, before the screen; hooks read its `_meta` too. */
export type SavedAcpNotification = z.infer<typeof SavedAcpNotificationSchema>
export const SavedAcpNotificationSchema = z.looseObject({ sessionId: z.string(), update: SavedAcpUpdateSchema })

/** A saved `session/update` the shared decoder reads, or nothing for a kind it leaves to the reader. */
export function acpSavedNotification(saved: SavedAcpNotification): SessionNotification | undefined {
  const update = SavedUpdateSchema.safeParse(saved.update)
  // SAFETY: the screen checked every field `decodeAcpUpdate` reads of this kind, and each harness's hooks parse what they read.
  return update.success ? { ...saved, update: update.data } as SessionNotification : undefined
}

/** The person's message for a turn, joined from the chunks its store split it into. */
export interface SavedPrompt {
  at?: string
  /** The id a message steered into this turn names. */
  id?: string
  steeringFor?: string
  text: string
  attachments: AttachmentContent[]
  /** The harness opened the turn itself, with this label, instead of the person. */
  opener?: string
}

/**
 * A store that kept an ACP agent's wire, read as a locator: each saved
 * update goes through the decoder the live client runs (`AcpUpdateDecoder`
 * with the harness's hooks) and the reducer the window runs
 * (`reduceLiveUpdates`), so a reopened session draws what the live one did.
 * The reader adds only what its store marks another way: the person's
 * prompts, where turns end, and the harness's own markers. A turn becomes
 * entries when it is committed, so memory holds one turn's blocks, and
 * entries already saved change only through `sink`.
 */
export class AcpSavedTurns {
  readonly sink = new EntrySink()
  private readonly decoder: AcpUpdateDecoder
  /** When each block was written: the update that placed it, and for a plan the one that last changed it. */
  private readonly written = new WeakMap<LiveBlock, string | undefined>()
  private readonly tools = new Set<string>()
  private blocks: LiveBlock[] = []
  private pending: LiveUpdate[] = []
  private pendingAt: (string | undefined)[] = []
  private open: SavedPrompt | undefined
  private started = false
  private reset = false
  private unchangedCount = 0

  constructor(hooks: AcpDecoderHooks) {
    this.decoder = new AcpUpdateDecoder(hooks)
  }

  /** The person's message still gathering chunks. */
  get prompt(): SavedPrompt | undefined {
    return this.open
  }

  /** A follower that started mid-file saw a reply or a tool's update whose turn it never read. */
  get needsReset(): boolean {
    return this.reset
  }

  get unchanged(): number {
    return this.unchangedCount
  }

  /** A saved update, decoded into the open turn. Returns what it says about the session. */
  update(notification: SessionNotification, at: string | undefined): AcpSessionPatch[] {
    const { update } = notification
    if (update.sessionUpdate === "tool_call") this.tools.add(update.toolCallId)
    if (update.sessionUpdate === "tool_call_update" ? !this.tools.has(update.toolCallId) : !this.started && update.sessionUpdate !== "plan" && update.sessionUpdate !== "session_info_update")
      this.reset = true
    if (update.sessionUpdate !== "session_info_update") this.started = true
    const patches: AcpSessionPatch[] = []
    for (const item of this.decoder.update(notification)) {
      if (item.kind === "update") this.queue(item.update, at)
      else if (item.kind === "state") patches.push(item.patch)
    }
    return patches
  }

  /** Something the reader knows that the decoder doesn't, such as a marker, placed in the open turn. */
  queue(update: LiveUpdate, at: string | undefined): void {
    this.pending.push(update)
    this.pendingAt.push(at)
  }

  /** Opens the person's message, after the one before it. */
  prompted(prompt: SavedPrompt): void {
    this.close()
    this.started = true
    this.open = prompt
  }

  /** Places the open message; chunks after it start another. */
  close(): void {
    const prompt = this.open
    if (!prompt) return
    this.queue(prompt.opener ? { kind: "provider-turn", reason: prompt.opener } : promptUpdate(prompt), prompt.at)
    this.open = undefined
  }

  /** Ends the open turn: its blocks become saved entries and the next starts empty. Returns the turn's first entry. */
  commit(usage?: TurnUsage): ThreadEntry | undefined {
    this.close()
    this.reduce()
    const entries = turnEntries(this.blocks, this.written, usage)
    for (const entry of entries) this.sink.push(entry)
    this.blocks = []
    return entries[0]
  }

  /** Rewrites the open turn's last block that `match` finds. */
  replaceLast<B extends LiveBlock>(match: (block: LiveBlock) => block is B, replace: (block: B) => B): boolean {
    this.reduce()
    for (let index = this.blocks.length - 1; index >= 0; index--) {
      const block = this.blocks[index]!
      if (!match(block)) continue
      const next = replace(block)
      this.written.set(next, this.written.get(block))
      this.blocks = [...this.blocks.slice(0, index), next, ...this.blocks.slice(index + 1)]
      return true
    }
    return false
  }

  /** Saved entries and the open turn's, as drawn so far. */
  snapshot(): ThreadEntry[] {
    this.reduce()
    const saved = this.sink.snapshot()
    this.unchangedCount = this.sink.unchanged
    // A steered message opens inside the turn, after the blocks it has so far.
    const open = this.open ? [...turnEntries(this.blocks, this.written), promptEntry(this.open)] : turnEntries(this.blocks, this.written)
    for (const entry of open) cleanEntry(entry)
    return open.length ? [...saved, ...open] : saved
  }

  /** Every entry, with the open turn committed. */
  done(): ThreadEntry[] {
    this.commit()
    const entries = this.sink.snapshot()
    this.unchangedCount = this.sink.unchanged
    return entries
  }

  private reduce(): void {
    if (!this.pending.length) return
    const times = this.pendingAt
    this.blocks = reduceLiveUpdates(this.blocks, this.pending, (block, previous, update) => {
      this.written.set(block, previous && block.type !== "plan" ? this.written.get(previous) : times[update])
    })
    this.pending = []
    this.pendingAt = []
  }
}

function promptUpdate(prompt: SavedPrompt): LiveUpdate {
  return {
    kind: "user",
    ...prompt.id && { requestId: prompt.id },
    ...prompt.steeringFor && { steeringFor: prompt.steeringFor },
    text: prompt.text,
    ...prompt.attachments.length && { attachments: prompt.attachments },
  }
}

function promptEntry(prompt: SavedPrompt): ThreadEntry {
  if (prompt.opener) return { kind: "event", at: prompt.at, label: prompt.opener, opensTurn: true }
  return userEntry(prompt.at, prompt.id, prompt.steeringFor, prompt.text, prompt.attachments)
}

function userEntry(at: string | undefined, id: string | undefined, steeringFor: string | undefined, text: string, attachments: readonly AttachmentContent[] | undefined): ThreadEntry {
  return { kind: "user", ...id && { id }, at, ...steeringFor && { steeringFor }, text, ...attachments?.length && { attachments: [...attachments] } }
}

/** A turn's blocks as saved entries: what the person said, what the agent did, and its markers. */
function turnEntries(blocks: readonly LiveBlock[], written: WeakMap<LiveBlock, string | undefined>, usage?: TurnUsage): ThreadEntry[] {
  const entries: ThreadEntry[] = []
  let assistant: AssistantEntry | undefined
  let replied: AssistantEntry | undefined
  const reply = (block: LiveBlock): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at: written.get(block), blocks: [] }
      entries.push(assistant)
      replied = assistant
    }
    return assistant
  }
  for (const block of blocks) {
    const at = written.get(block)
    switch (block.type) {
      case "user":
        assistant = undefined
        entries.push(userEntry(at, block.requestId, block.steeringFor, block.text, block.attachments))
        break
      case "provider-turn":
        assistant = undefined
        entries.push({ kind: "event", at, label: block.reason, opensTurn: true })
        break
      case "event":
        assistant = undefined
        entries.push({ kind: "event", at, ...liveEvent(block) })
        break
      case "plan":
        assistant = undefined
        entries.push({ kind: "assistant", at, blocks: [{ type: "tool", name: "Plan", output: "", details: [{ type: "plan", entries: block.entries }] }] })
        break
      case "text":
      case "thinking":
        reply(block).blocks.push({ type: block.type, text: block.text })
        break
      case "attachment":
        reply(block).blocks.push(block.attachment)
        break
      case "proposed-plan":
        reply(block).blocks.push({ type: block.type, id: block.id, text: block.text, status: block.status, ...block.truncated && { truncated: true } })
        break
      case "tool":
        reply(block).blocks.push(liveToolEntry(block))
        break
    }
  }
  if (usage && replied) replied.usage = usage
  return entries
}
