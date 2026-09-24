import type { SessionSettings } from "./settings.js"
import { extractAttachmentEnvelope } from "./attachment-envelope.js"
import type { z } from "zod"
import type { EntryBlockSchema, ThreadEntrySchema } from "./thread-schema.js"
export type { AttachmentContent } from "./content.js"

/**
 * The canonical shape of a coding-agent conversation.
 *
 * Every provider keeps its own session store in its own format. This module
 * is the one shape they all
 * translate into, and it is deliberately smaller than any of them: it keeps
 * exactly what is needed to *show* a conversation anywhere and to *continue*
 * it anywhere, and it always keeps a pointer back to the native file, which
 * remains the source of truth for anything provider-specific.
 *
 * Lossy on purpose. A canonical format that tries to round-trip every
 * provider's private fields becomes a union of all of them — which is not a
 * format, it is a pile. Fidelity lives in the native store; portability lives
 * here.
 */

/** Which harness a session came from. Open — new harnesses appear monthly. */
export type Harness =
  "codex" | "claude" | "cursor" | "grok" | "devin" | (string & {})

/** Token counts and spend for one assistant turn, when the harness records them. */
export interface TurnUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  costUsd?: number
}

/**
 * One piece of an assistant turn.
 *
 * A tool call and its result are one block, not two entries: for portability
 * and display, "what was run and what came back" is a single fact. Harnesses
 * that stream them separately are merged during translation.
 */
export type EntryBlock = z.infer<typeof EntryBlockSchema>

/**
 * One entry of a conversation.
 *
 * Three kinds cover every harness surveyed: what the user said, what the
 * agent did, and the occasional out-of-band fact worth showing (a model
 * change, a compaction, a mode switch). Anything a harness records that fits
 * none of these is provider bookkeeping and stays in the native file.
 */
export type ThreadEntry = z.infer<typeof ThreadEntrySchema>

/**
 * Where a conversation has been before it got here.
 *
 * A session continued across harnesses keeps its identity: a thread that
 * began on Devin and moved to Claude Code is one conversation wearing two
 * marks, not two unrelated sessions. The chain lists earlier lives oldest
 * first; the ref's own harness is the current one and is not repeated here.
 */
export interface ThreadOrigin {
  harness: Harness
  title?: string
}

/**
 * The cheap identity of a session: everything a list needs, nothing a
 * transcript needs. Built from at most the head and tail of a native file, so
 * cataloguing a thousand sessions stays a moment, not a minute.
 */
export interface ThreadRef {
  harness: Harness
  /** The harness's own id for the session — what its resume flag wants. */
  nativeId: string
  /** The native file (or directory) holding the full session. */
  path: string
  cwd?: string
  workspace?: string
  title?: string
  model?: string
  /** Latest settings observed in the native store. Missing fields remain unknown. */
  settings?: SessionSettings
  startedAt?: string
  updatedAt?: string
  /** Bytes of the native store — a cheap staleness check and a size hint. */
  bytes?: number
  /** Provider-owned change token; includes sidecars for database stores. */
  revision?: string
  /** The provider reports that another live client holds this native session. */
  locked?: boolean
  active?: boolean
  /** Earlier harnesses this conversation lived on, oldest first. */
  lineage?: ThreadOrigin[]
  /** The provider behind the model, when the harness records one. */
  modelProvider?: string
  /**
   * True when this ref is served from Mako's own archive because the native
   * store no longer has it. Read-only history: still readable, still
   * movable to any harness — no longer resumable by its original CLI.
   */
  archived?: boolean
  /** Native history is readable, but its owning control transport cannot resume it. */
  resumeUnavailable?: string
  /**
   * Dedupe key when one native id names more than one distinct store. Cursor
   * writes a `cursor-agent -p --resume` continuation of an ACP session as a
   * second store under `chats/` with the same agent id; the two hold
   * different turns, so collapsing them by native id hid the original.
   * Defaults to `nativeId`.
   */
  identity?: string
  /**
   * False when the provider's live transport cannot load this store and only
   * a native run can continue it: Cursor's `session/load` answers "Session
   * not found" for a `chats/` store. Unset means the transport decides.
   */
  liveResume?: boolean
  /** The session ran in a temporary directory that no longer exists. */
  workspaceMissing?: boolean
  /**
   * The access mode this session last ran under in Mako, as the host that
   * ran it recorded. No provider store records Mako's tier; the host overlays
   * it from its per-user session memory so a reply starts where the last
   * turn left off.
   */
  accessMode?: string
  /**
   * Another Mako host on this machine holds the session live right now,
   * named the way a refusal names it ("the installed Mako app"). Set by the
   * host from its per-user session memory; a reply here is refused while it
   * is set.
   */
  heldBy?: string
}

/** The key two refs share when they present the same conversation. */
export function threadIdentity(ref: Pick<ThreadRef, "harness" | "nativeId" | "identity">): string {
  return `${ref.harness}:${ref.identity ?? ref.nativeId}`
}

/** A full conversation: the identity plus every entry, in order. */
export interface Thread {
  /** Complete provider record boundary captured with this snapshot. */
  checkpoint?: number
  ref: ThreadRef
  entries: ThreadEntry[]
}

export interface ThreadPage {
  checkpoint?: number
  ref: ThreadRef
  entries: ThreadEntry[]
  start: number
  total: number
  hasEarlier: boolean
  /**
   * Read from the record's tail alone and cut at its first prompt, so a
   * cold whale paints before the whole record is translated. `start` and
   * block addresses are local to this page; the full page replaces it.
   */
  preview?: boolean
}

export interface ThreadPageOptions {
  /**
   * Answer from the last `PREVIEW_BYTES` of a large append-only record when
   * the complete thread is not already translated; null otherwise.
   */
  preview?: boolean
  /**
   * Keep at most this many characters of each tool block's output, noting
   * the full length in `outputLength`. A viewer shows tool rows collapsed,
   * so a page is what the row needs; the rest comes through `block` when a
   * row opens. Omit it to page complete entries.
   */
  toolOutputChars?: number
  /**
   * Stop adding earlier entries once the page holds this many characters
   * of content, counted after trimming; the newest entry is always
   * included. An entry limit alone lets a hundred tool-heavy turns weigh
   * megabytes, and the viewer pages earlier history on scroll anyway.
   */
  maxChars?: number
}

type Attachments = Extract<ThreadEntry, { kind: "user" }>["attachments"]

/** Inline images are most of a screenshot-heavy page; a flat 256 once let one weigh 10 MB. */
function attachmentChars(attachments: Attachments): number {
  let chars = 0
  for (const attachment of attachments ?? [])
    chars += 256 + (attachment.source.kind === "inline" ? attachment.source.data.length : 0)
  return chars
}

/** Characters of content one entry carries, without serializing it. */
export function entryChars(entry: ThreadEntry): number {
  if (entry.kind === "user")
    return entry.text.length + attachmentChars(entry.attachments)
  if (entry.kind === "event")
    return entry.label.length + (entry.detail?.length ?? 0)
  let chars = 0
  for (const block of entry.blocks) {
    if (block.type === "text" || block.type === "thinking")
      chars += block.text.length
    else if (block.type === "tool")
      chars +=
        block.name.length +
        (block.input?.length ?? 0) +
        (block.output?.length ?? 0) +
        (block.details?.length ?? 0) * 256 +
        attachmentChars(block.attachments) +
        64
    else chars += 256
  }
  return chars
}

/** Where one block of one entry lives in a thread. */
export interface BlockAddress {
  entry: number
  block: number
}

/**
 * The entries with each tool output beyond `chars` cut to its head, and
 * inline images a collapsed row cannot show left for `block` to read when
 * it opens. Entries that lose nothing keep their identity, so a page of
 * short outputs costs no copies.
 */
export function trimToolOutput(
  entries: ThreadEntry[],
  chars: number
): ThreadEntry[] {
  let changed = false
  const trimmed = entries.map((entry) => {
    if (entry.kind !== "assistant") return entry
    let touched = false
    const blocks = entry.blocks.map((block) => {
      if (block.type !== "tool") return block
      const longOutput = block.output !== undefined && block.output.length > chars
      const inline = block.attachments?.some(
        (attachment) => attachment.source.kind === "inline" && attachment.source.data.length > chars
      )
      if (!longOutput && !inline) return block
      touched = true
      const next = { ...block }
      if (longOutput && block.output !== undefined) {
        next.output = block.output.slice(0, chars)
        next.outputLength = block.output.length
      }
      if (inline && block.attachments) {
        next.attachments = block.attachments.filter(
          (attachment) => attachment.source.kind !== "inline" || attachment.source.data.length <= chars
        )
        next.attachmentsOmitted = block.attachments.length - next.attachments.length
      }
      return next
    })
    if (!touched) return entry
    changed = true
    return { ...entry, blocks }
  })
  return changed ? trimmed : entries
}

export function userTextFrom(text: string | undefined): string | undefined {
  if (!text) return undefined
  // Strip only complete leading metadata envelopes, preserving the request after them.
  let body = text.trim()
  const envelope =
    /^<(mako-local-control|skill|rules|available_skills|recommended_plugins|environment_context|user_instructions|system_info|system_instruction|app-context|multi_agent_mode|additional_metadata|task-notification|command-name|command-message|local-command|system-reminder)(?:\s[^>]*)?>[\s\S]*?<\/\1>\s*/i
  while (envelope.test(body)) body = body.replace(envelope, "").trimStart()
  const lines = body.split("\n")
  const firstAt = lines.findIndex((line) => line.trim())
  const first = lines[firstAt]?.trim()
  if (!first) return undefined
  if (/^<user_query>$/i.test(first)) {
    const content = lines
      .slice(firstAt + 1)
      .filter((line) => !/^<\/user_query>$/i.test(line.trim()))
      .join("\n")
      .trim()
    return content || undefined
  }
  if (
    /^<(?:skill|rules|available_skills|recommended_plugins|environment_context|user_instructions|system_info|system_instruction|app-context|multi_agent_mode|additional_metadata|task-notification|command-name|command-message|local-command|system-reminder)(?:\s|>)/i.test(
      first
    ) ||
    /^(?:before doing anything else,\s*)?read\s+\S*(?:\.mako\/transcripts|\/tmp\/[^\s]*transcript)/i.test(
      first
    )
  )
    return undefined

  const requestAt = lines.findIndex((line) =>
    /^#{1,6}\s*(?:my\s+request|request)\s*:?\s*$/i.test(line.trim())
  )
  if (requestAt >= 0) {
    const request = lines
      .slice(requestAt + 1)
      .join("\n")
      .trim()
    return request || undefined
  }
  if (/^#{1,6}\s*files?\s+mentioned\s+by\s+the\s+user\s*:?$/i.test(first))
    return undefined
  if (/^\[(?:image|attachment|file)(?:\s+#?\d+)?\]$/i.test(first)) {
    const request = lines
      .slice(firstAt + 1)
      .join("\n")
      .trim()
    return request || undefined
  }
  return body.trim()
}

/** First genuine request line — never an injected envelope or attachment label. */
export function titleFrom(text: string | undefined): string | undefined {
  const genuine = userTextFrom(text)
  if (!genuine) return undefined
  const candidates = genuine.split("\n")
  for (const raw of candidates) {
    let line = raw.trim()
    if (!line || /^```|^---$|^<\/?[a-z][\w-]*(?:\s[^>]*)?>$/i.test(line))
      continue
    const link = /^\[([^\]]+)]\((https?:\/\/[^)]+)\)\s*$/i.exec(line)
    if (link) {
      if (/^https?:\/\//i.test(link[1] ?? "")) continue
      line = link[1]?.trim() ?? ""
    }
    if (
      !line ||
      /^https?:\/\/\S+$/i.test(line) ||
      /^!\[[^\]]*]\([^)]+\)$/.test(line)
    )
      continue
    line = line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^>\s+/, "")
      .trim()
    if (!line) continue
    return line.length > 120 ? `${line.slice(0, 119)}…` : line
  }
  return undefined
}

/** Clip tool payloads: catalogues and handoffs need shape, not megabytes. */
export function clip(
  text: string | undefined,
  max = 256_000
): string | undefined {
  if (text === undefined) return undefined
  return text.length > max
    ? `${text.slice(0, max)}\n… [${text.length - max} more characters]`
    : text
}

/**
 * Collects translated entries with a ceiling.
 *
 * Session files reach gigabytes; transcripts do not need to. The sink keeps
 * the most recent entries and replaces everything older with one event
 * saying how much was set aside — recency is what continuation and display
 * actually use, and the native file still holds every byte.
 */
export class EntrySink {
  private max: number
  private maxCharacters: number
  private droppedEntries = 0
  private droppedUsers = 0
  entries: ThreadEntry[] = []

  constructor(max = 6000, maxCharacters = 32 * 1024 * 1024) {
    this.max = max
    this.maxCharacters = maxCharacters
  }

  push(entry: ThreadEntry): void {
    this.entries.push(entry)
    if (this.entries.length > this.max) this.drop(Math.ceil(this.max / 4))
  }

  snapshot(): ThreadEntry[] {
    for (const entry of this.entries) {
      if (entry.kind === "user") {
        const portable = extractAttachmentEnvelope(entry.text)
        if (portable.attachments.length) {
          entry.text = portable.text
          entry.attachments = [
            ...(entry.attachments ?? []),
            ...portable.attachments,
          ]
        }
      } else if (entry.kind === "assistant") {
        if (
          entry.blocks.some(
            (block) =>
              block.type === "text" && block.text.includes("<mako-attachments>")
          )
        )
          entry.blocks = entry.blocks.flatMap((block): EntryBlock[] => {
            if (block.type !== "text") return [block]
            const portable = extractAttachmentEnvelope(block.text)
            return portable.attachments.length
              ? [{ type: "text", text: portable.text }, ...portable.attachments]
              : [block]
          })
      }
    }
    let characters = this.entries.reduce(
      (sum, entry) => sum + entryCharacters(entry),
      0
    )
    while (this.entries.length > 1 && characters > this.maxCharacters) {
      const count = Math.max(1, Math.ceil(this.entries.length / 8))
      const removed = this.entries.slice(0, count)
      characters -= removed.reduce(
        (sum, entry) => sum + entryCharacters(entry),
        0
      )
      this.drop(count)
    }
    return this.droppedEntries > 0
      ? [
          {
            kind: "event",
            label: "Earlier history not shown",
            detail: `${this.droppedEntries} earlier entries (${this.droppedUsers} user turns) remain in the native session file`,
          },
          ...this.entries,
        ]
      : this.entries
  }

  done(): ThreadEntry[] {
    return this.snapshot()
  }

  private drop(count: number): void {
    const cut = this.entries.splice(0, count)
    this.droppedEntries += cut.length
    this.droppedUsers += cut.filter((entry) => entry.kind === "user").length
  }
}

function entryCharacters(entry: ThreadEntry): number {
  if (entry.kind === "user")
    return entry.text.length + JSON.stringify(entry.attachments ?? []).length
  if (entry.kind === "event")
    return entry.label.length + (entry.detail?.length ?? 0)
  return entry.blocks.reduce((sum, block) => {
    if (
      block.type === "text" ||
      block.type === "thinking" ||
      block.type === "proposed-plan"
    )
      return sum + block.text.length
    if (block.type === "attachment") return sum + JSON.stringify(block).length
    return (
      sum +
      JSON.stringify(block.attachments ?? []).length +
      JSON.stringify(block.details ?? []).length +
      block.name.length +
      (block.input?.length ?? 0) +
      (block.output?.length ?? 0)
    )
  }, 0)
}
