import type { JsonObject } from "../../codex-app-json.js"
import type { AttachmentContent } from "@mako/sessions"
import { fileURLToPath } from "node:url"
import { z } from "zod"

const Source = z.object({
  type: z.string().optional(),
  path: z.string().optional(),
  imageUrl: z.string().optional(),
  url: z.string().optional(),
  result: z.string().optional(),
  mimeType: z.string().optional(),
  filename: z.string().optional(),
})
function localPath(path: string): string {
  if (!path.startsWith("file:")) return path
  const url = URL.parse(path)
  return url && (!url.hostname || url.hostname === "localhost")
    ? fileURLToPath(url)
    : path
}

export function attachmentFromCodexContent(
  value: JsonObject
): AttachmentContent {
  const parsed = Source.parse(value)
  // Codex records viewed images as `file://` URLs in some item shapes.
  const source = parsed.path
    ? { ...parsed, path: localPath(parsed.path) }
    : parsed
  const mimeType =
    source.mimeType ??
    (source.type?.toLowerCase().includes("audio") ? "audio/wav" : "image/png")
  const url = source.imageUrl ?? source.url
  const data = url ? /^data:([^;,]+);base64,([\s\S]*)$/.exec(url) : null
  return {
    type: "attachment",
    name:
      source.filename ??
      source.path?.split("/").at(-1) ??
      source.type ??
      "Attachment",
    mimeType: data?.[1] ?? mimeType,
    source: source.path
      ? { kind: "file", path: source.path }
      : data
        ? { kind: "inline", data: data[2] ?? "" }
        : url
          ? { kind: "url", url }
          : source.result
            ? { kind: "inline", data: source.result }
            : {
                kind: "unavailable",
                reason:
                  "The provider did not retain a readable attachment source",
              },
  }
}
