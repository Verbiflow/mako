import type { FileEventsSample, FileEventsService } from "@mako/host/contracts/file-events-service"
import { LAG_BEATS } from "@mako/host/contracts/file-events-service"
import { Action } from "@/components/ui/kit"
import { IfCanReveal } from "@/components/ui/machine-gate"
import { desktop } from "@/state/desktop"
import { fileEvents } from "@/state/file-events"
import { degradedText, lagText, restartedText, spanText } from "@/lib/file-events-text"
import { formatBytes, formatTime } from "@/lib/format"

/** The latest samples listed; the rest are in the copied readings. */
const LISTED = 6

/**
 * macOS's file-change service as Mako measures it, for Settings ›
 * Diagnostics: how late its canary's beats arrive and what fseventsd holds,
 * the samples of the last day with what Mako was doing then, and the last
 * restart with its evidence.
 */
export function FileEventsReadout({ service }: { service: FileEventsService }) {
  const degraded = service.state === "degraded"
  return (
    <div data-file-events-readout={service.state} className="mt-2 bg-raised">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-ui">macOS file-change service</p>
          <p className="text-label leading-relaxed text-faint">
            fseventsd delivers file changes to every app that watches folders. Mako times a change to a file of its own every 10 seconds, and reads the service's memory every minute.
          </p>
        </div>
        <Action tone="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(service, null, 2))}>
          Copy the readings
        </Action>
      </div>
      <div className="">
        <div className="flex items-baseline gap-2 px-3 py-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-ui">Now</p>
            <p className={`text-label leading-relaxed ${degraded ? "text-caution" : "text-faint"}`}>{nowText(service)}</p>
          </div>
          {degraded && !service.restarting ? <Action tone="outline" onClick={() => void fileEvents.restart()}>Restart it</Action> : null}
          {service.restarting ? <span className="shrink-0 text-label text-faint">Restarting…</span> : null}
        </div>
        <div className="px-3 py-2">
          <p className="truncate text-ui">Last 24 hours</p>
          <p className="text-label leading-relaxed text-faint">{historyText(service.history)}</p>
          {service.history.length ? (
            <div className="mt-1 flex flex-col">
              {service.history.slice(-LISTED).reverse().map((sample) => (
                <div key={`${sample.at}-${sample.why ?? ""}`} className="flex items-baseline gap-3 py-0.5 text-label">
                  <span className="tabular w-14 shrink-0 text-faint">{formatTime(sample.at)}</span>
                  <span className={`min-w-0 flex-1 truncate ${sample.state === "degraded" ? "text-caution" : "text-muted-foreground"}`}>{sampleText(sample)}</span>
                  <span className="min-w-0 shrink truncate text-faint">{contextText(sample)}</span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {service.restart ? (
          <div className="flex items-baseline gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="truncate text-ui">Last restart</p>
              <p className="text-label leading-relaxed text-faint">{lastRestartText(service)}</p>
            </div>
            {service.restart.evidence ? (
              <IfCanReveal>
                <Action tone="ghost" onClick={() => void desktop.revealPath(service.restart!.evidence!)}>Show the evidence</Action>
              </IfCanReveal>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function nowText(service: FileEventsService): string {
  const snoozed = service.snoozedUntil ? ` "Not now" holds until ${formatTime(service.snoozedUntil)} unless it gets twice as bad.` : ""
  if (service.state === "degraded") return `Degraded for ${spanText(Date.now() - service.degraded!.since)}. ${degradedText(service)} Restarting it fixes this; macOS asks for your password.${snoozed}`
  const memory = service.residentBytes !== undefined ? `fseventsd${service.pid ? ` (pid ${service.pid})` : ""} holds ${formatBytes(service.residentBytes)}.` : ""
  const held = [
    service.settlingUntil ? `Just restarted, so only its memory is judged until ${formatTime(service.settlingUntil)}.` : "",
    service.busy ? "This Mac is busy with other work, so a late file change isn't held against it." : "",
  ].filter(Boolean).join(" ")
  return `${healthyText(service, memory)} ${held}`.trim()
}

function healthyText(service: FileEventsService, memory: string): string {
  if (service.lagMs === undefined) return `${service.state === "healthy" ? "Healthy. " : ""}Delivery isn't measured yet: Mako times it while it watches a folder. ${memory}`.trim()
  return `Healthy. File changes arrive in ${lagText(service.lagMs)} at the median of the last ${Math.min(service.beats, LAG_BEATS)} checks (slowest ${lagText(service.slowestMs ?? service.lagMs)}). ${memory}`.trim()
}

function historyText(samples: readonly FileEventsSample[]): string {
  if (!samples.length) return "No samples yet: Mako keeps one every 15 minutes, and one whenever the service's state changes."
  const memory = samples.flatMap((sample) => (sample.residentBytes !== undefined ? [sample.residentBytes] : []))
  const lags = samples.flatMap((sample) => (sample.lagMs !== undefined ? [sample.lagMs] : []))
  const restarts = samples.filter((sample) => sample.why === "restarted").length
  return [
    `${samples.length} ${samples.length === 1 ? "sample" : "samples"}`,
    memory.length ? `memory ${range(memory, formatBytes)}` : undefined,
    lags.length ? `median delay ${range(lags, lagText)}` : undefined,
    restarts ? `${restarts === 1 ? "one restart" : `${restarts} restarts`}` : undefined,
  ].filter(Boolean).join(", ") + "."
}

function range(values: readonly number[], format: (value: number) => string): string {
  const low = Math.min(...values)
  const high = Math.max(...values)
  return low === high ? format(low) : `${format(low)} to ${format(high)}`
}

function sampleText(sample: FileEventsSample): string {
  const parts = [
    sample.residentBytes !== undefined ? formatBytes(sample.residentBytes) : undefined,
    sample.lagMs !== undefined ? `events in ${lagText(sample.lagMs)}` : undefined,
  ].filter(Boolean)
  const why = sample.why === "restarted" ? "restarted" : sample.why === "state" ? sample.state : undefined
  return [why, parts.join(", ") || "not measured"].filter(Boolean).join(": ")
}

function contextText(sample: FileEventsSample): string {
  const context = sample.context
  if (!context) return ""
  return [
    context.turnsRunning ? `${context.turnsRunning} ${context.turnsRunning === 1 ? "turn" : "turns"} running` : undefined,
    context.historyReads ? `${context.historyReads} history ${context.historyReads === 1 ? "read" : "reads"}` : undefined,
    context.childStarts ? `${context.childStarts} watcher ${context.childStarts === 1 ? "start" : "starts"}` : undefined,
    context.wakes ? `${context.wakes === 1 ? "woke" : `woke ${context.wakes} times`}` : undefined,
  ].filter(Boolean).join(" · ")
}

function lastRestartText(service: FileEventsService): string {
  const restart = service.restart!
  const when = `${spanText(Date.now() - restart.at)} ago`
  if (restart.outcome === "cancelled") return `Cancelled at the password dialog ${when}.`
  if (restart.outcome === "failed") return `Failed ${when}: ${restart.message ?? "macOS gave no reason"}.`
  const kept = restart.historyKept === undefined ? "" : restart.historyKept
    ? " A change written just before it was still in the history after."
    : " A change written just before it was missing from the history after, so reads across a restart are reported incomplete."
  return `Restarted ${when}. ${restartedText(restart)}${kept}`
}
