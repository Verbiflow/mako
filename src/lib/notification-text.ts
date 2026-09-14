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

export type NotificationKind = "ready" | "ask" | "failed"

/** What happened, as the subtitle under a thread's name. */
export function notificationHeadline(
  kind: NotificationKind,
  agent: string
): string {
  switch (kind) {
    case "ready":
      return `${agent} finished`
    case "ask":
      return `${agent} needs you`
    case "failed":
      return `${agent} failed`
  }
}

export function notificationFallbackBody(kind: NotificationKind): string {
  switch (kind) {
    case "ready":
      return "Answer ready to read."
    case "ask":
      return "Waiting for your approval."
    case "failed":
      return "The run stopped with an error."
  }
}

/**
 * One banner for a burst. Four threads finishing in the same second are one
 * fact, not four interruptions; the list is the body so the banner still
 * says which.
 */
export interface NotificationCopy {
  title: string
  body: string
}

export function summaryNotification(
  items: ReadonlyArray<{ kind: NotificationKind; title: string }>
): NotificationCopy {
  const asks = items.filter((item) => item.kind !== "ready").length
  const count = items.length
  const title =
    asks > 0
      ? `${count} threads need you`
      : `${count} answers ready`
  const names = items.map((item) => item.title)
  const shown = names.slice(0, 4)
  const rest = names.length - shown.length
  return {
    title,
    body: rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", "),
  }
}
