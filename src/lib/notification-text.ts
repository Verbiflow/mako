import { attentionHeadline, type AttentionKind } from "@mako/host/contracts/notifications"

/**
 * The words on a notification.
 *
 * A banner has one line for the body and no markdown renderer, so an agent's
 * reply is reduced to its opening paragraph as plain text. Replies open with
 * a summary sentence far more often than not, which makes the first paragraph
 * the right excerpt; the rest is on screen one click away.
 */
export const NOTIFICATION_BODY_LIMIT = 200

/** Strip the markdown that would read as noise in a banner, keeping the words. */
export function plainText(markdown: string): string {
  return (
    markdown
      // Fenced code keeps its contents; the fence itself is noise.
      .replace(/```[^\n]*\n?/g, "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/^>\s?/gm, "")
      // Horizontal whitespace only: `\s` would eat the blank line above a list.
      .replace(/^[ \t]*(?:[-*+]|\d+[.)])[ \t]+/gm, "")
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/<(https?:\/\/[^>]+)>/g, "$1")
      .replace(/(\*\*|__)(.*?)\1/g, "$2")
      .replace(/(\*|_)(.*?)\1/g, "$2")
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
  )
}

/** The first paragraph, whitespace collapsed, cut at a word before the limit. */
export function excerpt(text: string, limit = NOTIFICATION_BODY_LIMIT): string {
  const paragraph =
    plainText(text)
      .split(/\n\s*\n/)
      .map((part) => part.replace(/\s+/g, " ").trim())
      .find((part) => part.length > 0) ?? ""
  if (paragraph.length <= limit) return paragraph
  const cut = paragraph.slice(0, limit)
  const boundary = cut.lastIndexOf(" ")
  return `${(boundary > limit * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`
}

export type NotificationKind = AttentionKind

/** What happened, as the subtitle under a thread's name, in the words every surface uses (`attentionHeadline`). */
export function notificationHeadline(kind: NotificationKind, agent: string): string {
  return attentionHeadline(kind, agent)
}
