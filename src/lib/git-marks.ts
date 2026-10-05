import type { GitFileStatus } from "@/lib/types"

export interface StatusMark {
  glyph: string
  tone: string
  title: string
}

/** Quiet on purpose: an edit is the common case, so only what arrives, goes or conflicts takes a hue. */
export const MARK = {
  conflicted: { glyph: "!", tone: "text-removed", title: "Merge conflict" },
  added: { glyph: "A", tone: "text-added/75", title: "Added" },
  untracked: { glyph: "U", tone: "text-added/75", title: "Untracked" },
  modified: { glyph: "M", tone: "text-faint", title: "Modified" },
  deleted: { glyph: "D", tone: "text-removed/75", title: "Deleted" },
} satisfies Record<GitFileStatus, StatusMark>
