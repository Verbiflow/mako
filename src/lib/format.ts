const time = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
})
const day = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
})
const dayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
})

export function formatTime(value?: string | number) {
  const date = toDate(value)
  return date ? time.format(date) : ""
}

export function formatDay(value?: string | number) {
  const date = toDate(value)
  if (!date) return ""
  return date.getFullYear() === new Date().getFullYear()
    ? day.format(date)
    : dayYear.format(date)
}

/** "now", "12m", "3h", "Mon", "Apr 3" — the rail needs width discipline. */
export function formatRelative(value?: string | number) {
  const date = toDate(value)
  if (!date) return ""
  const seconds = (Date.now() - date.getTime()) / 1000
  if (seconds < 60) return "now"
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)}d`
  return formatDay(date.getTime())
}

/**
 * How long until a time to come: "in 12 min", "in 5 h", "in 89 days", or "expired" once it has passed.
 * `formatRelative` reads only the past; a future time there reads "now".
 */
export function formatUntil(value?: string | number, now = Date.now()) {
  const date = toDate(value)
  if (!date) return ""
  const minutes = (date.getTime() - now) / 60_000
  if (minutes <= 0) return "expired"
  if (minutes < 60) return `in ${Math.max(1, Math.floor(minutes))} min`
  if (minutes < 48 * 60) return `in ${Math.floor(minutes / 60)} h`
  if (minutes < 365 * 24 * 60) return `in ${Math.floor(minutes / (24 * 60))} days`
  return `on ${formatDay(date.getTime())}`
}

/** Day buckets for the session rail. */
export function bucketFor(value?: string | number) {
  const date = toDate(value)
  if (!date) return "Earlier"
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const days = Math.floor((start.getTime() - date.getTime()) / 86_400_000)
  if (days < 0) return "Today"
  if (days === 0) return "Yesterday"
  if (days < 7) return "This week"
  if (days < 30) return "This month"
  return "Earlier"
}

function toDate(value?: string | number) {
  if (value == null || value === "") return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

export function formatTokens(count: number) {
  if (count < 1000) return String(count)
  if (count < 1_000_000)
    return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function formatCost(value: number) {
  if (!value) return "$0.00"
  if (value < 0.01) return "<$0.01"
  return `$${value.toFixed(value < 10 ? 2 : 1)}`
}

/** Model pricing arrives per-token; humans read per-million. */
/**
 * A model's price, which arrives already denominated per million tokens.
 *
 * It used to multiply by a million on the way in, on the assumption that the
 * catalog quoted per-token. It does not — Opus at $5/Mtok was rendering as
 * "$5000000 per Mtok", which is the sort of number that makes a whole panel
 * look untrustworthy.
 */
export function formatRate(perMillion: number) {
  if (!perMillion) return "—"
  if (perMillion >= 100) return `$${perMillion.toFixed(0)}`
  if (perMillion >= 1) return `$${perMillion.toFixed(2)}`
  return `$${perMillion.toFixed(3)}`
}

export function formatContextWindow(tokens: number) {
  if (!tokens) return "—"
  if (tokens >= 1_000_000)
    return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M`
  return `${Math.round(tokens / 1000)}K`
}

export function workspaceName(cwd?: string) {
  if (!cwd) return "Workspace"
  return cwd.split("/").filter(Boolean).at(-1) ?? cwd
}

export function fileName(path: string) {
  return path.split("/").at(-1) ?? path
}

export function fileDir(path: string) {
  const parts = path.split("/")
  parts.pop()
  return parts.join("/")
}

export function textOf(
  blocks: Array<{ type: string; text?: string; thinking?: string }>
) {
  let out = ""
  for (const block of blocks) {
    if ((block.type === "text" || block.type === "proposed-plan") && block.text)
      out += block.text
    else if (block.type === "thinking" && block.thinking) out += block.thinking
  }
  return out.trim()
}

export function firstLine(value: string, limit = 120) {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > limit ? `${line.slice(0, limit)}…` : line
}
