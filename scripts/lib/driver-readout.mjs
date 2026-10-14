import { execFileSync } from "node:child_process"

/**
 * The driver broker's readout (`DriverBroker.status`, `mako:computer-driver-
 * connections`) as lines a person reads: the daemon, who holds a lease and
 * what each is doing, the last calls, and every process on the driver's side
 * of the host with its memory. Shared by `npm run control:driver` and the
 * live tests, which print the same readout.
 */

const seconds = (ms) => (ms < 1000 ? `${ms} ms` : ms < 120_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`)
const size = (bytes) => (bytes === undefined ? "" : bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`)
const pad = (text, width) => String(text ?? "").padEnd(width)

/** Every process, by pid: its parent, resident memory and command. */
function processTable() {
  const rows = new Map()
  for (const line of execFileSync("/bin/ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" }).trim().split("\n")) {
    const [pid, ppid, rss, ...command] = line.trim().split(/\s+/)
    rows.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), rssKb: Number(rss), command: command.join(" ") })
  }
  return rows
}

/** The host's own processes on the driver's side: the daemon, the workers and any `cua-driver mcp` left under it. */
export function driverProcesses(status, table = processTable()) {
  const under = (pid, ancestor) => {
    for (let at = table.get(pid); at; at = table.get(at.ppid)) if (at.ppid === ancestor) return true
    return false
  }
  const describe = (role, pid) => {
    const row = table.get(pid)
    return row ? { role, pid, rssMB: Math.round(row.rssKb / 1024) } : { role, pid, gone: true }
  }
  const rows = [describe("host", status.host)]
  if (status.daemon.pid) rows.push(describe("daemon", status.daemon.pid))
  for (const [binding, pid] of Object.entries(status.workers.bindings)) if (pid) rows.push(describe(`worker ${binding}`, pid))
  if (status.workers.spare) rows.push(describe("worker (spare)", status.workers.spare))
  for (const row of table.values())
    if (/cua-driver(\s|$).*\bmcp\b/.test(row.command) && under(row.pid, status.host)) rows.push(describe("cua-driver mcp", row.pid))
  return rows
}

export function driverReadout(status, options = {}) {
  const lines = []
  const daemon = status.daemon
  lines.push(`Mako's driver broker · host ${status.host}`)
  lines.push(
    daemon.state === "connected"
      ? `daemon     connected · generation ${daemon.generation} · cua-driver ${daemon.version}${daemon.pid ? ` · pid ${daemon.pid}` : ""} · up ${seconds(daemon.connectedForMs)} · connected in ${daemon.connectMs} ms · ${daemon.tools} tools`
      : `daemon     ${daemon.state}`
  )
  if (daemon.state === "connected")
    lines.push(
      daemon.snapshots === "lease"
        ? `snapshots  each lease's own (daemon contract ${daemon.contract})`
        : `snapshots  one per window for everyone: this driver predates per-lease snapshots, so the broker tracks whose read replaced whose (daemon contract ${daemon.contract})`
    )
  lines.push(`warm-up    ${status.warm.state}${status.warm.ms !== undefined ? ` (first picture ${status.warm.ms} ms)` : ""} · reconnects ${status.reconnects}`)
  lines.push(`workers    ${status.endpoint ?? "no task granted yet"}`)
  lines.push(`consumers  ${status.consumers.length}`)
  for (const consumer of status.consumers)
    lines.push(
      `  ${pad(consumer.consumer, 28)} ${pad(consumer.mode, 8)} ${pad(`${consumer.calls} calls`, 10)} ${pad(`${consumer.errors} failed`, 9)} ${pad(`${consumer.queued} queued`, 9)} ${pad(`${consumer.inFlight} running`, 10)} ${pad(`${consumer.superseded} superseded`, 13)}` +
        (consumer.last ? ` last ${consumer.last.tool} ${consumer.last.ms ?? "…"} ms ${consumer.last.outcome ?? ""}, ${seconds(consumer.last.agoMs)} ago` : "")
    )
  lines.push(`in flight  ${status.inFlight.length}`)
  for (const call of status.inFlight)
    lines.push(`  ${pad(call.consumer, 28)} ${pad(call.tool, 26)} ${pad(call.window, 16)} ${seconds(call.runningMs)}${call.abandoned ? " (its caller stopped waiting)" : ""}`)
  const recent = status.recent.slice(-(options.recent ?? 12))
  lines.push(`recent     last ${recent.length} of ${status.totals.calls} calls · ${status.totals.errors} failed · ${size(status.totals.bytes)} · ${status.totals.superseded} snapshots superseded · ${status.totals.leases} leases`)
  for (const call of recent)
    lines.push(
      `  ${call.at.slice(11, 23)} ${pad(call.consumer, 28)} ${pad(call.tool, 26)} ${pad(call.window, 16)} ${pad(call.queuedMs ? `+${call.queuedMs} queued` : "", 12)} ${pad(call.ms === undefined ? "…" : `${call.ms} ms`, 9)} ${pad(size(call.bytes), 8)} ${call.outcome ?? ""}${call.abandoned ? " abandoned" : ""}`
    )
  if (status.workers) {
    const processes = driverProcesses(status, options.table)
    const proxies = processes.filter((row) => row.role === "cua-driver mcp").length
    lines.push(`processes  ${processes.length} · ${processes.reduce((total, row) => total + (row.rssMB ?? 0), 0)} MB resident · ${proxies} cua-driver mcp`)
    for (const row of processes) lines.push(`  ${pad(row.role, 28)} ${pad(row.pid, 8)} ${row.gone ? "gone" : `${row.rssMB} MB`}`)
  }
  return lines.join("\n")
}
