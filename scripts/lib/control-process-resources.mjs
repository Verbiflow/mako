// Acceptance instrumentation only. No command arguments or environment values
// are collected. RSS is a sum of process resident sets, not unique physical RAM.
import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execute = promisify(execFile)

export async function processResources(roots) {
  const { stdout } = await execute(
    "ps",
    ["-axo", "pid=,ppid=,time=,rss=,comm="],
    {
      maxBuffer: 4 * 1024 * 1024,
      timeout: 3000,
    }
  )
  const rows = stdout
    .trim()
    .split("\n")
    .map((line) => {
      const match = line
        .trim()
        .match(/^(\d+)\s+(\d+)\s+([\d:.-]+)\s+(\d+)\s+(.+)$/)
      if (!match) throw new Error("Unrecognized process accounting row")
      const [, pid, parent, time, rss, executable] = match
      const [days, clock] = time.includes("-") ? time.split("-") : ["0", time]
      const seconds = clock
        .split(":")
        .reduce((sum, value) => sum * 60 + Number(value), 0)
      return {
        pid: Number(pid),
        parent: Number(parent),
        cpuSeconds: Number(days) * 86400 + seconds,
        rssBytes: Number(rss) * 1024,
        executable,
      }
    })
  return Object.fromEntries(
    Object.entries(roots).map(([name, root]) => {
      const selected = new Set([root])
      for (;;) {
        const count = selected.size
        for (const row of rows)
          if (selected.has(row.parent)) selected.add(row.pid)
        if (selected.size === count) break
      }
      return [
        name,
        rows
          .filter((row) => selected.has(row.pid))
          .map(({ parent: _parent, ...row }) => row),
      ]
    })
  )
}

export function summarizeProcessResources(samples, elapsedMs) {
  const summary = {}
  for (const name of Object.keys(samples[0] ?? {})) {
    const first = new Map(
      samples[0][name].map((row) => [row.pid, row.cpuSeconds])
    )
    const latest = new Map()
    let peakRssBytes = 0
    for (const sample of samples) {
      peakRssBytes = Math.max(
        peakRssBytes,
        sample[name].reduce((sum, row) => sum + row.rssBytes, 0)
      )
      for (const row of sample[name]) latest.set(row.pid, row.cpuSeconds)
    }
    const cpuSeconds = [...latest].reduce(
      (sum, [pid, cpu]) => sum + Math.max(0, cpu - (first.get(pid) ?? 0)),
      0
    )
    summary[name] = {
      cpuSeconds,
      cpuCoreEquivalent: (cpuSeconds * 1000) / elapsedMs,
      peakRssBytes,
      processesObserved: latest.size,
    }
  }
  return summary
}
