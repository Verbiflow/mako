import { execFile, spawn } from "node:child_process"
import { mkdir, open, readdir, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { ThreadIdSchema, type ThreadId } from "./contracts/thread-identity.js"

const run = promisify(execFile)

/** Stop asks nicely this long before it kills. */
const STOP_GRACE_MS = 5_000
const POLL_MS = 100
const LOCK_WAIT_MS = 30_000
/** Past this a log keeps only its last `LOG_KEEP_BYTES`, in `<name>.log.1`. */
const LOG_LIMIT_BYTES = 32 * 1024 * 1024
const LOG_KEEP_BYTES = 1024 * 1024
const PROCESS_TABLE_BYTES = 16 * 1024 * 1024
/**
 * Runs the command in a subshell, so its own `exit` still leaves the exit
 * code behind, and writes that code where the next host can read it.
 */
const WRAPPER = 'command=$1; exit_file=$2; shift 2; (eval "$command"); code=$?; printf "%s\\n" "$code" > "$exit_file"; exit "$code"'

export type RunKind = "process" | "check"

const RunSchema = z.object({
  kind: z.enum(["process", "check"]),
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
  thread?: ThreadId
  run?: { kind: RunKind; name: string }
}

interface Row {
  pid: number
  ppid: number
  pgid: number
  startedMs: number
  command: string
}

export interface ThreadProcessDependencies {
  /** One folder per Thread for its runs' records and logs. */
  root: string
  listening(port: number): Promise<boolean>
  /** A Thread's title, to name the owner of a port. */
  title?: (thread: ThreadId) => string | undefined
  now?: () => number
}

export function runKey(kind: RunKind, name: string): string {
  return `${kind}-${name}`
}

/**
 * Each Thread's running app: processes Mako starts for it, each in its own
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
  async start(thread: ThreadId, specs: RunSpec[]): Promise<{ started: string[]; refused: { name: string; reason: string }[] }> {
    const started: string[] = []
    const refused: { name: string; reason: string }[] = []
    await this.locked(thread, async () => {
      const runs = await this.runs(thread)
      const rows = await processTable()
      for (const spec of specs) {
        const key = runKey(spec.kind, spec.name)
        const current = runs[key]
        if (current && members(rows, current).length) continue
        if (spec.port !== undefined && (await this.dependencies.listening(spec.port))) {
          refused.push({ name: spec.name, reason: await this.describeHolder(spec.port, thread) })
          continue
        }
        runs[key] = await this.spawn(thread, spec)
        started.push(spec.name)
      }
      await this.save(thread, runs)
    })
    return { started, refused }
  }

  /** Stops the named runs, or all of them, with their whole process trees. */
  async stop(thread: ThreadId, keys?: string[]): Promise<string[]> {
    return this.locked(thread, async () => {
      const runs = await this.runs(thread)
      const chosen = Object.entries(runs).filter(([key]) => !keys || keys.includes(key))
      await Promise.all(chosen.map(([, record]) => stopTree(record)))
      for (const [key] of chosen) {
        delete runs[key]
        await rm(this.file(thread, key, "exit"), { force: true })
      }
      await this.save(thread, runs)
      return chosen.map(([, record]) => record.name)
    })
  }

  async status(thread: ThreadId): Promise<RunStatus[]> {
    const runs = await this.runs(thread)
    const rows = await processTable()
    return Promise.all(Object.entries(runs).map(async ([key, record]): Promise<RunStatus> => {
      await trimLog(this.file(thread, key, "log"))
      const status: RunStatus = {
        kind: record.kind,
        name: record.name,
        command: record.command,
        pid: record.pid,
        startedAt: record.at,
        state: await this.state(thread, key, record, rows),
        log: this.file(thread, key, "log"),
      }
      if (record.port !== undefined) status.port = record.port
      return status
    }))
  }

  /** Waits until every named run is up or over, or until `timeoutMs`; whichever comes first. */
  async settle(thread: ThreadId, keys: string[], timeoutMs: number): Promise<RunStatus[]> {
    const deadline = this.now() + timeoutMs
    for (;;) {
      const statuses = (await this.status(thread)).filter((status) => keys.includes(runKey(status.kind, status.name)))
      const waiting = statuses.some((status) => status.state.kind === "starting" || (status.kind === "check" && status.state.kind === "running"))
      if (!waiting || this.now() >= deadline) return statuses
      await sleep(250)
    }
  }

  /** The last `lines` lines a run wrote, stdout and stderr together. */
  async logs(thread: ThreadId, key: string, lines: number): Promise<string> {
    const path = this.file(thread, key, "log")
    const text = await readTail(path, Math.max(64 * 1024, lines * 400)).catch(() => undefined)
    if (text === undefined) throw new Error(`Nothing has run as ${key} in this Thread yet.`)
    return text.split("\n").slice(-lines - 1).join("\n")
  }

  /** Who listens on a port: one of a Thread's runs, or a process Mako didn't start. */
  async portOwner(port: number): Promise<PortOwner | undefined> {
    const listeners = await listeningPids(port)
    if (!listeners.length) return undefined
    const rows = await processTable()
    const folders = await readdir(this.dependencies.root).catch(() => [])
    for (const folder of folders) {
      const thread = ThreadIdSchema.safeParse(folder)
      if (!thread.success) continue
      const runs = await this.runs(thread.data).catch(() => ({}))
      for (const record of Object.values(runs)) {
        const pid = members(rows, record).find((row) => listeners.includes(row.pid))?.pid
        if (pid !== undefined) return { pid, command: commandOf(rows, pid), thread: thread.data, run: { kind: record.kind, name: record.name } }
      }
    }
    return { pid: listeners[0]!, command: commandOf(rows, listeners[0]!) }
  }

  /** Stops everything the Thread runs and forgets its records and logs. */
  async discard(thread: ThreadId): Promise<void> {
    await this.stop(thread)
    await this.locked(thread, () => rm(this.folder(thread), { recursive: true, force: true }))
  }

  /** Names what holds a port, for an agent that expected it free. */
  async describeHolder(port: number, thread?: ThreadId): Promise<string> {
    const owner = await this.portOwner(port).catch(() => undefined)
    if (!owner) return `Port ${port} is taken, and Mako couldn't see by what.`
    if (owner.thread && owner.run) {
      const whose = owner.thread === thread ? "this Thread" : `the Thread "${this.dependencies.title?.(owner.thread) || owner.thread}"`
      return `Port ${port} belongs to ${whose}: its ${owner.run.kind} ${owner.run.name} (pid ${owner.pid}).`
    }
    return `Port ${port} is held by pid ${owner.pid} (${owner.command}), which Mako didn't start. If you started it, stop it and try again; otherwise leave it alone and tell the user.`
  }

  private async state(thread: ThreadId, key: string, record: Run, rows: Row[]): Promise<RunState> {
    if (members(rows, record).length) {
      if (record.port === undefined || (await this.dependencies.listening(record.port))) return { kind: "running" }
      return { kind: "starting" }
    }
    const exit = await readFile(this.file(thread, key, "exit"), "utf8").catch(() => undefined)
    const code = exit === undefined ? Number.NaN : Number.parseInt(exit, 10)
    if (Number.isInteger(code)) {
      const at = (await stat(this.file(thread, key, "exit")).catch(() => undefined))?.mtimeMs ?? record.at
      return { kind: "exited", code, at }
    }
    return { kind: "ended" }
  }

  private async spawn(thread: ThreadId, spec: RunSpec): Promise<Run> {
    const key = runKey(spec.kind, spec.name)
    const log = this.file(thread, key, "log")
    const exit = this.file(thread, key, "exit")
    await rm(exit, { force: true })
    await rename(log, `${log}.1`).catch(() => {})
    const output = await open(log, "a", 0o600)
    try {
      const child = spawn("/bin/sh", ["-c", WRAPPER, "mako-thread", spec.command, exit], {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ["ignore", output.fd, output.fd],
      })
      const pid = await new Promise<number>((resolve, reject) => {
        child.once("spawn", () => resolve(child.pid!))
        child.once("error", reject)
      })
      child.unref()
      const row = (await processTable()).find((candidate) => candidate.pid === pid)
      if (!row) throw new Error(`${spec.name} exited before Mako could record it; see ${log}`)
      const record: Run = { kind: spec.kind, name: spec.name, command: spec.command, cwd: spec.cwd, pid, startedMs: row.startedMs, at: this.now() }
      if (spec.port !== undefined) record.port = spec.port
      return record
    } finally {
      await output.close()
    }
  }

  private folder(thread: ThreadId): string {
    if (!/^[A-Za-z0-9-]+$/.test(thread)) throw new Error(`Not a Thread ID: ${thread}`)
    return join(this.dependencies.root, thread)
  }

  private file(thread: ThreadId, key: string, extension: "log" | "exit"): string {
    if (!/^(process|check)-[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Not a run name: ${key}`)
    return join(this.folder(thread), `${key}.${extension}`)
  }

  private async runs(thread: ThreadId): Promise<Record<string, Run>> {
    const text = await readFile(join(this.folder(thread), "runs.json"), "utf8").catch(() => undefined)
    return text === undefined ? {} : RunsSchema.parse(JSON.parse(text)).runs
  }

  private async save(thread: ThreadId, runs: Record<string, Run>): Promise<void> {
    const path = join(this.folder(thread), "runs.json")
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ runs }, null, 2), { mode: 0o600 })
    await rename(temporary, path)
  }

  /** One change at a time per Thread, across every host on this Mac. */
  private async locked<T>(thread: ThreadId, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(thread) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(async () => {
      await mkdir(this.folder(thread), { recursive: true, mode: 0o700 })
      const lock = join(this.folder(thread), "lock")
      await acquire(lock, this.now)
      try {
        return await work()
      } finally {
        await rm(lock, { force: true })
      }
    })
    this.queues.set(thread, next)
    try {
      return await next
    } finally {
      if (this.queues.get(thread) === next) this.queues.delete(thread)
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
    if (now() >= deadline) throw new Error("Another Mako has been changing this Thread's environment for 30 seconds; try again.")
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
  const { stdout } = await run("ps", ["-A", "-o", "pid=,ppid=,pgid=,lstart=,command="], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: PROCESS_TABLE_BYTES,
  })
  const rows: Row[] = []
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/.exec(line)
    if (!match) continue
    const startedMs = Date.parse(match[4]!)
    if (Number.isFinite(startedMs)) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), startedMs, command: match[5]! })
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
