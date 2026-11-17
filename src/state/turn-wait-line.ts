import type { TurnWaitLine } from "@mako/host/contracts/turn-waits"
import { getMako, hasBridge } from "@/lib/bridge"
import { toast } from "sonner"

/**
 * When a wait's time runs out, as its line says it: the time alone today, the weekday within the week, the date
 * beyond ("until 9:00", "until Tue 9:00", "until Nov 22, 9:00"), in the reader's own clock.
 */
export function waitUntilWords(endsBy: number, now: number, locale?: string, timeZone?: string): string {
  const options = { ...(timeZone && { timeZone }) }
  const time = new Intl.DateTimeFormat(locale, { ...options, hour: "numeric", minute: "2-digit" }).format(endsBy)
  const day = (at: number) => new Intl.DateTimeFormat("en-CA", { ...options, year: "numeric", month: "2-digit", day: "2-digit" }).format(at)
  if (day(endsBy) === day(now)) return `until ${time}`
  if (endsBy - now < 6 * 24 * 60 * 60 * 1000) return `until ${new Intl.DateTimeFormat(locale, { ...options, weekday: "short" }).format(endsBy)} ${time}`
  return `until ${new Intl.DateTimeFormat(locale, { ...options, month: "short", day: "numeric" }).format(endsBy)}, ${time}`
}

/** The line's words: what it waits for, and until when ("Waiting for CI on #412 · until Tue 9:00"). */
export function waitLineWords(line: Pick<TurnWaitLine, "description" | "endsBy">, now: number, locale?: string, timeZone?: string): string {
  return line.endsBy === undefined ? line.description : `${line.description} · ${waitUntilWords(line.endsBy, now, locale, timeZone)}`
}

/**
 * The person's Stop waiting: the wait the line showed ends, waking no one. The line clears by itself when the host
 * says the wait ended; a wait that ended meanwhile, or a newer one, is left as it is.
 */
export async function stopWaiting(conversation: string, wait: string): Promise<boolean> {
  if (!hasBridge()) return false
  try {
    return await getMako().liveWaitStop(conversation, wait)
  } catch (error) {
    toast.error("The wait couldn't be stopped", { description: error instanceof Error ? error.message : String(error) })
    return false
  }
}
