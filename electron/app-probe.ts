import { execFile } from "node:child_process"
import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join, relative, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

const run = promisify(execFile)

const LSOF_BYTES = 16 * 1024 * 1024
/** Each list in a report stops here; a longer one says how many it left out. */
const REPORT_LIMIT = 40

/**
 * Folders, under home, where apps keep state outside their checkout. One
 * level down names an app's folder; a write two levels down marks it.
 */
const WATCHED = [
  "Library/Application Support",
  "Library/Caches",
  "Library/Preferences",
  "Library/Logs",
  "Library/LaunchAgents",
  "Library/Containers",
  ".config",
  ".cache",
  ".local/share",
  ".local/state",
]

export interface Sockets {
  /** TCP ports the processes listen on. */
  listening: { port: number; pid: number }[]
  /** TCP connections they opened, to a port on this Mac or elsewhere. */
  connected: { host: string; port: number; local: boolean; pid: number }[]
}

/** What `pids` listen on and connect to, from one `lsof`. */
export async function socketsOf(pids: number[]): Promise<Sockets> {
  const found: Sockets = { listening: [], connected: [] }
  if (!pids.length) return found
  let pid = 0
  for (const line of (await lsof(["-a", "-p", pids.join(","), "-iTCP", "-FpnT"])).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n")) {
      const [from, to] = line.slice(1).split("->")
      if (to) {
        const remote = address(to)
        if (remote) found.connected.push({ ...remote, local: loopback(remote.host), pid })
      } else {
        const own = address(from!)
        if (own && !found.listening.some((entry) => entry.port === own.port && entry.pid === pid)) found.listening.push({ port: own.port, pid })
      }
    }
  }
  return found
}

/**
 * Regular files `pids` hold open for writing outside `inside`, such as a
 * database or a lock file another copy of the app would share.
 */
export async function writingOf(pids: number[], inside: string[]): Promise<{ path: string; pid: number }[]> {
  if (!pids.length) return []
  const roots = await Promise.all(inside.map(resolved))
  const found: { path: string; pid: number }[] = []
  let pid = 0
  let access = ""
  let type = ""
  for (const line of (await lsof(["-a", "-p", pids.join(","), "-FpatnN"])).split("\n")) {
    const field = line[0]
    const value = line.slice(1)
    if (field === "p") pid = Number(value)
    else if (field === "f") access = type = ""
    else if (field === "a") access = value
    else if (field === "t") type = value
    else if (field === "n" && type === "REG" && (access === "w" || access === "u") && isAbsolute(value)) {
      if (value.startsWith("/dev/") || roots.some((root) => within(value, root))) continue
      if (!found.some((entry) => entry.path === value)) found.push({ path: value, pid })
    }
  }
  return found
}

/**
 * Folders apps keep state in, under home and in /tmp, with something in
 * them changed since `since`; any process may have changed them, not only
 * the app. Leaves out `skip` and everything in it.
 */
export async function changedSince(since: number, skip: string[], home = homedir()): Promise<string[]> {
  const roots = await Promise.all(skip.map(resolved))
  const kept = (path: string) => !roots.some((root) => within(path, root) || within(root, path))
  const changed: string[] = []
  const newer = async (path: string) => ((await stat(path).catch(() => undefined))?.mtimeMs ?? 0) >= since
  for (const folder of WATCHED.map((name) => join(home, name))) {
    for (const name of await names(folder)) {
      const path = join(folder, name)
      if (!kept(path)) continue
      if (await newer(path)) changed.push(path)
      else if ((await stat(path).catch(() => undefined))?.isDirectory()) {
        for (const inner of await names(path))
          if (await newer(join(path, inner))) {
            changed.push(path)
            break
          }
      }
    }
  }
  for (const folder of [home, await resolved("/tmp")]) {
    for (const name of await names(folder)) {
      const path = join(folder, name)
      if (folder === home && name === "Library") continue
      if (kept(path) && (await newer(path))) changed.push(path)
    }
  }
  return changed
}

/** The first port the system hands out for port 0; one from there up was picked for the app and can't collide. */
export async function systemPortsFrom(): Promise<number> {
  if (process.platform === "darwin") {
    const first = await run("sysctl", ["-n", "net.inet.ip.portrange.first"]).then(({ stdout }) => Number(stdout.trim()), () => Number.NaN)
    return Number.isInteger(first) && first > 0 ? first : 49_152
  }
  const range = await readFile("/proc/sys/net/ipv4/ip_local_port_range", "utf8").catch(() => "")
  const first = Number(range.trim().split(/\s+/)[0])
  return Number.isInteger(first) && first > 0 ? first : 32_768
}

/** Where each of `pids` works, from one `lsof`; a pid that has ended is left out. */
export async function workingDirectories(pids: number[]): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  if (!pids.length) return found
  let pid = 0
  for (const line of (await lsof(["-a", "-p", pids.join(","), "-d", "cwd", "-Fpn"])).split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n")) found.set(pid, line.slice(1))
  }
  return found
}

/** Whether `path` is `root` or in it. */
export function inside(path: string | undefined, root: string): boolean {
  return path !== undefined && within(path, root)
}

/** At most `REPORT_LIMIT` entries, saying how many were left out. */
export function capped<T>(entries: T[]): { entries: T[]; more?: number } {
  return entries.length > REPORT_LIMIT ? { entries: entries.slice(0, REPORT_LIMIT), more: entries.length - REPORT_LIMIT } : { entries }
}

async function lsof(args: string[]): Promise<string> {
  try {
    const { stdout } = await run("lsof", ["-nP", "-w", ...args], {
      env: { ...process.env, LC_ALL: "C", PATH: `${process.env.PATH ?? ""}:/usr/sbin:/usr/bin:/sbin:/bin` },
      maxBuffer: LSOF_BYTES,
    })
    return stdout
  } catch (error) {
    // lsof exits 1 when nothing matches, or when some pid has just ended; what it printed still holds.
    const failed = z.object({ code: z.literal(1), stdout: z.string() }).safeParse(error)
    if (failed.success) return failed.data.stdout
    throw error
  }
}

function address(text: string): { host: string; port: number } | undefined {
  const match = /^(.*):(\d+)$/.exec(text)
  if (!match) return undefined
  return { host: match[1]!.replace(/^\[(.*)\]$/, "$1"), port: Number(match[2]) }
}

function loopback(host: string): boolean {
  return host === "::1" || host === "localhost" || host.startsWith("127.") || host === "::ffff:127.0.0.1"
}

function within(path: string, root: string): boolean {
  const inner = relative(root, path)
  return inner === "" || (!inner.startsWith("..") && !isAbsolute(inner) && !inner.startsWith(sep))
}

async function resolved(path: string): Promise<string> {
  return realpath(path).catch(() => path)
}

async function names(folder: string): Promise<string[]> {
  return readdir(folder).catch(() => [])
}
