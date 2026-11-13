import type { MakoFootprint, RescanFootprint, WatchFootprint } from "@mako/host/contracts/mako-footprint"
import { CALM_POLL_MS, SLOW_DELIVERY_MS } from "@mako/host/contracts/watcher-child"
import { Action } from "@/components/ui/kit"
import { formatBytes } from "@/lib/format"

const DROPPED_BY = [["client", "by Mako's watcher"], ["kernel", "by macOS"], ["coalesced", "as too many at once"], ["unsaid", "without a reason"]] as const

/**
 * What Mako itself costs this Mac now, for whoever wonders whether it's Mako
 * keeping the fans on: its own processes apart from the agents it started,
 * what it asks macOS to watch and how macOS keeps up, and the checks it
 * makes when file events go missing.
 */
export function FootprintReadout({ footprint }: { footprint: MakoFootprint }) {
  const { watching, rescans } = footprint
  return (
    <div data-footprint-readout="" className="mt-2 bg-raised">
      <div className="flex items-start gap-2 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="text-ui">Mako's footprint</p>
          <p className="text-label leading-relaxed text-faint">
            What Mako's own processes and file watching cost this Mac now. CPU is a recent average, as Activity Monitor shows it.
          </p>
        </div>
        <Action tone="ghost" onClick={() => void navigator.clipboard.writeText(JSON.stringify(footprint, null, 2))}>
          Copy the readings
        </Action>
      </div>
      <div className="">
        {footprint.attributionFailure !== undefined ? <Line title="File attribution" detail={`Unavailable; Mako is retrying. ${footprint.attributionFailure}`} caution /> : null}
        <Line title="Processes" detail={describeProcesses(footprint)} />
        <Line title="File watching" detail={describeWatching(watching)} caution={!watching.delivery.ok} />
        <Line title="Dropped file events" detail={describeDrops(watching)} />
        {rescans ? <RescanLine rescans={rescans} /> : null}
        <Line title="File history reads" detail={describeHistory(watching)} />
      </div>
    </div>
  )
}

function RescanLine({ rescans }: { rescans: RescanFootprint }) {
  const backedOff = rescans.backedOff.length > 0
  return (
    <div className="flex items-baseline gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui">Rescans</p>
        {backedOff ? <p className="text-label leading-relaxed text-caution">macOS is dropping file events; Mako is checking less often</p> : null}
        <p className="text-label leading-relaxed text-faint">{describeRescans(rescans)}</p>
        {backedOff ? (
          <p className="text-label leading-relaxed text-faint">
            {rescans.backedOff.slice(0, 4).map((root) => `${root.root.split("/").at(-1)} every ${minutes(root.everyMs)}`).join(" · ")}
            {rescans.backedOff.length > 4 ? ` · ${rescans.backedOff.length - 4} more` : ""}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function describeProcesses({ processes, agents }: MakoFootprint): string {
  const cpu = processes.reduce((sum, process) => sum + process.cpuPercent, 0)
  const memory = processes.reduce((sum, process) => sum + process.residentBytes, 0)
  const busiest = [...processes].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 3).filter((process) => process.cpuPercent >= 0.5)
  const own = `${count(processes.length, "process", "processes")} of Mako's own use ${percent(cpu)} CPU and ${formatBytes(memory)} of memory`
  const most = busiest.length ? ` (${busiest.map((process) => `${process.role} ${percent(process.cpuPercent)}`).join(", ")})` : ""
  const started = agents.count
    ? `. The agents it started and what they ran, ${count(agents.count, "process", "processes")}, use ${percent(agents.cpuPercent)} and ${formatBytes(agents.residentBytes)}.`
    : ". No agent is running."
  return `${own}${most}${started}`
}

function describeWatching(watching: WatchFootprint): string {
  const folders = `${count(watching.roots.length, "folder", "folders")} in ${count(watching.streams, "macOS file-event stream", "macOS file-event streams")}`
  const restarts = watching.starts.crash + watching.starts.silence
  const child = restarts ? `; the watcher restarted ${count(restarts, "time", "times")} since Mako started (${watching.starts.silence} for silence)` : ""
  if (!watching.delivery.ok) return `${folders}${child}. macOS hasn't delivered file events for ${minutes(Date.now() - watching.delivery.since)}, so Mako asks Git what changed instead.`
  const lag = watching.delivery.lagMs
  const calm = lag !== undefined && lag > SLOW_DELIVERY_MS ? `, so Mako also looks for changes in each folder every ${seconds(CALM_POLL_MS)}` : ""
  const timing = lag !== undefined && lag > 2_000 ? `Events arrive up to ${seconds(lag)} late${calm}.` : "Events arrive on time."
  return `${folders}${child}. ${timing} ${count(watching.eventsLastHour, "change", "changes")} heard in the last hour.`
}

function describeDrops(watching: WatchFootprint): string {
  if (!watching.droppedLastHour) return "None in the last hour."
  const by = DROPPED_BY.flatMap(([reason, words]) => (watching.droppedBy[reason] ? [`${watching.droppedBy[reason]} ${words}`] : [])).join(", ")
  return `${count(watching.droppedLastHour, "time", "times")} in the last hour: ${by}. Each costs the folder a rescan.`
}

function describeRescans(rescans: RescanFootprint): string {
  if (!rescans.lastHour) return `None of the ${count(rescans.roots, "folder", "folders")} Mako tracks needed one in the last hour.`
  return `${count(rescans.lastHour, "rescan", "rescans")} in the last hour, after ${count(rescans.lossesLastHour, "loss", "losses")} of file events: ${rescans.filesLastHour.toLocaleString()} files checked in ${seconds(rescans.msLastHour)}.`
}

function describeHistory(watching: WatchFootprint): string {
  const { history } = watching
  if (!history.readsLastHour) return "None in the last hour."
  const slowest = history.slowestMs !== undefined ? `; the slowest took ${seconds(history.slowestMs)}` : ""
  return `${count(history.readsLastHour, "read", "reads")} in the last hour, ${history.pathsLastHour.toLocaleString()} paths${slowest}. Mako reads what changed while a turn ran, for the turn's footprint.`
}

function count(value: number, one: string, many: string): string {
  return `${value.toLocaleString()} ${value === 1 ? one : many}`
}

function percent(value: number): string {
  return `${value < 10 ? value.toFixed(1) : Math.round(value)}%`
}

function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`
}

function minutes(ms: number): string {
  return ms < 120_000 ? seconds(ms) : `${Math.round(ms / 60_000)} min`
}

function Line({ title, detail, caution }: { title: string; detail: string; caution?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui">{title}</p>
        <p className={`text-label leading-relaxed ${caution ? "text-caution" : "text-faint"}`}>{detail}</p>
      </div>
    </div>
  )
}
