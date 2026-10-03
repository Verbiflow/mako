import mimeTypes from "mime"
import textExtensions from "text-extensions"

/** Shared file-format policy. Native source resolution stays with the host. */
export type DiagnosticFormat =
  "har" | "cpu-profile" | "heap-profile" | "heap-snapshot" | "trace"
export type FilePreviewFormat =
  | DiagnosticFormat
  | "image"
  | "audio"
  | "video"
  | "pdf"
  | "markdown"
  | "html"
  | "table"
  | "text"
  | "word"
  | "workbook"
  | "presentation"

interface PreviewFormat {
  id: FilePreviewFormat
  extensions: readonly string[]
  mimeTypes: readonly string[]
}

export const FILE_PREVIEW_FORMATS: readonly PreviewFormat[] = [
  {
    id: "word",
    extensions: ["docx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
  },
  {
    id: "workbook",
    extensions: ["xlsx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
  },
  {
    id: "presentation",
    extensions: ["pptx"],
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
  },
  {
    id: "image",
    extensions: [],
    mimeTypes: ["image/"],
  },
  {
    id: "audio",
    extensions: [],
    mimeTypes: ["audio/"],
  },
  {
    id: "video",
    extensions: [],
    mimeTypes: ["video/"],
  },
  { id: "pdf", extensions: ["pdf"], mimeTypes: ["application/pdf"] },
  {
    id: "markdown",
    extensions: ["md", "mdx", "markdown"],
    mimeTypes: ["text/markdown"],
  },
  { id: "html", extensions: ["htm", "html"], mimeTypes: ["text/html"] },
  {
    id: "table",
    extensions: ["csv", "tsv"],
    mimeTypes: ["text/csv", "text/tab-separated-values"],
  },
  { id: "har", extensions: ["har"], mimeTypes: ["application/har+json"] },
  { id: "cpu-profile", extensions: ["cpuprofile"], mimeTypes: [] },
  { id: "heap-profile", extensions: ["heapprofile"], mimeTypes: [] },
  { id: "heap-snapshot", extensions: ["heapsnapshot"], mimeTypes: [] },
  { id: "trace", extensions: ["trace.json", "perfetto.json"], mimeTypes: [] },
]

export type OfficeFormat = "word" | "workbook" | "presentation"
export function officeFormat(
  path: string,
  mimeType?: string
): OfficeFormat | undefined {
  const format = filePreviewFormat(path, mimeType)
  return format === "word" || format === "workbook" || format === "presentation"
    ? format
    : undefined
}

export function filePreviewFormat(
  path: string,
  mimeType = ""
): FilePreviewFormat | undefined {
  const name = path.split(/[?#]/)[0]?.toLowerCase() ?? ""
  const mime =
    (mimeType || fileMimeTypeForPath(path) || "")
      .split(";")[0]
      ?.toLowerCase() ?? ""
  // Explicit diagnostic suffixes beat the generic application/json MIME.
  const byPath = FILE_PREVIEW_FORMATS.find((format) =>
    format.extensions.some((extension) => name.endsWith(`.${extension}`))
  )
  return (
    byPath?.id ??
    FILE_PREVIEW_FORMATS.find((format) =>
      format.mimeTypes.some((type) =>
        type.endsWith("/") ? mime.startsWith(type) : mime === type
      )
    )?.id ??
    (isTextFile(path, mime) ? "text" : undefined)
  )
}

export function diagnosticFormat(path: string): DiagnosticFormat | undefined {
  const format = filePreviewFormat(path)
  return format === "har" ||
    format === "cpu-profile" ||
    format === "heap-profile" ||
    format === "heap-snapshot" ||
    format === "trace"
    ? format
    : undefined
}

// Library data covers common media and programming-language extensions. These
// few application formats express transport policy, not another MIME database.
const textTypes = new Set(textExtensions)
const structuredText = new Set([
  "jsonl",
  "ndjson",
  "svelte",
  "lock",
  "env",
  "ipynb",
])
export function isTextFile(path: string, mime = ""): boolean {
  const extension =
    path.split(/[?#]/)[0]?.split(".").at(-1)?.toLowerCase() ?? ""
  return (
    textTypes.has(extension) ||
    structuredText.has(extension) ||
    mime.startsWith("text/") ||
    /(?:\/json|\/xml|\+json|\+xml)$/.test(mime)
  )
}
export function fileMimeTypeForPath(path: string): string | undefined {
  const name = path.split(/[?#]/)[0] ?? path
  const mime = mimeTypes.getType(name) ?? undefined
  // .ts source and some other language suffixes collide with registered media
  // types. Maintained text-extension data wins for filename-only classification.
  if (
    isTextFile(name) &&
    !mime?.startsWith("text/") &&
    !mime?.endsWith("+xml") &&
    mime !== "image/svg+xml"
  )
    return mime === "application/json" ? mime : "text/plain"
  return mime
}
