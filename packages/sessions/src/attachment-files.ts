import { entryAttachments, type Entry } from "./entries.js"

/** Exact provider-referenced files, used to authorize artifact reads outside a workspace. */
export function attachmentFiles(entries: readonly Entry[]): string[] {
  return entries.flatMap((entry) => {
    return entryAttachments(entry).flatMap((attachment) =>
      attachment.source.kind === "file" ? [attachment.source.path] : []
    )
  })
}
