import { hostProbe } from "../base/host-command.js"
import type { MakoFootprint, MakoProcess, RescanFootprint, WatchFootprint } from "../contracts/mako-footprint.js"
import type { MethodTable } from "../base/methods.js"


export interface ProcessRow {
  pid: number
  ppid: number
  rssKb: number
  cpuPercent: number
  cpuSeconds: number
  command: string
}

/** What Mako's own daemons call themselves (`process.title`). */
const TITLES = new Map([
  ["mako-syncd", "sync daemon"],
  ["mako-sleep-watch", "sleep watch"],
  ["mako-terminal-daemon", "terminals"],
])

/** What Chromium's `--type` names a helper of the app. */
const HELPER_TYPES = new Map([
  ["renderer", "window"],
  ["gpu-process", "graphics"],
  ["utility", "utility"],
])

/** `ps`'s cumulative CPU time, `[[dd-]hh:]mm:ss.cc`, in seconds. */
export function cpuTime(text: string): number {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text]
  const parts = (clock ?? "").split(":").map(Number).reverse()
  const seconds = (parts[0] ?? 0) + (parts[1] ?? 0) * 60 + (parts[2] ?? 0) * 3600 + Number(days) * 86_400
  return Number.isFinite(seconds) ? Math.round(seconds * 10) / 10 : 0
}

export function processRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(.*)$/.exec(line)
    if (!match) continue
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), cpuPercent: Number(match[4]), cpuSeconds: cpuTime(match[5]!), command: match[6]! })
  }
  return rows
}

/**
 * Mako's processes in a process table: the app that runs this host, its
 * helpers, the host and the children it runs for itself (named daemons, the
 * watcher and history children). Everything else under the host is an
 * agent or what an agent ran, counted apart.
 */
export function makoProcesses(
  rows: readonly ProcessRow[], host: { pid: number; ppid: number; inApp: boolean }, own: ReadonlyMap<number, string>,
): Pick<MakoFootprint, "processes" | "agents"> {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const processes: MakoProcess[] = []
  const add = (row: ProcessRow, role: string) =>
    processes.push({ pid: row.pid, role, cpuPercent: row.cpuPercent, cpuSeconds: row.cpuSeconds, residentBytes: row.rssKb * 1024 })
  // A host run on its own (tests, `npm run host`) has a shell above it, not the app.
  const app = host.inApp ? rows.find((row) => row.pid === host.ppid) : undefined
  if (app) {
    add(app, "app")
    for (const helper of children.get(app.pid) ?? []) {
      if (helper.pid === host.pid) continue
      const type = /--type=(\S+)/.exec(helper.command)?.[1]
      const network = type === "utility" && helper.command.includes("NetworkService")
      add(helper, network ? "network" : (type && HELPER_TYPES.get(type)) ?? "helper")
    }
  }
  const self = rows.find((row) => row.pid === host.pid)
  if (self) add(self, "host")
  const agents = { count: 0, cpuPercent: 0, residentBytes: 0 }
  const agent = (row: ProcessRow) => {
    agents.count++
    agents.cpuPercent += row.cpuPercent
    agents.residentBytes += row.rssKb * 1024
    for (const child of children.get(row.pid) ?? []) agent(child)
  }
  for (const child of children.get(host.pid) ?? []) {
    const role = own.get(child.pid) ?? TITLES.get(child.command.split(" ")[0] ?? "")
    if (role) add(child, role)
    else agent(child)
  }
  agents.cpuPercent = Math.round(agents.cpuPercent * 10) / 10
  return { processes, agents }
}

/** Every process on this machine now, from `ps`: unreadable where there's no `ps` (Windows). */
export async function readProcessTable(): Promise<ProcessRow[]> {
  const { stdout } = await hostProbe("ps", ["-axo", "pid=,ppid=,rss=,%cpu=,time=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 5_000,
  })
  return processRows(stdout)
}

/** Mako's footprint on this Mac now: its processes from `ps`, and the file watching and rescans this host reports. */
export async function readMakoFootprint(deps: { watching: WatchFootprint; rescans: RescanFootprint | null; attributionFailure?: string }): Promise<MakoFootprint> {
  const rows = await readProcessTable()
  const own = new Map<number, string>()
  if (deps.watching.child?.pid) own.set(deps.watching.child.pid, "file watcher")
  if (deps.watching.historyChild?.pid) own.set(deps.watching.historyChild.pid, "history reader")
  return {
    at: new Date().toISOString(),
    ...makoProcesses(rows, { pid: process.pid, ppid: process.ppid, inApp: Boolean(process.versions.electron) }, own),
    watching: deps.watching,
    rescans: deps.rescans,
    ...(deps.attributionFailure !== undefined && { attributionFailure: deps.attributionFailure }),
  }
}

export function declareFootprintMethods(methods: MethodTable, read: () => { watching: WatchFootprint; rescans: RescanFootprint | null; attributionFailure?: string }): void {
  methods.handle("mako:mako-footprint", () => readMakoFootprint(read()))
}
