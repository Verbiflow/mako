import { z } from "zod"

/**
 * What a context chip Mako made from something on screen holds, beyond a file.
 *
 * Every chip in a draft is one of two things. A name the catalogs resolve
 * (`@path`, `@thread:…`, `/skill`) is typed text. Anything else is a record
 * in the draft's context bucket (`useAttachments`), placed in the text by an
 * anchor, kept with the draft, carried through send recovery and the
 * clipboard, and written into the prompt by its kind (`src/lib/context/`).
 * A file is a record with bytes; these are records with a `detail` instead
 * of, or beside, bytes: the comment on a range of lines, a picked element, a
 * quote of a reply, a pull request. Each is plain data, so it survives a
 * reload and a copy, and the prompt is written from it at send.
 */

const Text = z.string().max(64_000)
const Line = z.number().int().positive()

export const CommentDetailSchema = z.object({
  kind: z.literal("comment"),
  /** Workspace-relative path the lines belong to. */
  path: z.string().min(1),
  startLine: Line,
  endLine: Line,
  /** A diff's old or new side; a file has only `new`. */
  side: z.enum(["old", "new"]),
  /** Where the lines were read: the working tree, a diff, or a commit. */
  source: z.enum(["file", "diff"]),
  /** For a diff: what the lines are compared against (`HEAD`, a branch, a commit). */
  base: z.string().optional(),
  /** The selected lines as they read, without line numbers. */
  code: Text,
  /** The person's words about them; may be empty. */
  comment: Text,
})

export const ElementDetailSchema = z.object({
  kind: z.literal("element"),
  url: z.string(),
  title: z.string(),
  tag: z.string(),
  /** A CSS selector that matched exactly this element when it was picked. */
  selector: z.string().nullable(),
  role: z.string().optional(),
  name: z.string().optional(),
  /** A bounded summary of the element's HTML. */
  html: Text,
  /** Computed styles that differ from the browser's defaults, one per line. */
  styles: Text,
  box: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  /** The nearest named component, where the page is a development build that says. */
  component: z.string().optional(),
  source: z.object({ file: z.string(), line: Line.optional(), column: Line.optional() }).optional(),
  /** What the person asked for about this element. */
  comment: Text.optional(),
})

export const QuoteDetailSchema = z.object({
  kind: z.literal("quote"),
  /** The quoted words as they read on screen. */
  text: Text,
  /** The conversation the reply belongs to, when it is not this one. */
  conversation: z.object({ harness: z.string(), id: z.string(), title: z.string().optional() }).optional(),
  /** The reply's message id, to scroll back to it. */
  messageId: z.string().optional(),
})

export const PullRequestDetailSchema = z.object({
  kind: z.literal("pull-request"),
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string(),
  state: z.enum(["open", "closed", "merged"]),
  draft: z.boolean(),
  head: z.string(),
  base: z.string(),
  author: z.string().optional(),
  /** `owner/name`, when Mako knows it. */
  repository: z.string().optional(),
})

export const ContextDetailSchema = z.discriminatedUnion("kind", [
  CommentDetailSchema,
  ElementDetailSchema,
  QuoteDetailSchema,
  PullRequestDetailSchema,
])

export type CommentDetail = z.infer<typeof CommentDetailSchema>
export type ElementDetail = z.infer<typeof ElementDetailSchema>
export type QuoteDetail = z.infer<typeof QuoteDetailSchema>
export type PullRequestDetail = z.infer<typeof PullRequestDetailSchema>
export type ContextDetail = z.infer<typeof ContextDetailSchema>

/**
 * A chip something on screen asks the composer to add: the detail, the
 * label the chip reads, and an image to carry beside it (a picked element's
 * crop).
 */
export interface ContextInput {
  detail: ContextDetail
  label: string
  image?: File
  /** Words to put after the chip, such as a comment typed with it. */
  text?: string
  /** Send the message once this chip is placed, as an annotation's ⌘↩ does; set on the last of a batch. */
  send?: boolean
}
