import { formatDay } from "@/lib/format"

/**
 * A device the account hasn't heard from, whose Session is read from the copy it keeps there, in one line: the same
 * words on every screen that reads one, the web's strip above the transcript and a Mac window's notice over its
 * composer. "Studio is asleep or offline" · "seen 2h ago", and the copy's age only where the account listed the Session
 * as moving after the copy was written, so the copy misses what it did since: "copy from 3h ago". Without a word of when
 * it was last seen (a call to it refused before the list said it's quiet), the copy's age says what's on screen.
 */
export function quietLine({ name, seenAt, copyAt, activityAt, now = Date.now() }: { name: string; seenAt?: number; copyAt?: number; activityAt?: number; now?: number }): QuietLine {
  const parts: string[] = []
  if (seenAt !== undefined) parts.push(`seen ${ago(seenAt, now)}`)
  if (copyAt !== undefined && (seenAt === undefined || (activityAt !== undefined && copyAt < activityAt))) parts.push(`copy from ${ago(copyAt, now)}`)
  return { title: `${name} ${QUIET_WORDS}`, ...(parts.length > 0 && { description: parts.join(" · ") }) }
}

/** A quiet device's line: what it is ("Studio is asleep or offline"), then since when and the copy's age, where said. */
export interface QuietLine {
  title: string
  description?: string
}

/** What a quiet device is, after its name: a line short of room shortens the name, never these. */
export const QUIET_WORDS = "is asleep or offline"

/** "a moment ago", as the diagnosis says it, "12m ago", "3h ago", "2d ago", then the day: never in the future, a clock ahead of this one notwithstanding. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - Math.min(at, now)) / 60_000)
  if (minutes < 1) return "a moment ago"
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`
  return `on ${formatDay(at)}`
}
