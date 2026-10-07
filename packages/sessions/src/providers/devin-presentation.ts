import { z } from "zod"
import type { AttachmentContent } from "../content.js"

/**
 * Devin's reference markup as Devin 3000.10.23 streams it to its client,
 * outside code: `<ref_file file="P" />` becomes `[name](file://P)` and
 * `<ref_snippet file="P" lines="2-4" />` becomes `[name:2-4](file://P)`.
 * Its store keeps the model's tags.
 */
export function devinReferences(text: string): string {
  return text
    .split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /<ref_(?:file\s+file="([^"\n]+)"|snippet\s+file="([^"\n]+)"\s+lines="([^"\n]+)")\s*\/>/g,
            (_match, file: string | undefined, snippet: string | undefined, lines: string | undefined) => {
              const path = file ?? snippet ?? ""
              const name = path.split("/").at(-1) ?? path
              return `[${lines ? `${name}:${lines}` : name}](file://${path})`
            }
          )
    )
    .join("")
}

export function devinPromptImages(text: string) {
  const attachments: AttachmentContent[] = []
  const body = text
    .split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,}|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(
            /\[Image\s+\d+:\s*(\/[^\]\n]+\.(png|jpe?g|webp|gif))\]/gi,
            (_match, path: string, extension: string) => {
              attachments.push({
                type: "attachment",
                name: path.split("/").at(-1) ?? "Image",
                mimeType: `image/${/^jpe?g$/i.test(extension) ? "jpeg" : extension.toLowerCase()}`,
                source: { kind: "file", path },
              })
              return ""
            }
          )
    )
    .join("")
  return { text: body.trim(), attachments }
}

const McpCall = z.object({
  server_name: z.string(),
  tool_name: z.string(),
  arguments: z.record(z.string(), z.json()),
})
export function devinMcpCall(
  input: string | undefined
): { name: string; input: string } | undefined {
  if (!input) return undefined
  try {
    const parsed = McpCall.safeParse(JSON.parse(input))
    return parsed.success
      ? {
          name: `${parsed.data.server_name}.${parsed.data.tool_name}`,
          input: JSON.stringify(parsed.data.arguments),
        }
      : undefined
  } catch {
    return undefined
  }
}
