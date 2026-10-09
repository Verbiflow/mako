import { heavy } from "./heavy-packages.js"
/**
 * A tool's structured answer, for a model to read: YAML, which parses back
 * to the same values without JSON's quotes, braces and escapes. Absent
 * fields are left out, and long lines are never folded.
 */
export async function toolText<Report>(report: Report): Promise<string> {
  const { stringify } = await heavy.yaml.load("tool report")
  return stringify(report, { lineWidth: 0, minContentWidth: 0, aliasDuplicateObjects: false }).trimEnd()
}

/** A moment as this Mac's clock shows it, with how long ago: `04:04:01, 7 min ago`, or with its date when that isn't today. */
export function when(at: number, now = Date.now()): string {
  const moment = new Date(at)
  const pad = (value: number) => String(value).padStart(2, "0")
  const time = `${pad(moment.getHours())}:${pad(moment.getMinutes())}:${pad(moment.getSeconds())}`
  const today = new Date(now).toDateString() === moment.toDateString()
  const shown = today ? time : `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())} ${time}`
  return `${shown}, ${ago(now - at)}`
}

/** How long ago, from the milliseconds since: `7 min ago`, `3 days ago`. */
export function ago(ms: number): string {
  if (ms < 0) return "in the future"
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours} h ${minutes % 60} min ago`
  return `${Math.floor(hours / 24)} days ago`
}

/** A capped list, written out with how many it left out. */
export function listed<T>({ entries, more }: { entries: T[]; more?: number }): (T | string)[] {
  return more ? [...entries, `and ${more} more`] : entries
}
