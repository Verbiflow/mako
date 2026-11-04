import type { FileEventsMeasure, FileEventsRestart, FileEventsService } from "@mako/host/contracts/file-events-service"
import { formatBytes } from "@/lib/format"

/** A delay as people read it: milliseconds under a second, seconds past it. */
export function lagText(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`
}

/** How long, in the largest unit that reads well: seconds, minutes, then hours. */
export function spanText(ms: number): string {
  const count = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"}`
  if (ms < 120_000) return count(Math.max(1, Math.round(ms / 1_000)), "second")
  if (ms < 2 * 3_600_000) return count(Math.round(ms / 60_000), "minute")
  return count(Math.round(ms / 3_600_000), "hour")
}

/** What the degraded daemon is doing, in numbers: how late, how much memory. */
export function degradedText(service: FileEventsService): string {
  const memory = service.residentBytes !== undefined ? formatBytes(service.residentBytes) : undefined
  const late = service.silentMs !== undefined
    ? `hasn't delivered a file change for ${spanText(service.silentMs)}`
    : service.lagMs !== undefined ? `delivers file changes ${lagText(service.lagMs)} late (normally under 100 ms)` : undefined
  const holding = memory ? `holds ${memory} of memory${service.degraded?.memory ? " (normally under 50 MB)" : ""}` : undefined
  const said = [holding, late].filter(Boolean).join(" and ")
  return `fseventsd ${said || "is degraded"}. Every app that watches files waits on it, not just Mako.`
}

/** A restart's before and after, as one sentence; empty when neither was measured. */
export function restartedText(restart: FileEventsRestart): string {
  const after = restart.after ?? {}
  const parts = [
    after.lagMs !== undefined ? `File changes now arrive in ${lagText(after.lagMs)}${was(restart.before.lagMs, lagText)}` : undefined,
    after.residentBytes !== undefined ? `it holds ${formatBytes(after.residentBytes)}${was(restart.before.residentBytes, formatBytes)}` : undefined,
  ].filter(Boolean)
  return parts.length ? `${parts.join(", and ")}.` : ""
}

function was(value: FileEventsMeasure[keyof FileEventsMeasure], format: (value: number) => string): string {
  return value === undefined ? "" : ` (was ${format(value)})`
}
