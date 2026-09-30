import { execFile, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { AppKeySchema, type AppKey } from "./contracts/thread-environments.js"

const run = promisify(execFile)

/** Stop asks nicely this long before it kills. */
const STOP_GRACE_MS = 5_000
const POLL_MS = 100
const LOCK_WAIT_MS = 30_000
/** How long a process must stay up after its port answers before it counts as running. */
const STEADY_MS = 2_000
/** Up this long already, it isn't the start being waited on. */
const LONG_UP_MS = 60_000
/** Past this a log keeps only its last `LOG_KEEP_BYTES`, in `<name>.log.1`. */
const LOG_LIMIT_BYTES = 32 * 1024 * 1024
const LOG_KEEP_BYTES = 1024 * 1024
const PROCESS_TABLE_BYTES = 16 * 1024 * 1024
/**
 * Waits for `go` on stdin, so Mako can read its start time before a quick
 * command ends, and never runs the command if Mako didn't record it. Then
 * runs the command in a subshell, so its own `exit` still leaves the exit
 * code behind, and writes that code where the next host can read it.
 */
const WRAPPER = 'command=$1; exit_file=$2; shift 2; IFS= read -r go || exit 125; [ "$go" = go ] || exit 125; (eval "$command") </dev/null; code=$?; printf "%s\\n" "$code" > "$exit_file"; exit "$code"'

export type RunKind = "process" | "check" | "prepare"

const RunSchema = z.object({
  kind: z.enum(["process", "check", "prepare"]),
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  port: z.number().int().optional(),
  pid: z.number().int().positive(),
  /** The start time the process table gives; with the pid it can't match a later process. */
  startedMs: z.number(),
  at: z.number(),
}).strict()
const RunsSchema = z.object({ runs: z.record(z.string(), RunSchema) }).strict()
type Run = z.infer<typeof RunSchema>

export type RunState =
  | { kind: "stopped" }
  | { kind: "starting" }
  | { kind: "running" }
  | { kind: "exited"; code: number; at: number }
  /** Killed by something other than Mako, or the Mac restarted. */
  | { kind: "ended" }

export interface RunStatus {
  kind: RunKind
  name: string
  command: string
  port?: number
  pid?: number
  state: RunState
  startedAt?: number
  /** What its processes hold in memory now, while any of them runs. */
  memoryBytes?: number
  log: string
}

export interface RunSpec {
  kind: RunKind
  name: string
  command: string
  cwd: string
  env: NodeJS.ProcessEnv
  port?: number
}

export interface PortOwner {
  pid: number
  command: string
  app?: AppKey
  run?: { kind: RunKind; name: string }
}

interface Row {
  pid: number
  ppid: number
  pgid: number
  rssKb: number
  startedMs: number
  command: string
}

/** An app with anything running, for room and idle decisions. */
export interface ActiveApp {
  app: AppKey
  usedAt: number
  memoryBytes: number
  runs: string[]
}

export type MemoryPressure = "normal" | "warning" | "critical"

/** What a checkout's install steps last did, kept per checkout so it stays with the files it describes. */
const PreparedSchema = z.object({
  /** The checkout it describes, for a person reading the file. */
  checkout: z.string().optional(),
  /** Each step's command, and the digest of its inputs when it last passed. */
  done: z.record(z.string(), z.string()),
  /** The digests the running prepare run will record when it passes. */
  pending: z.record(z.string(), z.string()).optional(),
}).strict()
export type Prepared = z.infer<typeof PreparedSchema>

export interface ThreadProcessDependencies {
  /** One folder per app for its runs' records and logs, and `checkouts/` for what each checkout's install did. */
  root: string
  listening(port: number): Promise<boolean>
  /** Whose app it is, in words, such as `the Thread "Fix login"`, to name the owner of a port. */
  whose?: (app: AppKey) => string | undefined
  now?: () => number
}

/** Beside the apps' folders: what each checkout's install steps last did. */
const CHECKOUTS = "checkouts"

export function runKey(kind: RunKind, name: string): string {
  return `${kind}-${name}`
}

/**
 * Each folder's running app: processes Mako starts for it, each in its own
 * process group, detached from the host, logging to a file. The records are
 * on disk, so any host sharing the Thread store (the installed app, a
 * development build, the next version after an update) sees and stops the
 * same processes, and none of them ends when a host does.
 */
export class ThreadProcesses {
  private readonly dependencies: ThreadProcessDependencies
  private readonly now: () => number
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(dependencies: ThreadProcessDependencies) {
    this.dependencies = dependencies
    this.now = dependencies.now ?? Date.now
  }

  /** Starts each run that isn't already running; a run whose port something else holds is refused with its owner. */
  async start(app: AppKey, specs: RunSpec[]): Promise<{ started: string[]; refused: { name: string; reason: string }[] }> {
    const started: string[] = []
    const refused: { name: string; reason: string }[] = []
    await this.locked(app, async () => {
      const runs = await this.runs(app)
      const rows = await processTable()
      for (const spec of specs) {
        const key = runKey(spec.kind, spec.name)
        const current = runs[key]
        if (current && members(rows, current).length) continue
        if (spec.kind === "prepare" && Object.values(runs).some((record) => record.kind === "process" && members(rows, record).length)) {
          refused.push({ name: spec.name, reason: "Stop the running app before preparing the checkout again." })
          continue
        }
        if (spec.port !== undefined && (await this.dependencies.listening(spec.port))) {
          refused.push({ name: spec.name, reason: await this.describeHolder(spec.port, app) })
          continue
        }
        await this.spawn(app, spec, async (record) => {
          runs[key] = record
          await this.save(app, runs)
        })
        started.push(spec.name)
      }
      await this.save(app, runs)
    })
    return { started, refused }
  }

  /** Stops the named runs, or all of them, with their whole process trees. */
  async stop(app: AppKey, keys?: string[]): Promise<string[]> {
    return this.locked(app, async () => {
      const runs = await this.runs(app)
      const chosen = Object.entries(runs).filter(([key]) => !keys || keys.includes(key))
      await Promise.all(chosen.map(([, record]) => stopTree(record)))
      for (const [key] of chosen) {
        delete runs[key]
        await rm(this.file(app, key, "exit"), { force: true })
      }
      await this.save(app, runs)
      return chosen.map(([, record]) => record.name)
    })
  }

  async status(app: AppKey): Promise<RunStatus[]> {
    const runs = await this.runs(app)
    const rows = await processTable()
    return Promise.all(Object.entries(runs).map(async ([key, record]): Promise<RunStatus> => {
      await trimLog(this.file(app, key, "log"))
      const status: RunStatus = {
        kind: record.kind,
        name: record.name,
        command: record.command,
        pid: record.pid,
        startedAt: record.at,
        state: await this.state(app, key, record, rows),
        log: this.file(app, key, "log"),
      }
      if (record.port !== undefined) status.port = record.port
      const held = members(rows, record).reduce((sum, row) => sum + row.rssKb * 1024, 0)
      if (held) status.memoryBytes = held
      return status
    }))
  }

  /** Waits until every named run is up or over, or until `timeoutMs`; whichever comes first. */
  async settle(app: AppKey, keys: string[], timeoutMs: number, steadyMs = STEADY_MS): Promise<RunStatus[]> {
    const deadline = this.now() + timeoutMs
    const runningSince = new Map<string, number>()
    for (;;) {
      const now = this.now()
      const statuses = (await this.status(app)).filter((status) => keys.includes(runKey(status.kind, status.name)))
      // A server can answer on its port and die a moment later; "running" means it stayed up.
      const unsteady = statuses.some((status) => {
        const key = runKey(status.kind, status.name)
        if (status.kind !== "process" || status.state.kind !== "running") {
          runningSince.delete(key)
          return false
        }
        if (!runningSince.has(key)) runningSince.set(key, (status.startedAt ?? now) < now - LONG_UP_MS ? now - steadyMs : now)
        return now - (runningSince.get(key) ?? now) < steadyMs
      })
      const waiting = unsteady || statuses.some((status) => status.state.kind === "starting" || (status.kind === "check" && status.state.kind === "running"))
      if (!waiting || now >= deadline) return statuses
      await sleep(250)
    }
  }

  /** The last `lines` lines a run wrote, stdout and stderr together. */
  async logs(app: AppKey, key: string, lines: number): Promise<string> {
    const path = this.file(app, key, "log")
    const text = await readTail(path, Math.max(64 * 1024, lines * 400)).catch(() => undefined)
    if (text === undefined) throw new Error(`Nothing has run as ${key} in this app yet.`)
    return text.split("\n").slice(-lines - 1).join("\n")
  }

  /**
   * What a run wrote since `cursor`, or its last `maxBytes` without one. A
   * new run writes a new file, and a trimmed log starts over, so either
   * comes back as a reset. Never splits a character.
   */
  async readLog(app: AppKey, key: string, cursor?: { file: string; offset: number }, maxBytes = 256 * 1024): Promise<{ text: string; cursor: { file: string; offset: number }; reset: boolean }> {
    const path = this.file(app, key, "log")
    const info = await stat(path).catch(() => undefined)
    if (!info) return { text: "", cursor: { file: "", offset: 0 }, reset: Boolean(cursor?.file) }
    const file = `${info.ino}:${Math.round(info.birthtimeMs)}`
    const same = cursor?.file === file && cursor.offset <= info.size
    const from = same ? cursor.offset : Math.max(0, info.size - maxBytes)
    const length = Math.min(info.size - from, maxBytes)
    if (!length) return { text: "", cursor: { file, offset: from }, reset: !same }
    const handle = await open(path, "r")
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, from)
      let skip = 0
      if (!same && from > 0) while (skip < bytesRead && (buffer[skip]! & 0xc0) === 0x80) skip += 1
      const whole = completeCharacters(buffer.subarray(skip, bytesRead))
      return { text: whole.toString("utf8"), cursor: { file, offset: from + skip + whole.length }, reset: !same }
    } finally {
      await handle.close()
    }
  }

  /** Who listens on a port: one of an app's runs, or a process Mako didn't start. */
  async portOwner(port: number): Promise<PortOwner | undefined> {
    const listeners = await listeningPids(port)
    if (!listeners.length) return undefined
    const rows = await processTable()
    const folders = await readdir(this.dependencies.root).catch(() => [])
    for (const folder of folders) {
      const app = AppKeySchema.safeParse(folder)
      if (!app.success) continue
      const runs = await this.runs(app.data).catch(() => ({}))
      for (const record of Object.values(runs)) {
        const pid = members(rows, record).find((row) => listeners.includes(row.pid))?.pid
        if (pid !== undefined) return { pid, command: commandOf(rows, pid), app: app.data, run: { kind: record.kind, name: record.name } }
      }
    }
    return { pid: listeners[0]!, command: commandOf(rows, listeners[0]!) }
  }

  /** An agent or person used the app in `checkout`; idle stops and room count from here. */
  async touch(app: AppKey, checkout?: string): Promise<void> {
    await mkdir(this.folder(app), { recursive: true, mode: 0o700 })
    await writeFile(join(this.folder(app), "used"), String(this.now()), { mode: 0o600 })
    if (checkout && this.checkoutOf(app) !== checkout) await writeFile(join(this.folder(app), "checkout"), checkout, { mode: 0o600 })
  }

  /** The folder an app last ran in, to name it. */
  checkoutOf(app: AppKey): string | undefined {
    try {
      return readFileSync(join(this.folder(app), "checkout"), "utf8") || undefined
    } catch {
      return undefined
    }
  }

  async usedAt(app: AppKey): Promise<number> {
    const text = await readFile(join(this.folder(app), "used"), "utf8").catch(() => "")
    const at = Number.parseInt(text, 10)
    return Number.isFinite(at) ? at : 0
  }

  /** Every app on this Mac with a process running, with what it holds and when it was last used. */
  async active(): Promise<ActiveApp[]> {
    const rows = await processTable()
    const found: ActiveApp[] = []
    for (const folder of await readdir(this.dependencies.root).catch(() => [])) {
      const app = AppKeySchema.safeParse(folder)
      if (!app.success) continue
      const runs = await this.runs(app.data).catch(() => ({}))
      let memoryBytes = 0
      const alive: string[] = []
      for (const record of Object.values(runs)) {
        const held = members(rows, record)
        if (!held.length) continue
        alive.push(record.name)
        memoryBytes += held.reduce((sum, row) => sum + row.rssKb * 1024, 0)
      }
      if (alive.length) found.push({ app: app.data, usedAt: await this.usedAt(app.data), memoryBytes, runs: alive })
    }
    return found
  }

  /** Stops every app unused for `quietMs`; its files and data stay, so the next start is quick. */
  async stopIdle(quietMs: number): Promise<AppKey[]> {
    const cutoff = this.now() - quietMs
    const idle = (await this.active()).filter((entry) => entry.usedAt < cutoff)
    for (const entry of idle) await this.stop(entry.app)
    return idle.map((entry) => entry.app)
  }

  async prepared(checkout: string): Promise<Prepared> {
    const text = await readFile(this.preparedFile(checkout), "utf8").catch(() => undefined)
    return text === undefined ? { done: {} } : PreparedSchema.catch({ done: {} }).parse(JSON.parse(text))
  }

  async savePrepared(checkout: string, prepared: Prepared): Promise<void> {
    const path = this.preparedFile(checkout)
    await mkdir(join(this.dependencies.root, CHECKOUTS), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ ...prepared, checkout }, null, 2), { mode: 0o600 })
    await rename(temporary, path)
  }

  /** Forgets what a removed checkout's install did. */
  async forgetPrepared(checkout: string): Promise<void> {
    await rm(this.preparedFile(checkout), { force: true })
  }

  /** Stops everything the app runs and forgets its records and logs. */
  async discard(app: AppKey): Promise<void> {
    await this.stop(app)
    await this.locked(app, () => rm(this.folder(app), { recursive: true, force: true }))
  }

  /** Names what holds a port, for an agent that expected it free. */
  async describeHolder(port: number, app?: AppKey): Promise<string> {
    const owner = await this.portOwner(port).catch(() => undefined)
    if (!owner) return `Port ${port} is taken, and Mako couldn't see by what.`
    if (owner.app && owner.run) {
      const whose = owner.app === app ? "this Thread" : `the app of ${this.dependencies.whose?.(owner.app) || owner.app}`
      return `Port ${port} belongs to ${whose}: its ${owner.run.kind} ${owner.run.name} (pid ${owner.pid}).`
    }
    return `Port ${port} is held by pid ${owner.pid} (${owner.command}), which Mako didn't start. If you started it, stop it and try again; otherwise leave it alone and tell the user.`
  }

  private async state(app: AppKey, key: string, record: Run, rows: Row[]): Promise<RunState> {
    if (members(rows, record).length) {
      if (record.port === undefined || (await this.dependencies.listening(record.port))) return { kind: "running" }
      return { kind: "starting" }
    }
    const exit = await readFile(this.file(app, key, "exit"), "utf8").catch(() => undefined)
    const code = exit === undefined ? Number.NaN : Number.parseInt(exit, 10)
    if (Number.isInteger(code)) {
      const at = (await stat(this.file(app, key, "exit")).catch(() => undefined))?.mtimeMs ?? record.at
      return { kind: "exited", code, at }
    }
    return { kind: "ended" }
  }

  /** Starts the run once `record` has saved it, so no host can lose track of it. */
  private async spawn(app: AppKey, spec: RunSpec, record: (run: Run) => Promise<void>): Promise<void> {
    const key = runKey(spec.kind, spec.name)
    const log = this.file(app, key, "log")
    const exit = this.file(app, key, "exit")
    await rm(exit, { force: true })
    await rename(log, `${log}.1`).catch(() => {})
    const output = await open(log, "a", 0o600)
    try {
      const child = spawn("/bin/sh", ["-c", WRAPPER, "mako-thread", spec.command, exit], {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["pipe", output.fd, output.fd],
      })
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("spawn", () => resolve(child.pid!))
        child.once("error", reject)
      })
      child.unref()
      const release = child.stdin!
      release.on("error", () => {})
      try {
        const row = (await processTable()).find((candidate) => candidate.pid === pid)
        if (!row) throw new Error(`${spec.name} ended before it started, stopped by something outside Mako; see ${log}`)
        const run: Run = { kind: spec.kind, name: spec.name, command: spec.command, cwd: spec.cwd, pid, startedMs: row.startedMs, at: this.now() }
        if (spec.port !== undefined) run.port = spec.port
        await record(run)
        release.end("go\n")
      } finally {
        if (!release.writableEnded) release.destroy()
      }
    } finally {
      await output.close()
    }
  }

  private folder(app: AppKey): string {
    return join(this.dependencies.root, AppKeySchema.parse(app))
  }

  private preparedFile(checkout: string): string {
    return join(this.dependencies.root, CHECKOUTS, `${createHash("sha256").update(checkout).digest("hex").slice(0, 16)}.json`)
  }

  private file(app: AppKey, key: string, extension: "log" | "exit"): string {
    if (!/^(process|check|prepare)-[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Not a run name: ${key}`)
    return join(this.folder(app), `${key}.${extension}`)
  }

  private async runs(app: AppKey): Promise<Record<string, Run>> {
    const text = await readFile(join(this.folder(app), "runs.json"), "utf8").catch(() => undefined)
    return text === undefined ? {} : RunsSchema.parse(JSON.parse(text)).runs
  }

  private async save(app: AppKey, runs: Record<string, Run>): Promise<void> {
    const path = join(this.folder(app), "runs.json")
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ runs }, null, 2), { mode: 0o600 })
    await rename(temporary, path)
  }

  /** One change at a time per app, across every host on this Mac. */
  private async locked<T>(app: AppKey, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(app) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(this.folder(app), { recursive: true, mode: 0o700 })
      const lock = join(this.folder(app), "lock")
      await acquire(lock, this.now)
      try {
        return await work()
      } finally {
        await rm(lock, { force: true })
      }
    })
    this.queues.set(app, next)
    try {
      return await next
    } finally {
      if (this.queues.get(app) === next) this.queues.delete(app)
    }
  }
}

async function acquire(lock: string, now: () => number): Promise<void> {
  const deadline = now() + LOCK_WAIT_MS
  for (;;) {
    try {
      await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 })
      return
    } catch (error) {
      if (!z.object({ code: z.literal("EEXIST") }).safeParse(error).success) throw error
    }
    const holder = Number.parseInt(await readFile(lock, "utf8").catch(() => ""), 10)
    if (!Number.isInteger(holder) || !processExists(holder)) {
      await rm(lock, { force: true })
      continue
    }
    if (now() >= deadline) throw new Error("Another Mako has been changing this app for 30 seconds; try again.")
    await sleep(POLL_MS)
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return z.object({ code: z.literal("EPERM") }).safeParse(error).success
  }
}

/** Every process on the machine, with when it started; `ps` is on macOS and Linux alike. */
async function processTable(): Promise<Row[]> {
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,pgid=,rss=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: PROCESS_TABLE_BYTES,
  })
  const rows: Row[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/.exec(line)
    if (!match) continue
    const startedMs = Date.parse(match[5]!)
    if (Number.isFinite(startedMs)) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), rssKb: Number(match[4]), startedMs, command: match[6]! })
  }
  return rows
}

/**
 * A run's processes: its group, and every descendant, including ones that
 * started a group of their own. Nothing that started before the run can be
 * one. The system never reuses a pid while a group still carries it, so a
 * different process under the leader's pid means the group is gone.
 */
function members(rows: Row[], record: Run): Row[] {
  const reused = rows.some((row) => row.pid === record.pid && row.startedMs !== record.startedMs)
  if (reused) return []
  const later = rows.filter((row) => row.startedMs >= record.startedMs && row.pid !== process.pid && row.pid > 1)
  const found = new Map(later.filter((row) => row.pgid === record.pid).map((row) => [row.pid, row]))
  for (let grew = found.size > 0; grew;) {
    grew = false
    for (const row of later)
      if (!found.has(row.pid) && found.has(row.ppid)) {
        found.set(row.pid, row)
        grew = true
      }
  }
  return [...found.values()]
}

async function stopTree(record: Run): Promise<void> {
  const signaled = new Set<string>()
  const send = (rows: Row[], signal: NodeJS.Signals) => {
    for (const row of rows) {
      const identity = `${row.pid}:${row.startedMs}`
      if (signal === "SIGTERM" && signaled.has(identity)) continue
      signaled.add(identity)
      try {
        process.kill(row.pid, signal)
      } catch {
        // Gone between the listing and the signal.
      }
    }
  }
  let rows = members(await processTable(), record)
  send(rows, "SIGTERM")
  const deadline = Date.now() + STOP_GRACE_MS
  while (rows.length && Date.now() < deadline) {
    await sleep(POLL_MS)
    rows = members(await processTable(), record)
    send(rows, "SIGTERM")
  }
  for (let attempt = 0; rows.length && attempt < 20; attempt += 1) {
    send(rows, "SIGKILL")
    await sleep(POLL_MS)
    rows = members(await processTable(), record)
  }
  if (rows.length) throw new Error(`${record.name} still has ${rows.length} process(es) after SIGKILL: ${rows.map((row) => row.pid).join(", ")}`)
}

async function listeningPids(port: number): Promise<number[]> {
  let stdout: string
  try {
    ({ stdout } = await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"], {
      env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/usr/sbin:/usr/bin:/sbin:/bin` },
    }))
  } catch (error) {
    // lsof exits 1 when nothing matches.
    if (z.object({ code: z.literal(1) }).safeParse(error).success) return []
    throw error
  }
  return [...new Set(stdout.split("\n").filter((line) => line.startsWith("p")).map((line) => Number(line.slice(1))))]
}

function commandOf(rows: Row[], pid: number): string {
  return rows.find((row) => row.pid === pid)?.command.slice(0, 200) ?? "unknown"
}

/** Opened for appending by the run, so cutting the file to zero is safe while it writes. */
async function trimLog(path: string): Promise<void> {
  const size = (await stat(path).catch(() => undefined))?.size ?? 0
  if (size <= LOG_LIMIT_BYTES) return
  await writeFile(`${path}.1`, await readTail(path, LOG_KEEP_BYTES), { mode: 0o600 })
  await truncate(path, 0)
}

async function readTail(path: string, bytes: number): Promise<string> {
  const file = await open(path, "r")
  try {
    const { size } = await file.stat()
    const length = Math.min(size, bytes)
    const buffer = Buffer.alloc(length)
    await file.read(buffer, 0, length, size - length)
    return buffer.toString("utf8")
  } finally {
    await file.close()
  }
}

/** Up to the last whole UTF-8 character: a read can end partway through one, and the next read picks it up. */
function completeCharacters(bytes: Buffer): Buffer {
  for (let back = 1; back <= Math.min(3, bytes.length); back += 1) {
    const byte = bytes[bytes.length - back]!
    if ((byte & 0xc0) === 0x80) continue
    const size = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    return size > back ? bytes.subarray(0, bytes.length - back) : bytes
  }
  return bytes
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * How short of memory this machine is: macOS's own pressure level, or
 * Linux's pressure stall figures. Anything unreadable counts as normal.
 */
export async function memoryPressure(): Promise<MemoryPressure> {
  if (process.platform === "darwin") {
    const level = await run("sysctl", ["-n", "kern.memorystatus_vm_pressure_level"]).then(({ stdout }) => Number(stdout.trim()), () => 1)
    return level >= 4 ? "critical" : level >= 2 ? "warning" : "normal"
  }
  const text = await readFile("/proc/pressure/memory", "utf8").catch(() => "")
  const average = (kind: string) => Number(new RegExp(`^${kind} avg10=([\\d.]+)`, "m").exec(text)?.[1] ?? 0)
  return average("full") > 10 ? "critical" : average("some") > 20 ? "warning" : "normal"
}
