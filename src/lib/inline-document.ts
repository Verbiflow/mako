import type { FileContents } from "./types"
import {
  diagnosticFormat,
  filePreviewFormat,
} from "../../electron/contracts/file-preview"

/** Native inline text never requires an invented workspace path or a bridge read. */
export function inlineDocument(input: {
  name: string
  mimeType: string
  data: string
}): FileContents {
  const format = filePreviewFormat(input.name, input.mimeType)
  const size = Math.max(
    0,
    Math.floor((input.data.length * 3) / 4) -
      (input.data.endsWith("==") ? 2 : input.data.endsWith("=") ? 1 : 0)
  )
  const diagnostic = diagnosticFormat(input.name)
  if (diagnostic) {
    if (size > 32 * 1024 * 1024)
      throw new Error("This attachment exceeds the 32 MB inspection limit.")
    return {
      path: input.name,
      mimeType: input.mimeType,
      contents: "",
      binary: true,
      size,
      truncated: false,
      diagnostic,
      previewUrl: `data:application/json;base64,${input.data}`,
    }
  }
  const limit = format === "html" ? 200_000 : 64_000
  // Base64 groups remain intact; TextDecoder tolerates a split final codepoint
  // only for an explicitly labelled excerpt. Complete text must be valid UTF-8.
  const excerpt = size > limit
  const encoded = input.data.slice(0, Math.ceil(limit / 3) * 4)
  const bytes = Uint8Array.from(atob(encoded), (character) =>
    character.charCodeAt(0)
  )
  const contents = new TextDecoder("utf-8", { fatal: !excerpt }).decode(
    bytes.subarray(0, limit)
  )
  return {
    path: input.name,
    mimeType: input.mimeType,
    contents,
    binary: false,
    size,
    truncated: excerpt,
  }
}

/** Allocate original bytes only when the user downloads, never while rendering. */
export function downloadInlineDocument(input: {
  name: string
  mimeType: string
  data: string
}): void {
  if (input.data.length > Math.ceil((256 * 1024 * 1024 * 4) / 3))
    throw new Error("This attachment exceeds the 256 MB download limit.")
  const bytes = Uint8Array.from(atob(input.data), (character) =>
    character.charCodeAt(0)
  )
  const href = URL.createObjectURL(new Blob([bytes], { type: input.mimeType }))
  const link = document.createElement("a")
  link.href = href
  link.download = input.name
  link.click()
  setTimeout(() => URL.revokeObjectURL(href), 1000)
}
