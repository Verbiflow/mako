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

/** A value of Codex's wire or rollout, parsed as JSON, before its schema reads it. */
type CodexJson = string | number | boolean | null | CodexJson[] | { [key: string]: CodexJson | undefined }

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

function imageFile(path: string): AttachmentContent {
  const extension = extname(path).slice(1).toLowerCase()
  return {
    type: "attachment",
    name: basename(path),
    mimeType: `image/${/jpe?g/.test(extension) ? "jpeg" : extension || "png"}`,
    source: { kind: "file", path },
  }
}

export function codexPromptImages(text: string): AttachmentContent[] {
  const appendix = IMAGE_APPENDIX.exec(text)?.[0]
  if (!appendix) return []
  return [...appendix.matchAll(/path="([^"\n]+)"/g)].map((match) => imageFile(match[1]!))
}

const GeneratedImageSchema = z.object({ savedPath: z.string().min(1).nullish(), result: z.string().nullish() })

/** An image Codex generated: the file it saved, else the PNG it returned. */
export function codexGeneratedImage(item: CodexJson | undefined): AttachmentContent {
  const image = GeneratedImageSchema.safeParse(item).data
  if (image?.savedPath) return imageFile(image.savedPath)
  return {
    type: "attachment",
    name: "Generated image",
    mimeType: "image/png",
    source: image?.result ? { kind: "inline", data: image.result } : { kind: "unavailable", reason: "Codex kept no image from this generation" },
  }
}

/**
 * The command Codex's model asked for. Codex runs it as `[shell, "-lc",
 * script]`; the app-server reports that argv shell-quoted into one string,
 * the rollout keeps it as an array. Either way the script is what was asked.
 */
export function codexCommand(command: string | string[]): string {
  const words = Array.isArray(command) ? command : shellWords(command)
  const [shell, flag, script, ...rest] = words ?? []
  if (shell && script !== undefined && !rest.length && /(?:^|\/)(?:zsh|bash|sh)$/.test(shell) && (flag === "-lc" || flag === "-c")) return script
  return Array.isArray(command) ? command.join(" ") : command
}

/** POSIX shell words, or `undefined` for text no shell would split the same way. */
function shellWords(text: string): string[] | undefined {
  const words: string[] = []
  let word: string | undefined
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (char === " " || char === "\t" || char === "\n") {
      if (word !== undefined) words.push(word)
      word = undefined
    } else if (char === "'") {
      const end = text.indexOf("'", index + 1)
      if (end < 0) return undefined
      word = (word ?? "") + text.slice(index + 1, end)
      index = end
    } else if (char === "\"") {
      word ??= ""
      for (index++; index < text.length && text[index] !== "\""; index++) {
        if (text[index] === "\\" && /["\\$`\n]/.test(text[index + 1] ?? "")) index++
        word += text[index]
      }
      if (index >= text.length) return undefined
    } else if (char === "\\") {
      word = (word ?? "") + (text[++index] ?? "")
    } else word = (word ?? "") + char
  }
  if (word !== undefined) words.push(word)
  return words
}

/** What a finished command shows: its output, or its exit code when it failed without any. */
export function codexCommandOutput(output: string | null | undefined, exitCode: number | null | undefined): string | undefined {
  if (output) return output
  return exitCode ? `Exited with code ${exitCode}` : undefined
}

/**
 * The text Codex writes before an `exec_command` call's output in what it
 * sends its model, and the exit code in it. A rollout without typed items
 * keeps only this.
 */
const EXEC_HEADER = /^Chunk ID: \S+\nWall time: [^\n]*\n(?:Process exited with code (-?\d+)\n)?(?:Process running with session ID \d+\n)?Original token count: \d+\nOutput:\n/

export function codexExecOutput(text: string): { output: string; exitCode?: number } | undefined {
  const header = EXEC_HEADER.exec(text)
  if (!header) return undefined
  return { output: text.slice(header[0].length), exitCode: header[1] === undefined ? undefined : Number(header[1]) }
}

const CELL_HEADER = /^Script (completed|failed)\nWall time [^\n]*\nOutput:\n/
/** A code cell's output as Codex gives it to the model: one text, or text parts. */
export const CodexCellOutputSchema = z.union([
  z.string().transform((text) => [text]),
  z.array(z.object({ text: z.string() }).loose()).transform((parts) => parts.map((part) => part.text)),
])

/**
 * What Codex gives the model when a code cell ends (codex 0.159.3): `Script
 * completed` or `Script failed`, the wall time, what the script printed and,
 * for a failure, `Script error:` and what it threw. The cell's calls carry
 * their own results; only a failure is the cell's own.
 */
export function codexCellResult(texts: readonly string[]): { failed: boolean; output: string } | undefined {
  const text = texts.join("\n")
  const header = CELL_HEADER.exec(text)
  if (!header) return undefined
  return { failed: header[1] === "failed", output: text.slice(header[0].length).replace(/(^|\n)Script error:\n/, "$1").trim() }
}

const FUNCTION_OUTPUT_PLACEHOLDERS = { input_image: "[image]", input_audio: "[audio]", encrypted_content: "[encrypted content]" } as const

/** A `FunctionCallOutput` item's body: one text, or content parts read as text. */
export const CodexFunctionOutputSchema = z.union([z.string(), z.array(z.discriminatedUnion("type", [
  z.object({ type: z.literal("input_text"), text: z.string() }),
  z.object({ type: z.literal("input_image") }).loose(),
  z.object({ type: z.literal("input_audio") }).loose(),
  z.object({ type: z.literal("encrypted_content") }).loose(),
])).transform((parts) => parts.map((part) => part.type === "input_text" ? part.text : FUNCTION_OUTPUT_PLACEHOLDERS[part.type]).join("\n"))])

const SearchActionSchema = z.object({
  query: z.string().nullish(),
  queries: z.array(z.string()).nullish(),
  url: z.string().nullish(),
})
const SearchResultSchema = z.object({ title: z.string().optional(), url: z.string().min(1) })

/** What a web search looked for: its query, its queries, or the page it opened. */
export function codexSearchTarget(action: CodexJson | undefined): string | undefined {
  const target = SearchActionSchema.safeParse(action)
  if (!target.success) return undefined
  const { query, queries, url } = target.data
  return query || queries?.join(" · ") || url || undefined
}

/** Standalone search returns its results on the item; hosted search returns none. */
export function codexSearchResults(results: CodexJson | undefined): string | undefined {
  const lines = (Array.isArray(results) ? results : []).flatMap((result) => {
    const parsed = SearchResultSchema.safeParse(result)
    if (!parsed.success) return []
    const { title, url } = parsed.data
    return [title ? `${title}\n${url}` : url]
  })
  return lines.length ? lines.join("\n\n") : undefined
}

/**
 * What Codex tells its model of a call the person stopped (`abort_message`,
 * codex-rs/core/src/tools/parallel.rs): `Wall time: 1.2 seconds\naborted by
 * user` for `exec_command`, `aborted by user after 1.2s` for any other tool.
 */
const ABORTED = /^(?:Wall time: [\d.]+ seconds\naborted by user|aborted by user after [\d.]+s)$/

export function codexAborted(text: string): boolean {
  return ABORTED.test(text)
}

export interface CodexPatchChange {
  path: string
  type: "add" | "delete" | "update"
  movePath?: string | null
  diff: string
}

/** A patch as one text: each file's change, a unified diff for an update. */
export function codexPatchText(changes: readonly CodexPatchChange[]): string {
  return changes.map(({ path, type, movePath, diff }) => {
    switch (type) {
      case "add":
        return `Add ${path}\n${prefixLines(diff, "+")}`
      case "delete":
        return `Delete ${path}\n${prefixLines(diff, "-")}`
      case "update":
        return `Update ${movePath ? `${path} → ${movePath}` : path}\n${diff.trimEnd()}`
    }
  }).join("\n\n")
}

function prefixLines(text: string, prefix: string): string {
  return text.trimEnd().split("\n").map((line) => `${prefix}${line}`).join("\n")
}

/** A patch tool's arguments: the files it changed. */
export function codexPatchInput(paths: readonly string[]): { path: string; paths: string[] } | undefined {
  return paths.length ? { path: paths[0]!, paths: [...paths] } : undefined
}
