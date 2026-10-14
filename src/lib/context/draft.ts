import type { ProposedPlan } from "@mako/sessions/content"
import type { AttachmentContent } from "@mako/sessions"
import { classify } from "../attachment-kind"
import { attachmentReference } from "../attachment-references"
import type { Attachment } from "../attachments"
import { tokenize } from "../mentions"
import { proposedPlanTitle } from "../proposed-plan"
import { mediaTypeForPath } from "../transcript-media"
import type { PreparedThreadReference } from "../thread-references"
import {
  writeConversation,
  writeDetail,
  writeFile,
  writePlan,
  writeSkill,
  type FileItem,
  type SkillItem,
  type WrittenItem,
} from "./kinds"
import type { SentItem, SentMessage } from "./sent"
import { MARKER, marker, writeMessage, type WireItem } from "./wire"

/**
 * A draft, to the message an agent receives, and back.
 *
 * The draft is words with typed references (`@path`, `/skill`) left as
 * typed, and chips: a conversation token or a record's anchor. Each chip
 * becomes its kind's marker and item (`./kinds`), numbered as the chips
 * stand; a plan and a skill become items for the whole message. Writing is
 * pure: the caller prepares what needs the host first (conversation
 * bundles, skill resolution) and passes it in.
 */

/** The label a record's chip reads in the composer and the transcript. */
export function recordLabel(record: Pick<Attachment, "name" | "contextLabel">): string {
  return record.contextLabel ?? record.name
}

function fileItem(record: Attachment): FileItem {
  const item: FileItem = { name: record.name, mimeType: record.mimeType }
  if (record.size !== undefined) item.size = record.size
  if (record.stagedPath) item.path = record.stagedPath
  else if (record.kind === "text" && record.text !== undefined) item.text = record.text
  if (record.contextPath) item.contextPath = record.contextPath
  if (record.contextLabel) item.label = record.contextLabel
  if (record.origin) item.origin = record.origin
  if (record.window) {
    item.window = { app: record.window.app, title: record.window.title }
    // The elements go in the item while the desk still holds them; a draft
    // reopened from storage points at the staged copy instead.
    if (record.context) item.outline = record.context
  }
  return item
}

/** A record as its kind writes it. */
export function writeRecord(record: Attachment): WrittenItem {
  return record.detail
    ? writeDetail(record.detail, recordLabel(record), record.stagedPath)
    : writeFile(fileItem(record))
}

export interface DraftMessage {
  draft: string
  /** The draft's records, staged. */
  records: readonly Attachment[]
  /** What each conversation token stands for (`prepareThreadReferences`). */
  conversations?: ReadonlyMap<string, PreparedThreadReference>
  plans?: readonly ProposedPlan[]
  skills?: readonly SkillItem[]
  /**
   * Leave conversation tokens as typed instead of writing their items: a
   * copy has no bundle to prepare, and a token pasted back resolves again.
   */
  tokens?: boolean
}

export interface WrittenDraft {
  /** The message text: the words with markers, and the context block. */
  text: string
  /** The records the agent also gets as files, in the order they were written. */
  files: Attachment[]
}

export function writeDraft({ draft, records, conversations = new Map(), plans = [], skills = [], tokens = false }: DraftMessage): WrittenDraft {
  const byId = new Map(records.map((record) => [record.id, record]))
  const items: WireItem[] = []
  const files: Attachment[] = []
  const numbered = new Map<string, string>()
  let body = ""
  const add = (key: string, written: WrittenItem, record?: Attachment): string => {
    const known = numbered.get(key)
    if (known !== undefined) return known
    const n = items.length + 1
    items.push({ n, kind: written.kind, attrs: written.attrs, body: written.body })
    if (record?.stagedPath) files.push(record)
    const placed = written.noun ? marker(written.noun, n, written.label) : ""
    numbered.set(key, placed)
    return placed
  }
  for (const segment of tokenize(draft)) {
    if (segment.kind === "text") body += segment.text
    else if (segment.kind === "thread" && tokens) body += segment.raw
    else if (segment.kind === "thread") {
      const prepared = conversations.get(segment.raw)
      const written = writeConversation(
        {
          ref: prepared?.ref ?? segment.raw.slice(1),
          harness: prepared?.thread?.harness ?? segment.harness,
          title: prepared?.thread?.title ?? "Untitled conversation",
        },
        prepared?.context ?? null
      )
      body += add(`thread:${prepared?.ref ?? segment.raw}`, written)
    } else if (segment.kind === "context") {
      const record = byId.get(segment.id)
      // An anchor whose record is gone is nothing to send.
      if (record) body += add(`record:${record.id}`, writeRecord(record), record)
    } else body += segment.raw
  }
  // A record the words don't place still goes, without a marker.
  for (const record of records)
    if (!numbered.has(`record:${record.id}`)) add(`record:${record.id}`, { ...writeRecord(record), noun: null }, record)
  for (const plan of plans) add(`plan:${plan.id}`, writePlan(plan, proposedPlanTitle(plan.text)))
  for (const skill of skills) add(`skill:${skill.name}`, writeSkill(skill))
  return { text: writeMessage({ body: body.trim(), items }), files }
}

export interface SentDraft {
  text: string
  records: Attachment[]
  plans: ProposedPlan[]
  /** The record each file or detail item became, by item number. */
  byItem: Map<number, Attachment>
}

/**
 * A sent message as a draft again, for Reuse, Edit, copy and a restored
 * send: each marker becomes its chip, a file comes back as a record on its
 * staged path, and media the message carried without a place in its words
 * come back too.
 */
export function sentDraft(sent: SentMessage, media: readonly AttachmentContent[] = []): SentDraft {
  const records: Attachment[] = []
  const plans: ProposedPlan[] = []
  const anchors = new Map<number, string>()
  const byItem = new Map<number, Attachment>()
  const recordFor = (item: SentItem): Attachment | null => {
    if (item.kind === "file") {
      const { file } = item
      const mimeType = file.mimeType || mediaTypeForPath(file.name) || "application/octet-stream"
      const record: Attachment = {
        id: crypto.randomUUID(),
        index: records.length + 1,
        name: file.name,
        mimeType,
        kind: classify({ type: mimeType, name: file.name }),
      }
      if (file.size !== undefined) record.size = file.size
      if (file.path) record.stagedPath = file.path
      else if (file.text !== undefined) record.text = file.text
      if (file.contextPath) record.contextPath = file.contextPath
      if (file.label) record.contextLabel = file.label
      if (file.origin) record.origin = file.origin
      if (file.window) record.window = { ...file.window }
      if (file.outline) record.context = file.outline
      if (!file.path && file.text === undefined) record.error = "This file is unavailable. Attach it again before sending."
      return record
    }
    if (item.kind === "detail") {
      const record: Attachment = {
        id: crypto.randomUUID(),
        index: records.length + 1,
        name: item.label || "Context",
        contextLabel: item.label || "Context",
        mimeType: item.screenshot ? "image/png" : "text/plain",
        kind: item.screenshot ? "image" : "text",
        detail: item.detail,
      }
      if (item.screenshot) record.stagedPath = item.screenshot
      return record
    }
    return null
  }
  for (const item of sent.items) {
    if (item.kind === "plan") plans.push(item.plan)
    const record = recordFor(item)
    if (!record) continue
    records.push(record)
    byItem.set(item.n, record)
    anchors.set(item.n, attachmentReference(record))
  }
  const paths = new Set(records.flatMap((record) => (record.stagedPath ? [record.stagedPath] : [])))
  for (const block of media) {
    if (block.source.kind !== "file" || paths.has(block.source.path)) continue
    paths.add(block.source.path)
    const mimeType = block.mimeType ?? mediaTypeForPath(block.source.path) ?? "application/octet-stream"
    records.push({
      id: crypto.randomUUID(),
      index: records.length + 1,
      name: block.name,
      mimeType,
      kind: classify({ type: mimeType, name: block.name }),
      stagedPath: block.source.path,
    })
  }
  const byNumber = new Map(sent.items.map((item) => [item.n, item]))
  const text = sent.body.replace(MARKER, (found, _noun: string, n: string) => {
    const item = byNumber.get(Number(n))
    if (!item) return found
    if (item.kind === "conversation") return item.conversation.ref ? `@${item.conversation.ref}` : item.conversation.title
    return anchors.get(item.n) ?? found
  })
  // A record placed nowhere in the words still comes back with a chip.
  const placed = new Set(Array.from(sent.body.matchAll(MARKER), (match) => Number(match[2])))
  const unplaced = records.filter((record) => ![...anchors].some(([n, anchor]) => placed.has(n) && anchor === attachmentReference(record)))
  return {
    text: unplaced.length ? `${text}${text && !/\s$/.test(text) ? " " : ""}${unplaced.map(attachmentReference).join(" ")} ` : text,
    records,
    plans,
    byItem,
  }
}
