import { z } from "zod"
import type { AttachmentContent } from "./content.js"

const FileReference = z.object({
  name: z.string().min(1).max(1024),
  mimeType: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).max(256),
  path: z.string().min(1).max(16 * 1024).regex(/^(?:\/|[a-z]:[\\/]|\\\\)/i),
}).strict()
const Manifest = z.object({ version: z.literal(1), files: z.array(FileReference).min(1).max(128) }).strict()
const OPEN = "\n\n<mako-attachments>\n"
const CLOSE = "\n</mako-attachments>"
const MAX_MANIFEST = 1024 * 1024

export interface PromptAttachmentProjection {
  text: string
  attachments: AttachmentContent[]
}

/** File-only transports retain a versioned manifest in the native source. */
export function appendPromptAttachments(text: string, files: readonly z.infer<typeof FileReference>[]): string {
  if (!files.length) return text
  const manifest = JSON.stringify(Manifest.parse({ version: 1, files })).replaceAll("<", "\\u003c")
  if (manifest.length > MAX_MANIFEST) throw new Error("Attachment metadata exceeds the transport limit")
  return `${text}${OPEN}${manifest}${CLOSE}`
}

/** Only a complete, valid terminal manifest is metadata. Malformed/examples stay literal. */
export function readPromptAttachments(text: string): PromptAttachmentProjection {
  const unchanged = { text, attachments: [] }
  if (!text.endsWith(CLOSE)) return unchanged
  const start = text.lastIndexOf(OPEN)
  if (start < 0) return unchanged
  const json = text.slice(start + OPEN.length, -CLOSE.length)
  if (json.length > MAX_MANIFEST) return unchanged
  // A manifest shown inside an unfinished code fence is an example, not transport.
  const prefix = text.slice(0, start)
  if ((prefix.match(/^(?:`{3,}|~{3,})/gm)?.length ?? 0) % 2) return unchanged
  try {
    const parsed = Manifest.safeParse(JSON.parse(json))
    if (!parsed.success) return unchanged
    return {
      text: prefix,
      attachments: parsed.data.files.map(({ name, mimeType, path }) => ({
        type: "attachment", name, mimeType, source: { kind: "file", path },
      })),
    }
  } catch {
    return unchanged
  }
}

/** Old transports wrote each staged file as a separate native text part. */
export function legacyTextAttachment(text: string): AttachmentContent | undefined {
  const match = /^User attachment ([^\n]+) \(([\w.+-]+\/[\w.+-]+)\): ([^\n]+)$/.exec(text)
  if (!match) return undefined
  const parsed = FileReference.safeParse({ name: match[1], mimeType: match[2], path: match[3] })
  if (!parsed.success) return undefined
  return { type: "attachment", name: parsed.data.name, mimeType: parsed.data.mimeType, source: { kind: "file", path: parsed.data.path } }
}
