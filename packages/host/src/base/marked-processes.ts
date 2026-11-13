import { hostProbe } from "./host-command.js"
import { readdir, readFile, readlink } from "node:fs/promises"
import { onLinux, onMac } from "./platform.js"


/** A process whose environment names a value, as `markedProcesses` finds it. */
export interface MarkedProcess {
  pid: number
  value: string
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * This user's processes whose environment sets `variable`, with its value: on
 * macOS from `ps -E`, which shows the environment of a process its user owns
 * and no other's, and on Linux from `/proc/<pid>/environ`, readable the same
 * way. Elsewhere none.
 */
export async function markedProcesses(variable: string, signal: AbortSignal): Promise<MarkedProcess[]> {
  if (!NAME.test(variable)) throw new Error(`${variable} is not an environment variable's name`)
  if (onMac()) {
    const { stdout } = await hostProbe("ps", ["-x", "-E", "-ww", "-o", "pid=,command="], { maxBuffer: 64 * 1024 * 1024, timeout: 5_000, signal })
    const marked = new RegExp(`(?:^|\\s)${variable}=(\\S+)`)
    const found: MarkedProcess[] = []
    for (const line of stdout.split("\n")) {
      if (!line.includes(variable)) continue
      const pid = Number(/^\s*(\d+)/.exec(line)?.[1])
      const value = marked.exec(line)?.[1]
      if (Number.isSafeInteger(pid) && value) found.push({ pid, value })
    }
    return found
  }
  if (!onLinux()) return []
  const prefix = `${variable}=`
  const found: MarkedProcess[] = []
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue
    const environ = await readFile(`/proc/${name}/environ`, { encoding: "utf8", signal }).catch(() => "")
    const value = environ.split("\0").find((entry) => entry.startsWith(prefix))?.slice(prefix.length)
    if (value) found.push({ pid: Number(name), value })
  }
  return found
}

/** Each process's working folder, for those it can be read of. */
export async function processFolders(pids: readonly number[], signal: AbortSignal): Promise<Map<number, string>> {
  const folders = new Map<number, string>()
  if (!pids.length) return folders
  if (onLinux()) {
    for (const pid of pids) {
      const folder = await readlink(`/proc/${pid}/cwd`).catch(() => undefined)
      if (folder) folders.set(pid, folder)
    }
    return folders
  }
  if (!onMac()) return folders
  const { stdout } = await hostProbe("/usr/sbin/lsof", ["-nP", "-a", "-d", "cwd", "-Fpn", "-p", pids.join(",")], { maxBuffer: 1024 * 1024, timeout: 3_000, signal })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }))
  let pid: number | undefined
  for (const line of stdout.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) folders.set(pid, line.slice(1))
  }
  return folders
}

/** The processes holding `file` open, among `pids`. */
export async function processesHolding(file: string, pids: readonly number[], signal: AbortSignal): Promise<Set<number>> {
  const holding = new Set<number>()
  if (!pids.length || !(onMac() || onLinux())) return holding
  const { stdout } = await hostProbe("lsof", ["-nP", "-a", "-Fp", "-p", pids.join(","), "--", file], { maxBuffer: 1024 * 1024, timeout: 3_000, signal })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "" }))
  for (const line of stdout.split("\n")) if (line.startsWith("p")) holding.add(Number(line.slice(1)))
  return holding
}
