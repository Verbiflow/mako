import { z } from "zod"

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
