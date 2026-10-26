import { z } from "zod"
import { ReviewReportSchema } from "./review.js"

/** Portable attachment references. Inline data is retained only within reader budgets. */
export const AttachmentSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("file"),
    path: z.string().min(1),
    originalPath: z.string().optional(),
  }),
  z.object({ kind: z.literal("url"), url: z.string().min(1) }),
  z.object({ kind: z.literal("inline"), data: z.string() }),
  z.object({ kind: z.literal("unavailable"), reason: z.string() }),
])

export const AttachmentContentSchema = z.object({
  type: z.literal("attachment"),
  id: z.string().optional(),
  name: z.string(),
  mimeType: z.string(),
  source: AttachmentSourceSchema,
})

export type AttachmentContent = z.infer<typeof AttachmentContentSchema>

export function attachmentFromUrl(
  name: string,
  mimeType: string,
  url: string
): AttachmentContent {
  if (url.startsWith("file://")) {
    const file = new URL(url)
    if (!file.hostname || file.hostname === "localhost")
      return {
        type: "attachment",
        name,
        mimeType,
        source: { kind: "file", path: decodeURIComponent(file.pathname) },
      }
  }
  const data = /^data:([^;,]+)?;base64,([\s\S]*)$/.exec(url)
  return {
    type: "attachment",
    name,
    mimeType: data?.[1] || mimeType,
    source: data
      ? { kind: "inline", data: data[2] ?? "" }
      : { kind: "url", url },
  }
}

export function attachmentDescription(attachment: AttachmentContent): string {
  switch (attachment.source.kind) {
    case "file":
      return `${attachment.name}: ${attachment.source.path}`
    case "url":
      return `${attachment.name}: ${attachment.source.url}`
    case "inline":
      return `${attachment.name}: inline ${attachment.mimeType} attachment`
    case "unavailable":
      return `${attachment.name}: ${attachment.source.reason}`
  }
}

/** Provider-supplied results that cannot be reconstructed reliably from plain text. */
export const ToolDetailSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("diff"),
    path: z.string(),
    oldText: z.string().nullable(),
    newText: z.string(),
  }),
  z.object({ type: z.literal("terminal"), terminalId: z.string() }),
  z.object({
    type: z.literal("location"),
    path: z.string(),
    line: z.number().optional(),
  }),
  z.object({
    type: z.literal("plan"),
    entries: z.array(z.object({ content: z.string(), status: z.string() })),
  }),
  ReviewReportSchema.extend({ type: z.literal("review") }),
  /**
   * Media files the tool's result stated, from its `_meta` (`MEDIA_META` in
   * `turn-media.ts`): `show` put them in front of the person, `produced`
   * says the call made them (a recording, a saved screenshot).
   */
  z.object({
    type: z.literal("media"),
    via: z.enum(["show", "produced"]),
    title: z.string().max(200).optional(),
    files: z.array(z.object({
      path: z.string().min(2).startsWith("/"),
      caption: z.string().max(500).optional(),
      /** The SHA-256 of the copy Mako kept when it showed the file. */
      digest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })).min(1).max(64),
  }),
])
export type ToolDetail = z.infer<typeof ToolDetailSchema>

export function describeToolDetails(details: ToolDetail[]): string {
  return details
    .map((detail) => {
      switch (detail.type) {
        case "diff":
          return `File: ${detail.path}\nBefore:\n${detail.oldText ?? ""}\nAfter:\n${detail.newText}`
        case "terminal":
          return `Provider terminal: ${detail.terminalId}`
        case "location":
          return detail.line === undefined
            ? detail.path
            : `${detail.path}:${detail.line}`
        case "plan":
          return detail.entries
            .map((entry) => `${entry.status}: ${entry.content}`)
            .join("\n")
        case "review":
          return [
            detail.summary,
            ...detail.findings.map((finding) => {
              const where = finding.path ? ` (${finding.path}${finding.line ? `:${finding.line}` : ""})` : ""
              const priority = finding.priority === undefined ? "" : `[P${finding.priority}] `
              return `${priority}${finding.title}${where}${finding.body ? `\n${finding.body}` : ""}`
            }),
          ].filter(Boolean).join("\n\n") || "No findings."
        case "media":
          return [detail.title, ...detail.files.map((file) => file.caption ? `${file.path} (${file.caption})` : file.path)].filter(Boolean).join("\n")
      }
    })
    .join("\n\n")
}

/** A proposed plan is an answer artifact, distinct from an execution checklist. */
export const MAX_PROPOSED_PLAN_LENGTH = 256_000
export const ProposedPlanSchema = z.object({
  type: z.literal("proposed-plan"),
  id: z.string(),
  text: z.string().max(MAX_PROPOSED_PLAN_LENGTH),
  status: z.enum(["drafting", "proposed"]),
  truncated: z.boolean().optional(),
})
export type ProposedPlan = z.infer<typeof ProposedPlanSchema>

/**
 * A plan an agent proposed, as saved history shows it. `id` is the id its
 * live session gives the plan, so a build recorded there finds this card.
 * A blank plan is none.
 */
export function proposedPlanBlock(id: string, text: string): ProposedPlan | undefined {
  if (!text.trim()) return undefined
  return text.length > MAX_PROPOSED_PLAN_LENGTH
    ? { type: "proposed-plan", id, text: text.slice(0, MAX_PROPOSED_PLAN_LENGTH), status: "proposed", truncated: true }
    : { type: "proposed-plan", id, text, status: "proposed" }
}

/** A session's plan cards, one per id: a revised plan rewrites the card already placed. */
export class ProposedPlans {
  private readonly placed = new Map<string, ProposedPlan>()

  /** The card to place for a new plan, or the placed card a revision rewrote; a blank plan is neither. */
  propose(id: string, text: string): { card: ProposedPlan; revised: boolean } | undefined {
    const block = proposedPlanBlock(id, text)
    if (!block) return undefined
    const placed = this.placed.get(id)
    if (!placed) {
      this.placed.set(id, block)
      return { card: block, revised: false }
    }
    delete placed.truncated
    Object.assign(placed, block)
    return { card: placed, revised: true }
  }
}
