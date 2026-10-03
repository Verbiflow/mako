import {
  diagnosticFormat,
  fileMimeTypeForPath,
  isTextFile,
} from "../../electron/contracts/file-preview"
import type { AttachmentKind } from "./attachments"

/** Prompt transport policy; preview selection is a separate shared contract. */
export function classify(file: Pick<File, "name" | "type">): AttachmentKind {
  if (diagnosticFormat(file.name)) return "binary"
  const mime =
    file.type || fileMimeTypeForPath(file.name) || "application/octet-stream"
  if (mime.startsWith("image/") && mime !== "image/svg+xml") return "image"
  if (isTextFile(file.name, mime)) return "text"
  return "binary"
}
