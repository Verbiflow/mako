import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)

/**
 * A host's processes as the platform lists them: itself and everything under it, each with its command line and, when
 * asked, the memory that is its own. On a Mac that is `footprint`'s figure (what Activity Monitor shows), on Linux its
 * PSS, on Windows its private working set: a resident size counts the pages a child shares with the Node that started
 * it once a process. Windows has no `ps`: the table is CIM's, asked through Windows PowerShell by its whole path, as
 * a bare name is looked for in the working folder first.
 */

/** Every process: `{ pid, ppid, command }`. */
async function table() {
  if (process.platform === "win32") {
    const { stdout } = await run(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command",
      "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine | ForEach-Object { [pscustomobject]@{ pid = $_.ProcessId; ppid = $_.ParentProcessId; command = if ($_.CommandLine) { $_.CommandLine } else { $_.Name } } } | ConvertTo-Json -Compress",
    ], { maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    const rows = JSON.parse(stdout || "[]")
    return Array.isArray(rows) ? rows : [rows]
  }
  const { stdout } = await run("ps", ["-Ao", "pid=,ppid=,args="], { maxBuffer: 64 * 1024 * 1024 })
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] }] : []
  })
}

function windowsPowerShell() {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
}

/** Megabytes of memory that are `pids`' own, by pid; none for a process gone meanwhile or one that can't be read. */
async function memory(pids) {
  const megabytes = new Map()
  if (process.platform === "win32") {
    const { stdout } = await run(windowsPowerShell(), ["-NoProfile", "-NonInteractive", "-Command",
      `Get-CimInstance Win32_PerfRawData_PerfProc_Process -Property IDProcess,WorkingSetPrivate | Where-Object { @(${pids.join(",")}) -contains $_.IDProcess } | ForEach-Object { [pscustomobject]@{ pid = $_.IDProcess; bytes = $_.WorkingSetPrivate } } | ConvertTo-Json -Compress`,
    ], { maxBuffer: 16 * 1024 * 1024, windowsHide: true })
    const rows = JSON.parse(stdout || "[]")
    for (const row of Array.isArray(rows) ? rows : [rows]) megabytes.set(row.pid, row.bytes / 1024 / 1024)
    return megabytes
  }
  await Promise.all(pids.map(async (pid) => {
    if (process.platform === "darwin") {
      const said = await run("footprint", ["-p", String(pid)]).then(({ stdout }) => stdout, () => "")
      const found = /Footprint: ([\d.]+) (KB|MB|GB)/.exec(said)
      if (found) megabytes.set(pid, Number(found[1]) * { KB: 1 / 1024, MB: 1, GB: 1024 }[found[2]])
      return
    }
    const rollup = await readFile(`/proc/${pid}/smaps_rollup`, "utf8").catch(() => "")
    const pss = /^Pss:\s+(\d+) kB/m.exec(rollup)
    if (pss) megabytes.set(pid, Number(pss[1]) / 1024)
  }))
  return megabytes
}

/**
 * The host `pid` and every process under it, parents before children: `{ pid, ppid, command, depth }`, with `mb` when
 * `measured`. A process this listing itself started (PowerShell, `ps`) isn't the host's.
 */
export async function hostProcesses(pid, { measured = false } = {}) {
  const rows = (await table()).filter((row) => row.ppid !== process.pid || row.pid === pid)
  const found = []
  const under = (parent, depth) => {
    for (const row of rows) {
      if (row.ppid !== parent || row.pid === parent || found.some((one) => one.pid === row.pid)) continue
      found.push({ ...row, depth })
      under(row.pid, depth + 1)
    }
  }
  const host = rows.find((row) => row.pid === pid)
  if (host) found.push({ ...host, depth: 0 })
  under(pid, 1)
  if (!measured) return found
  const megabytes = await memory(found.map((row) => row.pid))
  return found.map((row) => ({ ...row, mb: megabytes.get(row.pid) }))
}

/**
 * What one of the host's own helper processes is, from its command line: the Git helper, or a watcher child by what
 * it was started for (`watch`, `probes`, `history`, `checkpoints`, `delivery`). Undefined for anything else.
 */
export function helperName(command) {
  if (/git-helper-main\.(js|ts)/.test(command)) return "git helper"
  const watcher = /watcher-child-main\.(?:js|ts)"?(?: "?([a-z]+))?/.exec(command)
  if (watcher) return `watcher child${watcher[1] ? ` (${watcher[1]})` : ""}`
  return undefined
}
