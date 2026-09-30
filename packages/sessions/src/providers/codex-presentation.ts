import { type AttachmentContent } from "../content.js"
import { extname, basename } from "node:path"
import { z } from "zod"
import { userTextFrom } from "../format.js"
import {
  compactionFailedEvent,
  event,
  turnFailedEvent,
  type TranscriptEvent,
} from "../events.js"

const QuestionReplies = z
  .array(z.object({ question: z.string(), answer: z.string() }))
  .min(1)
const ReviewComment = z.object({
  title: z.string(),
  body: z.string(),
  file: z.string().min(1),
  start: z.coerce.number().int().positive().optional(),
})
const IMAGE_APPENDIX =
  /(?:\s*<image name=\[Image #\d+\] path="[^"\n]+"><\/image>)+\s*$/

/** Only the complete provider envelopes are presentation metadata; examples stay literal. */
export function codexPrompt(text: string): string | undefined {
  let body = userTextFrom(text)
  if (!body) return undefined
  body = body.replace(
    /^# AGENTS\.md instructions for [^\n]+\n\s*<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/,
    ""
  )
  body = userTextFrom(body)
  if (!body) return undefined
  const reply =
    /^<send_user_message_question_reply>\s*([\s\S]+?)\s*<\/send_user_message_question_reply>$/.exec(
      body
    )
  if (reply) {
    try {
      const parsed = QuestionReplies.safeParse(JSON.parse(reply[1]!))
      if (parsed.success)
        return parsed.data
          .map(({ question, answer }) => `${question}\n\n${answer}`)
          .join("\n\n")
    } catch {
      /* A malformed envelope remains readable verbatim. */
    }
  }
  return body.replace(IMAGE_APPENDIX, "").trim() || undefined
}

function reviewComment(directive: string, attributes: string): string {
  const fields: Record<string, string> = {}
  const tokens = /([a-z]+)=("(?:[^"\\]|\\.)*"|\d+)/g
  let consumed = ""
  for (const match of attributes.matchAll(tokens)) {
    consumed += match[0]
    const value = match[2]!
    try {
      fields[match[1]!] = value.startsWith('"')
        ? z.string().parse(JSON.parse(value))
        : value
    } catch {
      return directive
    }
  }
  if (consumed.replace(/\s/g, "") !== attributes.replace(/\s/g, ""))
    return directive
  const parsed = ReviewComment.safeParse(fields)
  if (!parsed.success) return directive
  const { title, body, file, start } = parsed.data
  const path = encodeURI(file).replaceAll("(", "%28").replaceAll(")", "%29")
  const label = file.replaceAll("[", "\\[").replaceAll("]", "\\]")
  return `> **${title}**\n>\n> ${body.replaceAll("\n", "\n> ")}\n>\n> [${label}${start ? `:${start}` : ""}](<${path}${start ? `#L${start}` : ""}>)`
}

function reviewLink(href: string): string {
  try {
    const review = new URL(href)
    const pr = new URL(review.searchParams.get("pr") ?? "")
    if (pr.protocol !== "https:" || pr.username || pr.password) return href
    return pr.href
  } catch { return href }
}

export function codexPresentation(text: string): string {
  return text.split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,})/g).map((part, index) => index % 2 ? part : part
    .replace(/^::code-comment\{([^\n]*)\}\s*$/gm, reviewComment)
    .split(/(`[^`\n]*`)/g).map((span, position) => position % 2 ? span : span.replace(/codex:\/\/review\?[^\s)<>]+/g, reviewLink)).join("")
  ).join("")
}

/**
 * Codex's `CodexErrorInfo` variants in plain words. Rollouts spell them in
 * snake_case and the app-server in camelCase, so keys are compared without
 * underscores or case. `other` and unknown variants have no class.
 */
const ERROR_CLASSES = new Map([
  ["contextwindowexceeded", "Context window full"],
  ["sessionbudgetexceeded", "Session budget reached"],
  ["usagelimitexceeded", "Usage limit reached"],
  ["ratelimitexceeded", "Rate limited"],
  ["flexunavailable", "Flex processing unavailable"],
  ["serveroverloaded", "Server overloaded"],
  ["cyberpolicy", "Blocked by safety policy"],
  ["biopolicy", "Blocked by safety policy"],
  ["misalignmentpolicyviolation", "Blocked by safety policy"],
  ["toomanydenials", "Too many approvals denied"],
  ["httpconnectionfailed", "Connection failed"],
  ["responsestreamconnectionfailed", "Connection failed"],
  ["responsestreamdisconnected", "Connection lost"],
  ["responsetoomanyfailedattempts", "Too many failed attempts"],
  ["internalservererror", "Server error"],
  ["unauthorized", "Sign-in required"],
  ["badrequest", "Request rejected"],
  ["invalidprompt", "Prompt rejected"],
  ["sandboxerror", "Sandbox error"],
])
const MAX_DETAIL = 160
const COMPACTION_ERROR = /^Error running (?:remote |local )?compact task:\s*/
const EmbeddedError = z.union([
  z.object({ error: z.object({ message: z.string().min(1) }) }),
  z.object({ message: z.string().min(1) }),
])

/** The `CodexErrorInfo` variant named by `variant` in plain words. */
export function codexErrorClass(variant: string | undefined): string | undefined {
  return variant === undefined
    ? undefined
    : ERROR_CLASSES.get(variant.replaceAll("_", "").toLowerCase())
}

/**
 * The marker for a turn Codex ended with an error: the class beside the
 * label, the full message inside. A failed compaction reads as one.
 */
export function codexFailureEvent(variant: string | undefined, message: string | undefined): TranscriptEvent {
  const text = message?.trim() ?? ""
  const compaction = COMPACTION_ERROR.exec(text)
  const readable = readableError(compaction ? text.slice(compaction[0].length) : text)
  const detail = codexErrorClass(variant) ?? firstLine(readable)
  if (compaction) return compactionFailedEvent(detail)
  return turnFailedEvent(detail, readable === detail ? undefined : readable)
}

/** A provider warning: its first line beside the label, the rest inside. */
export function codexWarningEvent(text: string, more?: string | null): TranscriptEvent {
  const whole = text.trim()
  const line = firstLine(whole)
  const body = [whole === line ? "" : whole, more?.trim() ?? ""].filter(Boolean).join("\n\n")
  return { ...event("Warning", line, body), tone: "warning" }
}

/** The first line of `text`, short enough to sit beside a label. */
export function firstLine(text: string): string {
  const line = text.trimStart().split("\n", 1)[0]?.trim() ?? ""
  return line.length <= MAX_DETAIL ? line : `${line.slice(0, MAX_DETAIL - 1).trimEnd()}…`
}

/** API errors arrive as JSON bodies; their message is what a reader wants. */
function readableError(text: string): string {
  const start = text.indexOf("{")
  if (start < 0 || !text.endsWith("}")) return text
  try {
    const parsed = EmbeddedError.safeParse(JSON.parse(text.slice(start)))
    if (!parsed.success) return text
    const inner = "error" in parsed.data ? parsed.data.error.message : parsed.data.message
    return `${text.slice(0, start)}${inner}`.trim()
  } catch {
    return text
  }
}

export function codexPromptImages(text: string): AttachmentContent[] {
  const appendix = IMAGE_APPENDIX.exec(text)?.[0]
  if (!appendix) return []
  return [...appendix.matchAll(/path="([^"\n]+)"/g)].map((match) => {
    const path = match[1]!
    const extension = extname(path).slice(1).toLowerCase()
    return {
      type: "attachment",
      name: basename(path),
      mimeType: `image/${/jpe?g/.test(extension) ? "jpeg" : extension || "png"}`,
      source: { kind: "file", path },
    }
  })
}
