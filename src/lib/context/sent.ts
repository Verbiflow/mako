import type { ProposedPlan } from "@mako/sessions/content"
import type { ContextDetail } from "../context-detail"
import { parseAttachmentAppendix } from "../attachments"
import { parsePlanContext } from "../proposed-plan"
import { parseSkillAppendix } from "../skill-references"
import { parseThreadReferenceAppendix } from "../thread-references"
import {
  DETAIL_KINDS,
  fileNoun,
  readConversation,
  readDetail,
  readFile,
  readPlan,
  readSkill,
  type ConversationItem,
  type FileItem,
} from "./kinds"
import { marker, readMessage } from "./wire"

/**
 * A sent message, read back: its words with a marker where each chip stood,
 * and what each numbered item was. The transcript draws it, Reuse and copy
 * turn it back into a draft, and a queued or failed message is restored
 * from it, all from this one reading.
 */

export type SentItem =
  | { n: number; kind: "conversation"; conversation: ConversationItem }
  | { n: number; kind: "file"; file: FileItem }
  | { n: number; kind: "detail"; detail: ContextDetail; label: string; screenshot?: string }
  | { n: number; kind: "skill"; skill: { name: string; from?: string } }
  | { n: number; kind: "plan"; plan: ProposedPlan }

export interface SentMessage {
  /** The words, with `[Kind n: label]` markers where chips stood. */
  body: string
  items: SentItem[]
}

/** The marker a sent item stands at in the words, for the ones that have a place there. */
export function itemMarker(item: SentItem): string | null {
  if (item.kind === "conversation") return marker("Conversation", item.n, item.conversation.title)
  if (item.kind === "file") return marker(fileNoun(item.file), item.n, item.file.label ?? item.file.name)
  if (item.kind === "detail") {
    const noun = { comment: "Comment", element: "Element", quote: "Quote", "pull-request": "Pull request" }[item.detail.kind]
    return marker(noun, item.n, item.label)
  }
  return null
}

export function readSent(text: string): SentMessage {
  const message = readMessage(text)
  if (message.items.length === 0) return legacy(message.body)
  const items: SentItem[] = []
  for (const item of message.items) {
    if (item.kind === "conversation") items.push({ n: item.n, kind: "conversation", conversation: readConversation(item) })
    else if (item.kind === "file") items.push({ n: item.n, kind: "file", file: readFile(item) })
    else if (item.kind === "skill") items.push({ n: item.n, kind: "skill", skill: readSkill(item) })
    else if (item.kind === "plan") {
      const plan = readPlan(item)
      if (plan) items.push({ n: item.n, kind: "plan", plan })
    } else if (DETAIL_KINDS.has(item.kind)) {
      const detail = readDetail(item)
      if (!detail) continue
      const read: SentItem = { n: item.n, kind: "detail", detail, label: markerLabel(message.body, item.n) ?? "" }
      if (item.attrs.screenshot) read.screenshot = item.attrs.screenshot
      items.push(read)
    }
    // A kind a later Mako wrote is left out rather than guessed at.
  }
  return { body: message.body, items }
}

function markerLabel(body: string, n: number): string | undefined {
  const found = new RegExp(String.raw`\[[A-Z][A-Za-z ]* ${n}: ([^\]\n]*)\]`).exec(body)
  return found?.[1]
}

/**
 * A prompt from before October 12 carried one appendix per kind: skills,
 * then referenced conversations, a plan block and files, each with its own
 * placeholder. They read into the same shape, numbered in the order their
 * placeholders stand, so the transcript has one way to draw a prompt.
 */
function legacy(text: string): SentMessage {
  const skills = parseSkillAppendix(text)
  const threads = parseThreadReferenceAppendix(skills.body)
  const plans = parsePlanContext(threads.body)
  const files = parseAttachmentAppendix(plans.body)
  const items: SentItem[] = []
  let n = 0
  const placed = new Map<string, number>()
  const fileByIndex = new Map(files.files.map((file) => [file.index, file]))
  const fileByName = new Map<string, (typeof files.files)[number]>(
    files.files.flatMap((file) => [[`[${file.name}]`, file], [`[${file.name} (${file.index})]`, file]])
  )
  const conversationByNumber = new Map(threads.references.map((entry) => [entry.number, entry]))

  const fileItem = (file: (typeof files.files)[number]): FileItem => {
    const item: FileItem = { name: file.name, mimeType: file.mimeType ?? "application/octet-stream", path: file.path }
    if (file.contextPath) item.contextPath = file.contextPath
    return item
  }
  const conversationItem = (entry: (typeof threads.references)[number]): ConversationItem => {
    const item: ConversationItem = { title: entry.title }
    if (entry.token) item.ref = `thread:${encodeURIComponent(entry.token.harness)}:${encodeURIComponent(entry.token.id)}`
    const harness = entry.token?.harness ?? entry.harness
    if (harness) item.harness = harness
    return item
  }
  const place = (key: string, make: (n: number) => SentItem): string => {
    const known = placed.get(key)
    if (known !== undefined) return itemMarker(items.find((item) => item.n === known)!) ?? ""
    const item = make(++n)
    placed.set(key, item.n)
    items.push(item)
    return itemMarker(item) ?? ""
  }

  const names = [...fileByName.keys()].map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  const placeholder = new RegExp(
    [String.raw`\[Attachment (\d+)\]`, String.raw`\[Referenced conversation (\d+)\]`, ...names].join("|"),
    "g"
  )
  const body = files.body.replace(placeholder, (found, file?: string, conversation?: string) => {
    if (file !== undefined) {
      const entry = fileByIndex.get(Number(file))
      return entry ? place(`file:${entry.index}`, (at) => ({ n: at, kind: "file", file: fileItem(entry) })) : found
    }
    if (conversation !== undefined) {
      const entry = conversationByNumber.get(Number(conversation))
      return entry
        ? place(`conversation:${entry.number}`, (at) => ({ n: at, kind: "conversation", conversation: conversationItem(entry) }))
        : found
    }
    const entry = fileByName.get(found)
    return entry ? place(`file:${entry.index}`, (at) => ({ n: at, kind: "file", file: fileItem(entry) })) : found
  })
  // What was attached without a place in the words still belongs to the message.
  for (const file of files.files)
    if (!placed.has(`file:${file.index}`)) place(`file:${file.index}`, (at) => ({ n: at, kind: "file", file: fileItem(file) }))
  for (const entry of threads.references)
    if (!placed.has(`conversation:${entry.number}`))
      place(`conversation:${entry.number}`, (at) => ({ n: at, kind: "conversation", conversation: conversationItem(entry) }))
  for (const plan of plans.plans) items.push({ n: ++n, kind: "plan", plan })
  for (const skill of skills.skills) items.push({ n: ++n, kind: "skill", skill: skill.from ? { name: skill.name, from: skill.from } : { name: skill.name } })
  return { body, items }
}
