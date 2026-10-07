import { z } from "zod"
import { ToolDetailSchema, type ToolDetail } from "./content.js"

/** An ACP value as JSON carries it: tool content, raw output, a history line's field. */
export type AcpContentValue =
  | string
  | number
  | boolean
  | null
  | AcpContentValue[]
  | { [key: string]: AcpContentValue | undefined }

const acpDetail = z.union([
  ToolDetailSchema,
  z
    .object({
      type: z.literal("diff"),
      path: z.string(),
      oldText: z.string().nullish(),
      newText: z.string(),
    })
    .transform((diff) => ({ ...diff, oldText: diff.oldText ?? null })),
])

/** ACP's `locations`: the files a tool call works on. */
export const AcpLocationsSchema = z.array(z.object({ path: z.string(), line: z.number().nullish() }))
export type AcpLocation = z.infer<typeof AcpLocationsSchema>[number]

/** The files a tool call works on, as links after its content. */
export function acpLocationDetails(locations: readonly AcpLocation[] | null | undefined): ToolDetail[] {
  return (locations ?? []).map((location) => ({
    type: "location",
    path: location.path,
    line: location.line ?? undefined,
  }))
}

/** Native ACP journals carry the same structured tool content as live updates. */
export function acpToolDetails(
  content: AcpContentValue | undefined
): ToolDetail[] {
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => {
    const parsed = acpDetail.safeParse(part)
    return parsed.success ? [parsed.data] : []
  })
}

const TEXT_KEYS = ["content", "output_for_prompt", "output", "result", "message", "error"]
const Words = z.string()
const Parts = z.array(z.unknown())
const Fields = z.record(z.string(), z.unknown())

/**
 * The words in an ACP value: a string as it is, content parts joined, or the
 * first text under a key agents put output in. A structured tool result with
 * no such text (an edit's report, a todo list's state) has none; its content
 * or the vendor's decoder says what it did.
 */
export function acpText(value: AcpContentValue | undefined): string {
  return wordsIn(value)
}

function wordsIn(value: z.infer<typeof Fields>[string]): string {
  const words = Words.safeParse(value)
  if (words.success) return words.data
  const parts = Parts.safeParse(value)
  if (parts.success) return parts.data.map(wordsIn).join("")
  const fields = Fields.safeParse(value)
  if (!fields.success) return ""
  const text = Words.safeParse(fields.data["text"])
  if (text.success) return text.data
  for (const key of TEXT_KEYS) {
    const nested = wordsIn(fields.data[key])
    if (nested) return nested
  }
  return ""
}
