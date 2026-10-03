import { execFile } from "node:child_process"
import { readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, isAbsolute, join, relative, sep } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { AppProbeView, Capped } from "./contracts/thread-app.js"
import { HistoryMarkSchema } from "./contracts/watcher-child.js"
import { listed, toolText, when } from "./tool-text.js"
import type { FileHistory } from "./watch-backend.js"

const run = promisify(execFile)

const LSOF_BYTES = 16 * 1024 * 1024
/** Each list in a report stops here; a longer one says how many it left out. */
const REPORT_LIMIT = 40
/** Paths kept for each changed folder, to name what changed in it. */
const PATHS_KEPT = 20
/** Paths an agent's report names per folder; the desk shows them all. */
const PATHS_SAID = 5
/**
 * A probe waits this long for a read of the file system's history before
 * it says what it has; the read goes on and the next probe has it.
 */
const WAIT_MS = 2_500
/** How often Mako looks at what running apps hold open, and so how stale a `who` from a look can be. */
export const SAMPLE_EVERY_MS = 20_000
/** launchd services looked up one by one; past this they are only named. */
const SERVICES_LOOKED_UP = 10
/**
 * Where macOS keeps every user's login and background items. The folder
 * can't be listed and `sfltool dumpbtm` asks for an administrator's
 * password, but its files' times can be read.
 */
const ITEMS_FOLDER = "/private/var/db/com.apple.backgroundtaskmanagement"

/**
 * Folders, under home, where apps keep state outside their checkout. One
 * level down names an app's folder. The file system's history sees a change
 * at any depth in them; modification times see one two levels down.
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

/** Beside an app's records: what the probe compares against, from when the app came up. */
const TRACE = "probe.json"

const ChangedSchema = z.object({ paths: z.array(z.string()), more: z.boolean().optional() }).strict()
type Changed = z.infer<typeof ChangedSchema>

/** Files held open in one folder when Mako last looked, those held for writing first; `inner` is "" for the folder itself. */
const HeldSchema = z.object({
  at: z.number(),
  files: z.array(z.object({ inner: z.string(), pid: z.number().int(), command: z.string(), writing: z.boolean() }).strict()),
}).strict()
type Held = z.infer<typeof HeldSchema>

const TraceSchema = z.object({
  /** The app's `up` this belongs to; a start from nothing running begins another. */
  up: z.number(),
  /** Where the next read of the file system's history starts. Without one, folders are compared by modification time. */
  mark: HistoryMarkSchema.optional(),
  /** Roots whose history dropped events since `up`; theirs are compared by modification time too. */
  lost: z.array(z.string()).optional(),
  /** Each folder with something changed in it since `up`, by the paths inside it that changed. */
  changed: z.record(z.string(), ChangedSchema),
  /** Each folder the app's processes were last seen holding a file open in, with the files, by where in the folder. */
  held: z.record(z.string(), HeldSchema),
  /** This user's launchd services when the app came up. */
  services: z.array(z.string()).optional(),
  /** The default app for each URL scheme when the app came up, by bundle id. */
  handlers: z.record(z.string(), z.string()).optional(),
}).strict()
type Trace = z.infer<typeof TraceSchema>

/** What processes hold open, from one `lsof`. */
export interface Open {
  /** TCP ports they listen on. */
  listening: { port: number; pid: number }[]
  /** TCP connections they opened, to a port on this Mac or elsewhere; ones they accepted are left out. */
  connected: { host: string; port: number; local: boolean; pid: number }[]
  /** Regular files they hold open, by absolute path. */
  files: { path: string; pid: number; writing: boolean }[]
  cwds: Map<number, string>
  /** Each process's name, as the system shows it. */
  commands: Map<number, string>
}

export async function openBy(pids: number[]): Promise<Open> {
  const found: Open = { listening: [], connected: [], files: [], cwds: new Map(), commands: new Map() }
  if (!pids.length) return found
  const sockets: { own: number; remote: { host: string; port: number }; pid: number }[] = []
  let pid = 0
  let fd = ""
  let access = ""
  let type = ""
  let protocol = ""
  for (const line of (await lsof(["-a", "-p", pids.join(","), "-FpcfatPn"])).split("\n")) {
    const field = line[0]
    const value = line.slice(1)
    if (field === "p") pid = Number(value)
    else if (field === "c") found.commands.set(pid, value)
    else if (field === "f") {
      fd = value
      access = type = protocol = ""
    } else if (field === "a") access = value
    else if (field === "t") type = value
    else if (field === "P") protocol = value
    else if (field === "n") {
      if (fd === "cwd") found.cwds.set(pid, value)
      else if (protocol === "TCP") {
        const [from, to] = value.split("->")
        const own = address(from!)
        const remote = to === undefined ? undefined : address(to)
        if (own && remote) sockets.push({ own: own.port, remote, pid })
        else if (own && to === undefined && !found.listening.some((entry) => entry.port === own.port && entry.pid === pid)) found.listening.push({ port: own.port, pid })
      } else if (type === "REG" && isAbsolute(value) && !value.startsWith("/dev/"))
        found.files.push({ path: value, pid, writing: access === "w" || access === "u" })
    }
  }
  const listened = new Set(found.listening.map((entry) => entry.port))
  for (const socket of sockets)
    if (!listened.has(socket.own)) found.connected.push({ ...socket.remote, local: loopback(socket.remote.host), pid: socket.pid })
  return found
}

/**
 * Files held open for writing outside `inside`, such as a database or a
 * lock file another copy of the app would share.
 */
export async function writingOutside(open: Open, inside: string[]): Promise<{ path: string; pid: number }[]> {
  const roots = await Promise.all(inside.map(resolved))
  const found: { path: string; pid: number }[] = []
  for (const file of open.files)
    if (file.writing && !roots.some((root) => within(file.path, root)) && !found.some((entry) => entry.path === file.path)) found.push({ path: file.path, pid: file.pid })
  return found
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
export function capped<T>(entries: T[]): Capped<T> {
  return entries.length > REPORT_LIMIT ? { entries: entries.slice(0, REPORT_LIMIT), more: entries.length - REPORT_LIMIT } : { entries }
}

interface Roots {
  home: string
  /** `WATCHED` under home, and /tmp: where the file system's history is read. */
  history: string[]
}

async function rootsOf(home: string): Promise<Roots> {
  return { home, history: [...WATCHED.map((name) => join(home, name)), await resolved("/tmp")] }
}

/** The folder a path counts under: one level into a watched folder or /tmp, or at the top of home; and where in it. */
function folderOf(path: string, roots: Roots): { folder: string; inner: string } | undefined {
  for (const root of roots.history) {
    if (path === root || !within(path, root)) continue
    const [name, ...rest] = relative(root, path).split(sep)
    return { folder: join(root, name!), inner: rest.join(sep) }
  }
  if (path === roots.home || !within(path, roots.home)) return undefined
  const [name, ...rest] = relative(roots.home, path).split(sep)
  return name === "Library" ? undefined : { folder: join(roots.home, name!), inner: rest.join(sep) }
}

function note(changed: Record<string, Changed>, folder: string, inner: string): void {
  const entry = (changed[folder] ??= { paths: [] })
  if (!inner || entry.paths.includes(inner)) return
  if (entry.paths.length < PATHS_KEPT) entry.paths.push(inner)
  else entry.more = true
}

/**
 * Records, beside an app's records in `folder`, what its probe compares
 * against: where the file system's history stands, this user's launchd
 * services and the default app for each URL scheme. Called as the app comes
 * up from nothing running, before its first process starts.
 */
export async function beginTrace(folder: string, up: number, history?: FileHistory, home = homedir()): Promise<void> {
  const [mark, services, handlers] = await Promise.all([history?.mark().catch(() => undefined), launchdServices(), urlHandlers(home)])
  const trace: Trace = { up, changed: {}, held: {} }
  if (mark) trace.mark = mark
  if (services) trace.services = services
  if (handlers) trace.handlers = handlers
  await saveTrace(folder, trace)
}

/** Apps whose traces to bring up to date: each one's records folder and the processes it runs now. */
export interface Traced {
  folder: string
  pids: number[]
}

let refreshing: Promise<unknown> = Promise.resolve()

/**
 * Brings running apps' traces up to now: which files their processes hold
 * open in the watched folders, and, given `history`, what the file
 * system's history says changed since each was last read. Apps last read
 * at the same mark share one read, and all end at the same new mark, so
 * reading every running app costs one read. Resolves to the records
 * folders whose history now reaches this moment. One refresh at a time in
 * this process.
 */
export function refreshTraces(apps: Traced[], options: { history?: FileHistory; home?: string; open?: Open } = {}): Promise<Set<string>> {
  const next = refreshing.catch(() => {}).then(() => refresh(apps, options))
  refreshing = next
  return next
}

async function refresh(apps: Traced[], { history, home = homedir(), open }: { history?: FileHistory; home?: string; open?: Open }): Promise<Set<string>> {
  const read = new Set<string>()
  const traced = (await Promise.all(apps.map(async (app) => ({ ...app, trace: await currentTrace(app.folder) }))))
    .flatMap((app) => (app.trace ? [{ ...app, trace: app.trace }] : []))
  if (!traced.length) return read
  const roots = await rootsOf(home)
  const seen = open ?? (await openBy(traced.flatMap((app) => app.pids)))
  const at = Date.now()
  for (const app of traced) Object.assign(app.trace.held, sightings(seen, app.pids, roots, at))
  const marked = traced.filter((app) => app.trace.mark)
  const now = history && marked.length ? await history.mark().catch(() => undefined) : undefined
  if (history && now) {
    const groups = new Map<string, typeof marked>()
    for (const app of marked) groups.set(app.trace.mark!.id, [...(groups.get(app.trace.mark!.id) ?? []), app])
    for (const group of groups.values()) {
      const found = await history.since(group[0]!.trace.mark!, roots.history).catch(() => undefined)
      if (!found) continue
      for (const app of group) {
        for (const path of found.paths) {
          const place = folderOf(path, roots)
          if (place) note(app.trace.changed, place.folder, place.inner)
        }
        if (found.lost.length) app.trace.lost = [...new Set([...(app.trace.lost ?? []), ...found.lost])]
        app.trace.mark = now
        read.add(app.folder)
      }
    }
  }
  await Promise.all(traced.map(async (app) => {
    if ((await upOf(app.folder)) === app.trace.up) await saveTrace(app.folder, app.trace)
  }))
  return read
}

/** Each watched folder `pids` hold a file open in, with the files. */
function sightings(seen: Open, pids: number[], roots: Roots, at: number): Trace["held"] {
  const sighted: Trace["held"] = {}
  for (const file of [...seen.files].sort((a, b) => Number(b.writing) - Number(a.writing))) {
    if (!pids.includes(file.pid)) continue
    const place = folderOf(file.path, roots)
    if (!place) continue
    const entry = (sighted[place.folder] ??= { at, files: [] })
    if (entry.files.length < PATHS_KEPT && !entry.files.some((held) => held.inner === place.inner && held.pid === file.pid))
      entry.files.push({ inner: place.inner, pid: file.pid, command: seen.commands.get(file.pid) ?? "unknown", writing: file.writing })
  }
  return sighted
}

/** What a probe needs to know of the app, from its records and process table. */
export interface ProbeInput {
  /** The app's records folder. */
  folder: string
  /** Its processes now, in its runs' trees. */
  pids: number[]
  /** Their full command lines, to find the app bundles it runs. */
  commands: string[]
  leftovers: { pid: number; command: string; sure: boolean }[]
  /** When its processes last came up from none running. */
  since?: number
  /** Where it may write freely: its checkout, data folder and Mako's records. */
  own: string[]
  /** Folders a change in which is never the app's news, such as its project and Mako's own. */
  skip: string[]
  ports: { first: number; last: number }
  /** Who listens on a port on this Mac, in words. */
  owner(port: number): Promise<string>
  history?: FileHistory
  home?: string
  now?: () => number
}

/** The probe: what the app touches outside its checkout and ports, now and since it came up. */
export async function probeApp(input: ProbeInput): Promise<AppProbeView> {
  const now = input.now ?? Date.now
  const home = input.home ?? homedir()
  const { since } = input
  const everyone = [...new Set([...input.pids, ...input.leftovers.map((entry) => entry.pid)])]
  const [open, picked, roots, skip] = await Promise.all([openBy(everyone), systemPortsFrom(), rootsOf(home), Promise.all(input.skip.map(resolved))])
  const refreshed = since === undefined
    ? Promise.resolve(false)
    : refreshTraces([{ folder: input.folder, pids: everyone }], { history: input.history, home, open }).then((read) => read.has(input.folder), () => false)
  const [read, writing, registered, owners] = await Promise.all([
    Promise.race([refreshed, sleep(WAIT_MS).then(() => false)]),
    writingOutside(open, input.own),
    since === undefined || process.platform !== "darwin" ? Promise.resolve([]) : registrations(since, home, input),
    localOwners(open, input),
  ])
  const kept = (folder: string) => !skip.some((root) => within(folder, root) || within(root, folder))
  const trace = since === undefined ? undefined : await currentTrace(input.folder)
  const changed: Record<string, Changed> = {}
  let changedBy: AppProbeView["changedBy"] = "times"
  const notes: string[] = []
  if (since !== undefined) {
    const deep = Boolean(read && trace?.mark)
    for (const [folder, entry] of Object.entries(trace?.changed ?? {})) changed[folder] = { ...entry, paths: [...entry.paths] }
    const shallow = deep ? (trace?.lost ?? []) : roots.history
    for (const found of await byTimes(since, shallow, home, kept)) note(changed, found.folder, found.inner)
    if (deep) changedBy = "history"
    notes.push(changedBy === "history"
      ? "changedFolders is read from the file system's history, so a change at any depth counts; at the top of home only what's directly there is compared."
      : `changedFolders compares modification times one or two levels down, so a change deeper in an otherwise untouched folder is missed: ${shallowReason(trace, read, input.history)}`)
  }
  const shown = Object.entries(changed).filter(([folder]) => kept(folder)).sort(([a], [b]) => a.localeCompare(b))
  const outside = [...new Set(open.connected.filter((entry) => !entry.local).map((entry) => `${entry.host}:${entry.port}`))]
  const ours = (port: number) => (port >= input.ports.first && port <= input.ports.last) || port >= picked
  const view: AppProbeView = {
    at: now(),
    home,
    running: input.pids.length > 0,
    ports: input.ports,
    listening: open.listening.map((entry) => ({ ...entry, fixed: !ours(entry.port) })),
    connectsTo: owners,
    connectsOutside: capped(outside),
    writing: capped(writing),
    leftovers: input.leftovers,
    changed: capped(shown.map(([folder, entry]) => ({ folder, paths: entry.paths, more: Boolean(entry.more), who: who(folder, entry, open, trace?.held[folder], now()) }))),
    changedBy,
    registered,
    notes,
  }
  if (since !== undefined) view.upSince = since
  if (owners.length) notes.unshift("connectsTo is every port on this Mac the app has a connection to, with who listens there; a service another Thread's app also uses is shared, so each copy needs its own database, namespace or prefix in it.")
  if (writing.length) notes.push("writing is files the app holds open for writing outside this checkout and this Thread's data folder; two copies writing one file is a conflict.")
  if (input.leftovers.length) notes.push("leftovers, by pid, look left behind by the app: each started since it came up and outlived the process that started it, so stopping the app doesn't end it. One that carries the app's mark (set in the environment of everything Mako starts for it) is surely the app's; one Mako can't read the environment of counts because it works in this checkout or data folder.")
  if (shown.length) notes.push(`changedFolders is where apps keep state, with something in it changed since the app came up; other apps on this Mac write there too, so look for names of this project or its tools. who says which of the app's processes had a file open there, now or when Mako looked while it ran (every ${SAMPLE_EVERY_MS / 1000} seconds); macOS names the process that wrote a file only to an administrator, so a folder nothing of the app had open may still be the app's, from a file it opened and closed between looks.`)
  if (registered.length) notes.push("registered is what was added to macOS while the app ran; each says whether it points into this app. A second copy registering the same label or URL scheme replaces the first or fights it for links and logins.")
  return view
}

/** The probe's report for an agent, as YAML. */
export function probeText(view: AppProbeView): string {
  const { first, last } = view.ports
  const changed = view.changed.entries.map(({ folder, paths, more, who }) => {
    const said = paths.slice(0, PATHS_SAID)
    const left = paths.length - said.length
    if (!said.length) return [folder, { who }] as const
    return [folder, { who, changed: left || more ? [...said, more ? `and more than ${left} others` : `and ${left} more`] : said }] as const
  })
  return toolText({
    running: view.running,
    upSince: view.upSince === undefined ? undefined : when(view.upSince, view.at),
    listening: Object.fromEntries(view.listening.map((entry) =>
      [entry.port, entry.fixed ? `pid ${entry.pid}; outside this Thread's ports ${first}-${last}, so a second copy would fight over it` : `pid ${entry.pid}`])),
    connectsTo: Object.fromEntries(view.connectsTo.map(({ port, owner }) => [port, owner])),
    connectsOutside: listed(view.connectsOutside),
    writing: listed({ entries: view.writing.entries.map((entry) => entry.path), more: view.writing.more }),
    leftovers: Object.fromEntries(view.leftovers.map((entry) =>
      [entry.pid, entry.sure ? `${entry.command} (carries the app's mark)` : `${entry.command} (works in this checkout or data folder; Mako can't read its environment to be sure it's the app's)`])),
    changedFolders: view.upSince === undefined ? undefined : Object.fromEntries(changed),
    moreChangedFolders: view.changed.more,
    registered: view.registered.length ? view.registered.map((entry) => `${entry.name.replace(/:$/, "")}: ${entry.detail}`) : undefined,
    notes: view.notes.length ? view.notes : undefined,
  })
}

function shallowReason(trace: Trace | undefined, read: boolean, history: FileHistory | undefined): string {
  if (process.platform !== "darwin") return "the file system's history is read on macOS only."
  if (!history) return "this Mako reads no history."
  if (!trace) return "the app came up before Mako kept a record of where the history stood."
  if (!trace.mark) return "Mako couldn't read where the history stood when the app came up."
  if (!read) return "Mako is still reading the history since the app came up; probe again in a moment."
  return "the history couldn't be read."
}

/**
 * Which of the app's processes had files open in `folder`, now or when
 * Mako last looked while it ran, naming the ones among what changed there.
 */
function who(folder: string, changed: Changed, open: Open, held: Held | undefined, now: number): string {
  const there = open.files
    .filter((file) => within(file.path, folder))
    .sort((a, b) => Number(b.writing) - Number(a.writing))
    .map((file) => ({ inner: relative(folder, file.path), pid: file.pid, command: open.commands.get(file.pid) ?? "unknown", writing: file.writing }))
  if (there.length) return holders(folder, there, changed)
  const working = [...open.cwds].filter(([, cwd]) => within(cwd, folder)).map(([pid]) => pid)
  if (working.length) return `${working.map((pid) => `pid ${pid} (${open.commands.get(pid) ?? "unknown"})`).join("; ")} works there now.`
  if (held?.files.length) return holders(folder, held.files, changed, when(held.at, now))
  return "Nothing of the app had a file open there when Mako looked, so what changed it is unknown."
}

/** `inner` "" is the folder itself, which is then a file. */
function holders(folder: string, files: Held["files"], changed: Changed, at?: string): string {
  const matched = files.filter((file) => file.inner === "" || changed.paths.includes(file.inner))
  const shown = matched.length ? matched : files
  const said = [...new Map(shown.map((file) => [file.pid, file.command]))].map(([pid, command]) => {
    const own = shown.filter((file) => file.pid === pid)
    const names = own.slice(0, 3).map((file) => file.inner || basename(folder))
    const what = matched.length ? `${names.join(", ")}${own.length > names.length ? ` and ${own.length - names.length} more` : ""}` : "a file there"
    return `pid ${pid} (${command}) ${at ? "had" : "has"} ${what} open${own.some((file) => file.writing) ? " for writing" : ""}`
  })
  const unmatched = changed.more ? ", though not one of the changes Mako kept a name of." : ", though not one that changed."
  return `${said.join("; ")}${at ? ` when Mako looked at ${at}` : " now"}${matched.length ? "." : unmatched}`
}

async function localOwners(open: Open, input: ProbeInput): Promise<{ port: number; owner: string }[]> {
  const ports = [...new Set(open.connected.filter((entry) => entry.local).map((entry) => entry.port))]
    .filter((port) => !open.listening.some((entry) => entry.port === port))
  return Promise.all(ports.map(async (port) => ({ port, owner: await input.owner(port).catch(() => "nothing listening now") })))
}

/**
 * Folders with something changed since `since` by modification time: each
 * folder one level into `roots`, marked by its own time or one of its
 * entries', and what's directly in home. A file changed in place deeper
 * down leaves both times as they were.
 */
async function byTimes(since: number, roots: string[], home: string, kept: (path: string) => boolean): Promise<{ folder: string; inner: string }[]> {
  const found: { folder: string; inner: string }[] = []
  const newer = async (path: string) => ((await stat(path).catch(() => undefined))?.mtimeMs ?? 0) >= since
  await Promise.all(roots.map(async (root) => {
    await Promise.all((await entries(root)).map(async (entry) => {
      const path = join(root, entry.name)
      if (!kept(path)) return
      if (await newer(path)) return void found.push({ folder: path, inner: "" })
      if (!entry.isDirectory()) return
      for (const inner of await entries(path))
        if (await newer(join(path, inner.name))) return void found.push({ folder: path, inner: inner.name })
    }))
  }))
  await Promise.all((await entries(home)).map(async (entry) => {
    const path = join(home, entry.name)
    if (entry.name !== "Library" && kept(path) && (await newer(path))) found.push({ folder: path, inner: "" })
  }))
  return found
}

type Registered = AppProbeView["registered"][number]

/**
 * What was registered with macOS since `since`, against what the app's
 * trace recorded at the start: launchd services, agents written to
 * LaunchAgents, default apps for URL schemes, schemes the app bundles it
 * runs declare, and whether login and background items changed. macOS doesn't say who
 * registered any of them, so each says whether it points into the app.
 */
async function registrations(since: number, home: string, input: ProbeInput): Promise<Registered[]> {
  const [trace, bundles, own] = await Promise.all([currentTrace(input.folder), bundlesOf(input.commands), Promise.all(input.own.map(resolved))])
  const places = [...own, ...bundles]
  const whose = (...paths: (string | undefined)[]) => paths.some((path) => path !== undefined && places.some((root) => within(path, root)))
    ? " It points into this app's checkout, data folder or app bundle, so it's the app's."
    : " macOS doesn't say what registered it, so it may be another app's."
  const [services, agents, handlers, schemes] = await Promise.all([
    addedServices(trace?.services),
    launchAgents(since, home),
    changedHandlers(trace?.handlers, since, home),
    declaredSchemes(bundles),
  ])
  const loaded = new Set(services.flatMap((entry) => (entry.path ? [entry.path] : [])))
  const items = await itemsChanged(since, services.length + agents.length > 0)
  return [
    ...services.map(({ label, path, program }): Registered => ({
      kind: "service",
      name: label,
      detail: `Loaded into launchd while the app ran${path ? `, from ${path}` : ""}${program ? `; it runs ${program}` : ""}.${whose(path, program)}`,
    })),
    ...agents.filter((agent) => !loaded.has(agent.file)).map(({ label, file, program }): Registered => ({
      kind: "launch-agent",
      name: label,
      detail: `${file} was written while the app ran${program ? `; it runs ${program}` : ""}. launchd loads it at the next login.${whose(program)}`,
    })),
    ...handlers,
    ...schemes,
    ...items,
  ]
}

async function launchdServices(): Promise<string[] | undefined> {
  if (process.platform !== "darwin" || process.getuid === undefined) return undefined
  const text = await run("launchctl", ["print", `gui/${process.getuid()}`], { maxBuffer: LSOF_BYTES }).then(({ stdout }) => stdout, () => undefined)
  if (text === undefined) return undefined
  const lines = text.split("\n")
  const start = lines.findIndex((line) => line === "\tservices = {")
  if (start < 0) return undefined
  const labels: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (line === "\t}") break
    const label = line.trim().split(/\s+/).at(-1)
    if (label) labels.push(label)
  }
  return labels
}

/** Services added since the trace's list, leaving out apps LaunchServices launched, which come and go as anything opens an app. */
interface Service {
  label: string
  path?: string
  program?: string
}

async function addedServices(before: string[] | undefined): Promise<Service[]> {
  if (!before) return []
  const known = new Set(before)
  const added = ((await launchdServices()) ?? []).filter((label) => !known.has(label) && !label.startsWith("application."))
  return Promise.all(added.map(async (label, index) => {
    if (index >= SERVICES_LOOKED_UP) return { label }
    const text = await run("launchctl", ["print", `gui/${process.getuid!()}/${label}`]).then(({ stdout }) => stdout, () => "")
    const field = (name: string) => new RegExp(`^\\t${name} = (.+)$`, "m").exec(text)?.[1]
    const found: Service = { label }
    const path = field("path")
    const program = field("program")
    if (path && isAbsolute(path)) found.path = path
    if (program) found.program = program
    return found
  }))
}

const AgentSchema = z.object({ Label: z.string().optional(), Program: z.string().optional(), ProgramArguments: z.array(z.string()).optional() })

async function launchAgents(since: number, home: string): Promise<{ label: string; file: string; program?: string }[]> {
  const folder = join(home, "Library", "LaunchAgents")
  const found: { label: string; file: string; program?: string }[] = []
  await Promise.all((await entries(folder)).filter((entry) => entry.name.endsWith(".plist")).map(async (entry) => {
    const file = join(folder, entry.name)
    if (((await stat(file).catch(() => undefined))?.mtimeMs ?? 0) < since) return
    const agent = await plist(file, AgentSchema)
    const label = agent?.Label || basename(file, ".plist")
    const program = agent?.Program ?? agent?.ProgramArguments?.[0]
    found.push(program ? { label, file, program } : { label, file })
  }))
  return found
}

const HANDLERS = ["Library", "Preferences", "com.apple.LaunchServices", "com.apple.launchservices.secure.plist"]
const HandlersSchema = z.object({
  LSHandlers: z.array(z.object({ LSHandlerURLScheme: z.string().optional(), LSHandlerRoleAll: z.string().optional(), LSHandlerRoleViewer: z.string().optional() })).optional(),
})

/** The default app for each URL scheme, by bundle id, as LaunchServices keeps them; none when the file isn't there. */
async function urlHandlers(home: string): Promise<Record<string, string> | undefined> {
  if (process.platform !== "darwin") return undefined
  const file = join(home, ...HANDLERS)
  if (!(await stat(file).catch(() => undefined))) return {}
  const parsed = await plist(file, HandlersSchema)
  if (!parsed) return undefined
  const found: Record<string, string> = {}
  for (const entry of parsed.LSHandlers ?? []) {
    const app = entry.LSHandlerRoleAll ?? entry.LSHandlerRoleViewer
    if (entry.LSHandlerURLScheme && app) found[entry.LSHandlerURLScheme.toLowerCase()] = app
  }
  return found
}

async function changedHandlers(before: Record<string, string> | undefined, since: number, home: string): Promise<Registered[]> {
  if (!before) {
    const changed = ((await stat(join(home, ...HANDLERS)).catch(() => undefined))?.mtimeMs ?? 0) >= since
    return changed ? [{ kind: "url-handler", name: "Default apps for links", detail: "The default apps for links changed while the app ran; Mako has no record from its start to say which." }] : []
  }
  const now = (await urlHandlers(home)) ?? before
  return Object.entries(now).filter(([scheme, app]) => before[scheme] !== app).map(([scheme, app]) => ({
    kind: "url-handler",
    name: `${scheme}:`,
    detail: `Links now open in ${app}${before[scheme] ? `, not ${before[scheme]} as when the app came up` : ""}; it was set while the app ran.`,
  }))
}

const UrlTypesSchema = z.array(z.object({ CFBundleURLSchemes: z.array(z.string()).optional() }))
const HandlerAppsSchema = z.record(z.string(), z.object({ apps: z.array(z.string()), chosen: z.string().nullable() }))

/**
 * Every app bundle the app's processes run from, by the path in their
 * command lines. A path may hold spaces, so each place a path could start
 * is tried, nearest first, until one is a bundle.
 */
async function bundlesOf(commands: string[]): Promise<string[]> {
  const found = await Promise.all(commands.flatMap((command) => [...command.matchAll(/\.app\/Contents\/MacOS\//g)].map(async (match) => {
    const end = match.index + ".app".length
    const starts = [...command.slice(0, end).matchAll(/(?:^| )\//g)].map((start) => start.index + (start[0].length - 1)).reverse()
    for (const start of starts) {
      const bundle = command.slice(start, end)
      if (await stat(join(bundle, "Contents", "Info.plist")).catch(() => undefined)) return bundle
    }
    return undefined
  })))
  return [...new Set(found.filter((bundle) => bundle !== undefined))]
}

/**
 * URL schemes the app bundles it runs declare, with every app LaunchServices
 * would open such a link in. A bundle can register itself, and an app run
 * from a bundle often is; two copies declaring one scheme leave which copy
 * a link reaches to the system.
 */
async function declaredSchemes(bundles: string[]): Promise<Registered[]> {
  const declared = new Map<string, string>()
  await Promise.all(bundles.map(async (bundle) => {
    const types = await plist(join(bundle, "Contents", "Info.plist"), UrlTypesSchema, "CFBundleURLTypes")
    for (const scheme of (types ?? []).flatMap((type) => type.CFBundleURLSchemes ?? [])) if (!declared.has(scheme.toLowerCase())) declared.set(scheme.toLowerCase(), bundle)
  }))
  if (!declared.size) return []
  const handlers = await handlerApps([...declared.keys()])
  return [...declared].map(([scheme, bundle]) => {
    const found = handlers?.[scheme]
    const others = found?.apps.filter((app) => app !== bundle) ?? []
    const opened = !found
      ? "Mako couldn't ask LaunchServices which apps open these links."
      : !found.apps.length
        ? "No app on this Mac is registered to open these links yet."
        : `Apps on this Mac that open these links: ${found.apps.join(", ")}${found.chosen ? `; the default is ${found.chosen}` : ""}.${others.length ? " With more than one, which copy a link reaches is up to the system, not this copy." : ""}`
    return { kind: "url-scheme", name: `${scheme}:`, detail: `Declared by ${bundle}, which the app runs. ${opened}` }
  })
}

/** Every app registered to open each scheme's links, and the one that would, through NSWorkspace. */
async function handlerApps(schemes: string[]): Promise<z.infer<typeof HandlerAppsSchema> | undefined> {
  const script = `function run(schemes) {
  ObjC.import("AppKit")
  const workspace = $.NSWorkspace.sharedWorkspace
  const found = {}
  for (const scheme of schemes) {
    const url = $.NSURL.URLWithString(scheme + "://")
    const listed = workspace.URLsForApplicationsToOpenURL(url)
    const apps = []
    for (let index = 0; index < listed.count; index += 1) apps.push(listed.objectAtIndex(index).path.js)
    const chosen = workspace.URLForApplicationToOpenURL(url)
    found[scheme] = { apps, chosen: chosen.isNil() ? null : chosen.path.js }
  }
  return JSON.stringify(found)
}`
  const text = await run("osascript", ["-l", "JavaScript", "-e", script, ...schemes], { timeout: 5_000 }).then(({ stdout }) => stdout, () => undefined)
  if (text === undefined) return undefined
  try {
    return HandlerAppsSchema.parse(JSON.parse(text))
  } catch {
    return undefined
  }
}

/** When the system's list of login and background items was last written, or 0 when its time can't be read. */
async function itemsTime(): Promise<number> {
  const times = await Promise.all(Array.from({ length: 30 }, (_, index) =>
    stat(join(ITEMS_FOLDER, `BackgroundItems-v${index + 1}.btm`)).then((info) => info.mtimeMs, () => 0)))
  return Math.max(...times)
}

/**
 * Whether macOS's login and background items changed since `since`. Only
 * an administrator can list them, so what changed goes unnamed; `named`
 * says a service or agent above was registered then, which macOS adds to
 * the list.
 */
async function itemsChanged(since: number, named: boolean): Promise<Registered[]> {
  if ((await itemsTime()) < since) return []
  return [{
    kind: "login-item",
    name: "Login items",
    detail: `macOS's login and background items changed while the app ran${named ? ", likely with the service or agent above" : ""}. macOS lists them only to an administrator, so Mako can't say what was added or by whom; System Settings shows them under General, Login Items & Extensions.`,
  }]
}

/** A property list, or one key of it, read as `schema`; undefined when it can't be read or isn't one. */
async function plist<T>(file: string, schema: z.ZodType<T>, key?: string): Promise<T | undefined> {
  const args = key ? ["-extract", key, "json", "-o", "-", file] : ["-convert", "json", "-o", "-", file]
  const text = await run("plutil", args).then(({ stdout }) => stdout, () => undefined)
  if (text === undefined) return undefined
  try {
    const parsed = schema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

async function upOf(folder: string): Promise<number | undefined> {
  const up = Number.parseInt(await readFile(join(folder, "up"), "utf8").catch(() => ""), 10)
  return Number.isFinite(up) ? up : undefined
}

/** The trace of the app's current run, if one was begun when it came up. */
async function currentTrace(folder: string): Promise<Trace | undefined> {
  const [up, text] = await Promise.all([upOf(folder), readFile(join(folder, TRACE), "utf8").catch(() => undefined)])
  if (up === undefined || text === undefined) return undefined
  try {
    const trace = TraceSchema.parse(JSON.parse(text))
    return trace.up === up ? trace : undefined
  } catch {
    return undefined
  }
}

async function saveTrace(folder: string, trace: Trace): Promise<void> {
  const path = join(folder, TRACE)
  const temporary = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(temporary, JSON.stringify(trace), { mode: 0o600 })
  await rename(temporary, path)
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

async function entries(folder: string) {
  return readdir(folder, { withFileTypes: true }).catch(() => [])
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref?.())
}
