import { continueTimings, describeContinue, type ContinueReading } from "@mako/host/contracts/cloud-continues"
import { Action } from "@/components/ui/kit"
import { formatTime } from "@/lib/format"

const PHASE = {
  asking: "Asking",
  making: "Making",
  arriving: "Arriving",
  continued: "Continued",
  failed: "Failed",
} satisfies Record<ContinueReading["phase"], string>

/**
 * Each Continue in the cloud this Mac pressed, or its account's list says another device did, the latest first: where
 * it stands, the cloud Thread and machine it went to, how long each phase took as this Mac heard it, and the last asks
 * with the correlation IDs the account's log is read by. Copying one copies all of it, in the line every device writes.
 */
export function ContinueReadout({ readings }: { readings: readonly ContinueReading[] }) {
  if (!readings.length) return null
  return (
    <div data-continue-readout="" className="mt-2 bg-raised">
      <div className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0">
          <p className="text-ui">Continue in the cloud</p>
          <p className="text-label text-faint">Threads carried to a cloud machine while their Mac was off.</p>
        </div>
        <Action tone="ghost" onClick={() => void navigator.clipboard.writeText(readings.map(describeContinue).join("\n"))}>
          Copy
        </Action>
      </div>
      <div className="">
        {readings.slice(0, 5).map((reading) => (
          <ContinueLine key={reading.op} reading={reading} />
        ))}
      </div>
    </div>
  )
}

function ContinueLine({ reading }: { reading: ContinueReading }) {
  const last = reading.asks.at(-1)
  const timings = continueTimings(reading)
  const pressedAt = reading.heard.asking ?? (reading.at ? Date.parse(reading.at) : undefined)
  return (
    <div data-continue-line={reading.phase} className="flex flex-col gap-0.5 px-3 py-1.5">
      <span className="flex min-w-0 items-baseline gap-3">
        <span className="min-w-0 flex-1 truncate text-label">
          {PHASE[reading.phase]}
          {reading.title ? `, ${reading.title}` : null}
          {reading.here ? null : <span className="text-faint"> · pressed on another device</span>}
        </span>
        {pressedAt !== undefined ? <span className="tabular shrink-0 text-label text-faint">{formatTime(pressedAt)}</span> : null}
      </span>
      <span className="break-all font-mono text-label text-faint">
        op {reading.op}
        {reading.cloudThread ? ` · ${reading.cloudThread}` : ""}
        {reading.machine ? ` on ${reading.machine}` : ""}
      </span>
      {timings.length || last ? (
        <span className="break-all text-label text-faint">
          {timings.map(([phase, ms]) => `${PHASE[phase].toLowerCase()} ${(ms / 1000).toFixed(1)} s`).join(" · ")}
          {last ? `${timings.length ? " · " : ""}last ask ${last.method} ${last.outcome}, ${last.ms} ms · ${last.correlationId}` : null}
        </span>
      ) : null}
      {reading.reason ? <span className="text-label text-caution">{reading.reason}</span> : null}
    </div>
  )
}
