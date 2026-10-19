/**
 * Entries grouped into the messages they came as, for readers that draw a
 * reply whole (the Markdown transcript, a seed taken before 2026-10-15).
 * Pure, with no Node built-ins, so the window can import it.
 */
import { isReplyEntry, proposedPlan, type Entry, type EntryOf, type ReplyEntry } from "./entries.js"
import type { DecodedBlock, DecodedEntry } from "./format.js"
import { AGENT_PLAN_TOOL } from "./tool-identity.js"

/**
 * Entries as messages again, for a reader that draws a reply whole: a run
 * of reply entries is one message, split where an entry names a model (a
 * message's first does) or follows one that carried usage (its last does).
 * A plan is the Plan call it was; a record the decoder couldn't read is a
 * marker quoting it. Times are ISO strings again.
 */
export function messagesFromEntries(entries: readonly Entry[]): DecodedEntry[] {
  const messages: DecodedEntry[] = []
  let reply: Extract<DecodedEntry, { kind: "assistant" }> | undefined
  let ended = false
  for (const entry of entries) {
    const at = entry.at === undefined ? undefined : new Date(entry.at).toISOString()
    if (!isReplyEntry(entry) && entry.type !== "plan") {
      reply = undefined
      messages.push(messageOf(entry, at))
      continue
    }
    if (!reply || ended || (entry.type !== "plan" && entry.model !== undefined && reply.blocks.length)) {
      reply = { kind: "assistant", ...entry.id !== undefined && { id: entry.id }, at, blocks: [] }
      messages.push(reply)
    }
    ended = false
    if (entry.type === "plan") {
      reply.blocks.push({ type: "tool", name: AGENT_PLAN_TOOL, output: "", details: [{ type: "plan", entries: entry.entries }] })
      continue
    }
    if (entry.model !== undefined) reply.model ??= entry.model
    if (entry.usage) {
      reply.usage = entry.usage
      ended = true
    }
    reply.blocks.push(decodedBlock(entry))
  }
  return messages
}

function messageOf(entry: Exclude<Entry, ReplyEntry | EntryOf<"plan">>, at: string | undefined): DecodedEntry {
  switch (entry.type) {
    case "user":
      return { kind: "user", ...entry.id !== undefined && { id: entry.id }, at, ...entry.steeringFor && { steeringFor: entry.steeringFor }, text: entry.text, ...entry.attachments?.length && { attachments: entry.attachments } }
    case "provider-turn":
      return { kind: "event", ...entry.id !== undefined && { id: entry.id }, at, label: entry.reason, ...entry.source && { source: entry.source }, ...entry.cause && { cause: entry.cause }, ...entry.body !== undefined && { body: entry.body }, ...entry.detail !== undefined && { detail: entry.detail }, ...entry.tone && { tone: entry.tone }, opensTurn: true }
    case "event": {
      const { type: _type, at: _at, record: _record, ...marker } = entry
      return { kind: "event", ...marker, at }
    }
    case "unread": {
      const raw = entry.raw === undefined ? undefined : JSON.stringify(entry.raw, null, 2)
      return {
        kind: "event",
        ...entry.id !== undefined && { id: entry.id },
        at,
        label: `Unread record: ${entry.kind}`,
        detail: entry.reason === "unknown" ? "A record of a kind this build doesn't know" : entry.reason === "unreadable" ? "A record this build couldn't read" : "A record this build reads but doesn't draw",
        ...raw !== undefined && { body: raw },
        tone: "warning",
      }
    }
  }
}

function decodedBlock(entry: ReplyEntry): DecodedBlock {
  switch (entry.type) {
    case "text":
    case "thinking":
      return { type: entry.type, text: entry.text, ...entry.id !== undefined && { id: entry.id } }
    case "attachment":
      return entry.attachment
    case "proposed-plan":
      return proposedPlan(entry)
    case "tool": {
      const block: Extract<DecodedBlock, { type: "tool" }> = { type: "tool", id: entry.id, name: entry.name ?? entry.title ?? "" }
      if (entry.title !== undefined) block.title = entry.title
      if (entry.toolKind !== undefined) block.toolKind = entry.toolKind
      if (entry.status !== undefined) block.status = entry.status
      if (entry.status === "failed") block.error = true
      else if (entry.status && /cancel/i.test(entry.status)) block.canceled = true
      if (entry.input !== undefined) block.input = entry.input
      if (entry.output !== undefined) block.output = entry.output
      if (entry.outputLength !== undefined) block.outputLength = entry.outputLength
      if (entry.contentOmitted) block.contentOmitted = true
      if (entry.attachmentsOmitted !== undefined) block.attachmentsOmitted = entry.attachmentsOmitted
      if (entry.historyVersion !== undefined) block.historyVersion = entry.historyVersion
      if (entry.details?.length) block.details = entry.details
      if (entry.attachments?.length) block.attachments = entry.attachments
      if (entry.effects?.length) block.effects = entry.effects
      return block
    }
  }
}
