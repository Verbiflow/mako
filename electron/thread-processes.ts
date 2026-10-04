import { execFile, spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat, truncate, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { inside, workingDirectories } from "./app-probe.js"
import { STEPS_FOLDER_VARIABLE, stepsOf, type StepRecord } from "./check-steps.js"
import { belowAgents } from "./background-priority.js"
import { FIT_RUNS } from "./contracts/thread-app.js"
import { AppKeySchema, type AppKey } from "./contracts/thread-environments.js"
import { containersBy, lookAtContainers, type Container, type ContainerLook } from "./container-runtime.js"

const run = promisify(execFile)

/** Stop asks nicely this long before it kills. */
/**
 * How long a stopped run may take to exit before SIGKILL. Longer than the
 * 10 s a container runtime gives a container to stop: a `docker compose up`
 * killed sooner leaves its containers running.
 */
const STOP_GRACE_MS = 15_000
const POLL_MS = 100
/** Between tries of a readiness command: closely while a start is usually done, then less often for one that never comes up. */
const readyWait = (elapsedMs: number) => (elapsedMs < 30_000 ? 500 : elapsedMs < 300_000 ? 2_000 : 10_000)
/** One try of a readiness command that hangs is stopped after this. */
const READY_TRY_MS = 10_000
/** How much of a failed readiness try's output is kept to say why it isn't ready. */
const READY_OUTPUT_CHARS = 2_000
const LOCK_WAIT_MS = 30_000
/** How long a process must stay up after its port answers before it counts as running. */
const STEADY_MS = 2_000
/** Up this long already, it isn't the start being waited on. */
const LONG_UP_MS = 60_000
/** Past this a log keeps only its last `LOG_KEEP_BYTES`, in `<name>.log.1`. */
const LOG_LIMIT_BYTES = 32 * 1024 * 1024
const LOG_KEEP_BYTES = 1024 * 1024
const PROCESS_TABLE_BYTES = 16 * 1024 * 1024
/** Runs of a project's app whose peaks are kept; the estimate is their median. */
const PEAK_RUNS = 20
/** A run counts toward the estimate once it was measured this long after it came up, past a start that crashed or was stopped at once. */
const PEAK_STEADY_MS = 60_000
/** A peak is written again only once it grows by this much, so a slow climb doesn't rewrite the file on every look. */
const PEAK_GROWTH = 1.05
/** Reading one process's footprint takes about 40 ms, 30 ms of it CPU; a few run at once. */
const FOOTPRINT_MS = 5_000
const FOOTPRINT_PARALLEL = 4
/** Footprints read in one look; the rest wait for the next, and count their resident size meanwhile. */
const FOOTPRINT_MAX_PIDS = 48
/** A footprint is read again once its process's resident size has moved this much, or once it's this old. */
const FOOTPRINT_DRIFT = 0.05
const FOOTPRINT_KEEP_MS = 5 * 60_000
/** Their processes are clients; the containers run in the runtime's VM, outside every process tree here, and are read from the runtime. */
const CONTAINER_CLIENT = /(?:^|\/)(?:docker|docker-compose|podman|podman-compose|nerdctl|finch)(?:\s|$)/
/**
 * Waits for `go` on stdin, so Mako can read its start time before a quick
 * command ends, and never runs the command if Mako didn't record it. Then
 * runs the command in a subshell, so its own `exit` still leaves the exit
 * code behind, and writes that code where the next host can read it.
 */
const WRAPPER = 'command=$1; exit_file=$2; shift 2; IFS= read -r go || exit 125; [ "$go" = go ] || exit 125; (eval "$command") </dev/null; code=$?; printf "%s\\n" "$code" > "$exit_file"; exit "$code"'
/**
 * In the environment of every run, naming its app: a process that left its
 * run's tree still carries it, unless it cleared its environment. Agents'
 * shells carry the Thread's values but never this.
 */
const RUN_MARK = "MAKO_APP_RUN"

export type RunKind = "process" | "check" | "prepare"

const RunSchema = z.object({
  kind: z.enum(["process", "check", "prepare"]),
  name: z.string(),
  command: z.string(),
  cwd: z.string(),
  port: z.number().int().optional(),
  /** A command that passes once it can serve; it's running only once that has passed (`<key>.ready`). */
  ready: z.string().optional(),
  pid: z.number().int().positive(),
  /** The start time the process table gives; with the pid it can't match a later process. */
  startedMs: z.number(),
  at: z.number(),
}).strict()
const RunsSchema = z.object({ runs: z.record(z.string(), RunSchema) }).strict()
type Run = z.infer<typeof RunSchema>

/** A ready command's failed try: its exit code (null when it was killed or couldn't start) and the end of what it printed. */
const ReadyFailureSchema = z.object({ code: z.number().nullable(), output: z.string() }).strict()
export type ReadyFailure = z.infer<typeof ReadyFailureSchema>

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
  /** Its readiness command, which decides when it's running instead of its port. */
  ready?: string
  /** While it starts, how that command's latest try failed. */
  readyFailure?: ReadyFailure
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
  /** Run in `cwd` with `env` while it starts (`readyWait`); it's running once this exits 0. */
  ready?: string
  /** At the lowest priority, for work nobody waits on yet, such as a spare checkout's install. Nothing can raise it later. */
  background?: true
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

/** An app with records, where it last ran and how each of its runs is. */
export interface AppOverview {
  app: AppKey
  checkout?: string
  /** The main checkout of the project it last started in. */
  project?: string
  usedAt: number
  /** When its processes last came up from none running. */
  upAt?: number
  runs: Pick<RunStatus, "kind" | "name" | "state" | "startedAt" | "port">[]
}

/** An app with anything running, for room and idle decisions. */
export interface ActiveApp {
  app: AppKey
  usedAt: number
  memoryBytes: number
  runs: { kind: RunKind; name: string }[]
  /** Its records folder, and its processes in its runs' trees. */
  folder: string
  pids: number[]
}

/** A process that looks left behind by an app; `sure` when it carries the app's mark, not only works in its folders. */
export interface Leftover {
  pid: number
  command: string
  sure: boolean
}

export type MemoryPressure = "normal" | "warning" | "critical"

/**
 * What an app held at one look: its processes' physical footprint on macOS,
 * as Activity Monitor counts it, else resident memory, and what its
 * containers hold in the container runtime.
 */
export interface AppMemory {
  bytes: number
  /** What its containers hold, counted in `bytes`: those Compose ran in its checkout or that mount a folder of it. */
  containerBytes?: number
  /** It runs a container client and none of its containers could be read, so their memory isn't in `bytes`. */
  containers?: true
}

export interface MemoryLook {
  at: number
  /** What the system could give apps now: macOS's free share of all memory, or Linux's MemAvailable. */
  freeBytes?: number
  totalBytes?: number
  apps: Map<AppKey, AppMemory>
  /** The container runtime's machine: what it can give containers in all, and what every running container holds. */
  containerRuntime?: { totalBytes: number; usedBytes: number }
}

/** How much a copy of a project's app takes at its peak, from its earlier runs. */
export type MemoryEstimate =
  | { kind: "learning"; runs: number }
  /** Its runs start containers whose memory couldn't be read. */
  | { kind: "containers" }
  /** `containerBytes`, inside `peakBytes`, is what its containers held at the median run, when they were read. */
  | { kind: "ready"; runs: number; peakBytes: number; containerBytes?: number }

const PeaksSchema = z.object({
  project: z.string(),
  runs: z.array(z.object({
    app: AppKeySchema,
    /** The run: when its app's processes came up. */
    up: z.number(),
    /** The most its process runs held: each process at its own peak, as of the latest look. Installs and checks don't count. */
    bytes: z.number(),
    /** Measured once it had been up `PEAK_STEADY_MS`. */
    steady: z.boolean().optional(),
    /** Its containers ran and couldn't be read: `bytes` misses them. */
    containers: z.boolean().optional(),
    /** What its containers held at their most, inside `bytes`. */
    containerBytes: z.number().optional(),
  })),
})
type Peaks = z.infer<typeof PeaksSchema>
/** A running app's peak at one look, for its project's estimate. */
interface Seen {
  app: AppKey
  up: number
  bytes: number
  containers: boolean
  containerBytes?: number
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2)
}

/** What a checkout's install steps last did, kept per checkout so it stays with the files it describes. */
const PreparedSchema = z.object({
  /** The checkout it describes, for a person reading the file. */
  checkout: z.string().optional(),
  /** Each step's command, and the digest of its inputs when it last passed. */
  done: z.record(z.string(), z.string()),
  /** The digests the running prepare run will record when it passes. */
  pending: z.record(z.string(), z.string()).optional(),
  /** The app whose prepare run carries `pending`, when it isn't the checkout's own: a spare checkout's, handed over with it. */
  by: AppKeySchema.optional(),
  /** Where the checkout was when that run started: a link to here until it ends, since it may write to paths it resolved there. */
  link: z.string().optional(),
}).strict()
export type Prepared = z.infer<typeof PreparedSchema>

export interface ThreadProcessDependencies {
  /** One folder per app for its runs' records and logs, and `checkouts/` for what each checkout's install did. */
  root: string
  listening(port: number): Promise<boolean>
  /** Whose app it is, in words, such as `the Thread "Fix login"`, to name the owner of a port. */
  whose?: (app: AppKey) => string | undefined
  /**
   * The app came up from nothing running: called with its records folder
   * and that moment, before its first process starts, so the probe can
   * record what it compares against. A failure starts the app regardless.
   */
  cameUp?: (folder: string, at: number) => Promise<void>
  /** The container runtime's running containers, or undefined when none answers; the engine's API by default. */
  containers?: () => Promise<ContainerLook | undefined>
  now?: () => number
}

/** Beside the apps' folders: what each checkout's install steps last did. */
const CHECKOUTS = "checkouts"
/** Beside them too: each project's memory peaks, one file per project. */
const MEMORY = "memory"

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
  private readonly projects = new Map<AppKey, string>()
  /** The peak written for each run, by `<app>:<up>`, so a look writes only what grew. */
  private readonly peaks = new Map<string, { bytes: number; steady: boolean }>()
  /** Each process's last footprint reading, by `<pid>:<start>`, with its resident size then. */
  private readonly footprints = new Map<string, { bytes: number; peakBytes: number; rssKb: number; at: number }>()
  private measured: MemoryLook | undefined
  private measuring: Promise<MemoryLook> | undefined

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
        if (spec.kind === "process" && !Object.values(runs).some((record) => record.kind === "process" && members(rows, record).length)) {
          const up = this.now()
          await writeFile(join(this.folder(app), "up"), String(up), { mode: 0o600 })
          await this.dependencies.cameUp?.(this.folder(app), up).catch(() => {})
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
        await rm(this.file(app, key, "ready"), { force: true })
        await rm(this.file(app, key, "unready"), { force: true })
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
      if (record.ready !== undefined) status.ready = record.ready
      if (record.ready !== undefined && status.state.kind === "starting") {
        const failure = ReadyFailureSchema.safeParse(await readFile(this.file(app, key, "unready"), "utf8").then((text) => JSON.parse(text), () => undefined))
        if (failure.success) status.readyFailure = failure.data
      }
      const held = members(rows, record).reduce((sum, row) => sum + row.rssKb * 1024, 0)
      if (held) status.memoryBytes = held
      return status
    }))
  }

  /** Waits until every named run is up or over, or until `timeoutMs`; whichever comes first. */
  async settle(app: AppKey, keys: string[], timeoutMs: number, steadyMs = STEADY_MS): Promise<RunStatus[]> {
    const began = this.now()
    const deadline = began + timeoutMs
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
      const waiting = unsteady || statuses.some((status) => status.state.kind === "starting" || (status.kind !== "process" && status.state.kind === "running"))
      if (!waiting || now >= deadline) return statuses
      // Each look reads the whole process table, so a long check is looked at less often.
      await sleep(Math.min(deadline - now, now - began < 10_000 ? 250 : now - began < 60_000 ? 1_000 : 2_000))
    }
  }

  /** Everything a run, or one of its steps, wrote, stdout and stderr together, and the log it's in. */
  async output(app: AppKey, key: string, step?: string): Promise<{ text: string; log: string }> {
    const log = this.logFile(app, key, step)
    const text = await readTail(log, LOG_LIMIT_BYTES).catch(() => undefined)
    if (text === undefined) throw new Error(`Nothing has run as ${step ? `the step ${step} of ` : ""}${key} in this app yet.`)
    return { text, log }
  }

  /** The last `lines` lines a run, or one of its steps, wrote, stdout and stderr together. */
  async logs(app: AppKey, key: string, lines: number, step?: string): Promise<string> {
    const path = this.logFile(app, key, step)
    const text = await readTail(path, Math.max(64 * 1024, lines * 400)).catch(() => undefined)
    if (text === undefined) throw new Error(`Nothing has run as ${step ? `the step ${step} of ` : ""}${key} in this app yet.`)
    return text.split("\n").slice(-lines - 1).join("\n")
  }

  /**
   * What each step of a check run of steps (`stepsCommand`) last left, by
   * name: a step keeps its result from whichever run last ran it, so a run
   * of some steps leaves the others' results as they were.
   */
  async steps(app: AppKey, key: string): Promise<Map<string, StepRecord>> {
    const folder = this.stepsFolder(app, key)
    const names = (await readdir(folder).catch((): string[] => [])).flatMap((name) => /^([a-z][a-z0-9-]*)\.start$/.exec(name)?.[1] ?? [])
    const records = await Promise.all(names.map(async (name): Promise<StepRecord | undefined> => {
      const [started, command, ended, code] = await Promise.all([
        stat(join(folder, `${name}.start`)).catch(() => undefined),
        readFile(join(folder, `${name}.cmd`), "utf8").catch(() => undefined),
        stat(join(folder, `${name}.exit`)).catch(() => undefined),
        readFile(join(folder, `${name}.exit`), "utf8").catch(() => undefined),
      ])
      if (!started) return undefined
      const record: StepRecord = { name, startedAt: started.mtimeMs }
      if (command !== undefined) record.command = command
      const exit = code === undefined ? Number.NaN : Number.parseInt(code, 10)
      if (ended && Number.isInteger(exit)) record.exit = { code: exit, at: ended.mtimeMs }
      return record
    }))
    return new Map(records.flatMap((record) => (record ? [[record.name, record] as const] : [])))
  }

  /**
   * What a run, or one of its steps, wrote since `cursor`, or its last
   * `maxBytes` without one. A new run writes a new file, and a trimmed log
   * starts over, so either comes back as a reset. Never splits a character.
   */
  async readLog(app: AppKey, key: string, cursor?: { file: string; offset: number }, maxBytes = 256 * 1024, step?: string): Promise<{ text: string; cursor: { file: string; offset: number }; reset: boolean }> {
    const path = this.logFile(app, key, step)
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

  /**
   * An app's processes now, for the probe: those in its runs' trees, with
   * their command lines, and those that look left behind by them, which no
   * stop ends: started since the app came up and outliving their parent,
   * with whatever they started. One counts when it carries the app's mark;
   * one whose environment the system won't show (Apple's own programs,
   * such as sleep) counts when it works in one of `folders`. One whose
   * environment shows no mark isn't the app's, such as a test someone ran
   * in the checkout. `since` is when the app's processes last came up from
   * none running.
   */
  async footprint(app: AppKey, folders: string[]): Promise<{ pids: number[]; commands: string[]; leftovers: Leftover[]; since?: number; records: string; folder: string }> {
    const runs = await this.runs(app)
    const rows = await processTable()
    const pids = new Set(Object.values(runs).flatMap((record) => members(rows, record).map((row) => row.pid)))
    const since = await this.upAt(app)
    const leftovers: Leftover[] = []
    if (since !== undefined) {
      // ps gives start times to the second.
      const later = rows.filter((row) => row.startedMs >= Math.floor(since / 1000) * 1000 && !pids.has(row.pid) && row.pid !== process.pid)
      const orphans = later.filter((row) => row.ppid === 1)
      const marks = await runMarks(orphans)
      const hidden = orphans.filter((row) => !marks.has(row.pid))
      const cwds = await workingDirectories(hidden.map((row) => row.pid))
      const roots = await Promise.all(folders.map((folder) => realpath(folder).catch(() => folder)))
      const found = new Map<number, boolean>([
        ...orphans.filter((row) => marks.get(row.pid) === app).map((row) => [row.pid, true] as const),
        ...hidden.filter((row) => roots.some((root) => inside(cwds.get(row.pid), root))).map((row) => [row.pid, false] as const),
      ])
      for (let grew = found.size > 0; grew;) {
        grew = false
        for (const row of later)
          if (!found.has(row.pid) && found.has(row.ppid)) {
            found.set(row.pid, found.get(row.ppid)!)
            grew = true
          }
      }
      leftovers.push(...[...found].map(([pid, sure]) => ({ pid, command: commandOf(rows, pid), sure })))
    }
    const commands = [...new Set(rows.filter((row) => pids.has(row.pid)).map((row) => row.command))]
    const report = { pids: [...pids], commands, leftovers, records: this.dependencies.root, folder: this.folder(app) }
    return since === undefined ? report : { ...report, since }
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
    const folders = await readdir(this.dependencies.root).catch(() => [])
    if (!folders.length) return []
    const rows = await processTable()
    const found: ActiveApp[] = []
    for (const folder of folders) {
      const app = AppKeySchema.safeParse(folder)
      if (!app.success) continue
      const runs = await this.runs(app.data).catch(() => ({}))
      let memoryBytes = 0
      const alive: ActiveApp["runs"] = []
      const pids: number[] = []
      for (const record of Object.values(runs)) {
        const held = members(rows, record)
        if (!held.length) continue
        alive.push({ kind: record.kind, name: record.name })
        pids.push(...held.map((row) => row.pid))
        memoryBytes += held.reduce((sum, row) => sum + row.rssKb * 1024, 0)
      }
      if (alive.length) found.push({ app: app.data, usedAt: await this.usedAt(app.data), memoryBytes, runs: alive, folder: this.folder(app.data), pids })
    }
    return found
  }

  /** Every app on this Mac with records, from one look at the process table, for marking them all at once. */
  async overview(): Promise<AppOverview[]> {
    const rows = await sharedProcessTable()
    const found: AppOverview[] = []
    for (const folder of await readdir(this.dependencies.root).catch(() => [])) {
      const app = AppKeySchema.safeParse(folder)
      if (!app.success) continue
      const runs = Object.entries(await this.runs(app.data).catch(() => ({})))
      if (!runs.length) continue
      const [states, usedAt, upAt, project] = await Promise.all([
        Promise.all(runs.map(async ([key, record]) => {
          const run: AppOverview["runs"][number] = { kind: record.kind, name: record.name, state: await this.state(app.data, key, record, rows), startedAt: record.at }
          if (record.port !== undefined) run.port = record.port
          return run
        })),
        this.usedAt(app.data),
        this.upAt(app.data),
        this.projectOf(app.data),
      ])
      const entry: AppOverview = { app: app.data, usedAt, runs: states }
      const checkout = this.checkoutOf(app.data)
      if (checkout) entry.checkout = checkout
      if (project) entry.project = project
      if (upAt !== undefined) entry.upAt = upAt
      found.push(entry)
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

  /** The project an app runs for, by its main checkout, so its runs' peaks count toward that project's. */
  async ofProject(app: AppKey, project: string): Promise<void> {
    if ((await this.projectOf(app)) === project) return
    await mkdir(this.folder(app), { recursive: true, mode: 0o700 })
    await writeFile(join(this.folder(app), "project"), project, { mode: 0o600 })
    this.projects.set(app, project)
  }

  /**
   * Stops every process the app runs while `work` moves what they work in,
   * then lets them go on: a stopped process makes no calls, so none finds
   * its folder half moved. Groups are stopped whole, so a child forked
   * after the process table was read stops with its parent.
   */
  async paused<T>(app: AppKey, work: () => Promise<T>): Promise<T> {
    const runs = Object.values(await this.runs(app))
    const rows = await processTable()
    const held = runs.flatMap((record) => members(rows, record))
    const groups = [...new Set(runs.filter((record) => members(rows, record).length).map((record) => record.pid))]
    const signal = (name: NodeJS.Signals) => {
      for (const group of groups) {
        try {
          process.kill(-group, name)
        } catch {
          // The group is gone.
        }
      }
      for (const row of held) {
        try {
          process.kill(row.pid, name)
        } catch {
          // Gone between the listing and the signal.
        }
      }
    }
    signal("SIGSTOP")
    try {
      return await work()
    } finally {
      signal("SIGCONT")
    }
  }

  /** The last look at what running apps hold, however old. */
  lastMemory(): MemoryLook | undefined {
    return this.measured
  }

  /**
   * What every running app holds now, with each project's peaks brought up
   * to date. Looks under way are shared. With no process group of any app
   * alive it reads no process table at all.
   */
  memory(): Promise<MemoryLook> {
    this.measuring ??= this.measure().then((look) => {
      this.measured = look
      return look
    }).finally(() => {
      this.measuring = undefined
    })
    return this.measuring
  }

  /** What a copy of the project's app holds at its peak: the median of its last runs that stayed up, once there are `FIT_RUNS`. */
  async estimate(project: string): Promise<MemoryEstimate> {
    const counted = (await this.readPeaks(project)).runs.filter((entry) => entry.steady && entry.bytes > 0)
    if (counted.some((entry) => entry.containers)) return { kind: "containers" }
    if (counted.length < FIT_RUNS) return { kind: "learning", runs: counted.length }
    const estimate: MemoryEstimate = { kind: "ready", runs: counted.length, peakBytes: median(counted.map((entry) => entry.bytes)) }
    const contained = counted.flatMap((entry) => (entry.containerBytes ? [entry.containerBytes] : []))
    if (contained.length) estimate.containerBytes = median(contained)
    return estimate
  }

  /**
   * The app's running containers, wherever they are in its life: those
   * Compose ran in its checkout or that mount a folder of it, when no other
   * app's checkout holds that folder more closely. Undefined when no
   * container runtime answers.
   */
  async appContainers(app: AppKey): Promise<Container[] | undefined> {
    const look = await this.containerLook()
    if (!look) return undefined
    const owners: { owner: AppKey; folders: string[] }[] = []
    for (const folder of await readdir(this.dependencies.root).catch(() => [])) {
      const other = AppKeySchema.safeParse(folder)
      if (other.success) owners.push({ owner: other.data, folders: this.foldersOf(other.data, Object.values(await this.runs(other.data).catch(() => ({})))) })
    }
    return containersBy(look, owners).get(app) ?? []
  }

  /** The folders an app's containers are tied to it by: its checkout and its runs' folders. */
  private foldersOf(app: AppKey, runs: Run[]): string[] {
    const checkout = this.checkoutOf(app)
    return [...new Set([...(checkout ? [checkout] : []), ...runs.map((record) => record.cwd)])]
  }

  /** One look at the container runtime shared by a measure, the probe and a stop; a missing runtime is no runtime. */
  private containerLook(): Promise<ContainerLook | undefined> {
    return (this.dependencies.containers ?? lookAtContainers)().catch(() => undefined)
  }

  private async measure(): Promise<MemoryLook> {
    const at = this.now()
    const [system, apps] = await Promise.all([freeMemory(), this.appMemory()])
    const look: MemoryLook = { at, apps: new Map([...apps.found].map(([app, entry]) => [app, entry.memory])) }
    if (system) Object.assign(look, system)
    if (apps.runtime) look.containerRuntime = apps.runtime
    const byProject = new Map<string, Seen[]>()
    for (const [app, entry] of apps.found) {
      const [project, up] = await Promise.all([this.projectOf(app), this.upAt(app)])
      if (!project || up === undefined || !entry.peakBytes) continue
      const seen: Seen = { app, up, bytes: entry.peakBytes, containers: Boolean(entry.memory.containers) }
      if (entry.memory.containerBytes) seen.containerBytes = entry.memory.containerBytes
      byProject.set(project, [...(byProject.get(project) ?? []), seen])
    }
    for (const [project, seen] of byProject) await this.recordPeaks(project, seen, at).catch(() => {})
    return look
  }

  /**
   * Each running app's memory, and the most its process runs have held, with
   * the containers it runs; and the container runtime's machine, when one
   * answered.
   */
  private async appMemory(): Promise<{ found: Map<AppKey, { memory: AppMemory; peakBytes: number }>; runtime?: MemoryLook["containerRuntime"] }> {
    const found = new Map<AppKey, { memory: AppMemory; peakBytes: number }>()
    const apps: { app: AppKey; runs: Run[] }[] = []
    for (const folder of await readdir(this.dependencies.root).catch(() => [])) {
      const app = AppKeySchema.safeParse(folder)
      if (!app.success) continue
      const runs = Object.values(await this.runs(app.data).catch(() => ({})))
      if (runs.length) apps.push({ app: app.data, runs })
    }
    if (!apps.some((entry) => entry.runs.some((record) => groupAlive(record.pid)))) return { found }
    const [rows, containerLook] = await Promise.all([sharedProcessTable(), this.containerLook()])
    const held = apps.map(({ app, runs }) => ({ app, runs: runs.map((record) => ({ record, rows: members(rows, record) })) }))
    const footprints = await this.footprintsOf(held.flatMap((entry) => entry.runs.flatMap((one) => one.rows)))
    const bytesOf = (row: Row) => footprints.get(row.pid)?.bytes ?? row.rssKb * 1024
    const peakOf = (row: Row) => footprints.get(row.pid)?.peakBytes ?? bytesOf(row)
    const sum = (runs: typeof held[number]["runs"], of: (row: Row) => number) => runs.reduce((total, one) => total + one.rows.reduce((part, row) => part + of(row), 0), 0)
    // A container is the running app's whose checkout or run folder holds its folders most closely.
    const live = held.flatMap(({ app, runs }) => {
      const up = runs.filter((one) => one.rows.length)
      return up.length ? [{ app, up }] : []
    })
    const contained = containerLook ? containersBy(containerLook, live.map(({ app, up }) => ({ owner: app, folders: this.foldersOf(app, up.map((one) => one.record)) }))) : new Map<AppKey, Container[]>()
    for (const { app, up } of live) {
      const memory: AppMemory = { bytes: sum(up, bytesOf) }
      const containerBytes = (contained.get(app) ?? []).reduce((total, container) => total + (container.bytes ?? 0), 0)
      if (containerBytes) {
        memory.bytes += containerBytes
        memory.containerBytes = containerBytes
      } else if (up.some((one) => one.rows.some((row) => CONTAINER_CLIENT.test(row.command)))) memory.containers = true
      found.set(app, { memory, peakBytes: sum(up.filter((one) => one.record.kind === "process"), peakOf) + containerBytes })
    }
    const total = containerLook?.totalBytes
    return total ? { found, runtime: { totalBytes: total, usedBytes: containerLook.containers.reduce((sum, container) => sum + (container.bytes ?? 0), 0) } } : { found }
  }

  /**
   * Each process's footprint now and at its peak. A reading is kept while
   * the process's resident size stays within `FOOTPRINT_DRIFT` of what it
   * was then, for up to `FOOTPRINT_KEEP_MS`, so a steady app costs one
   * process table a look; the largest processes are read first.
   */
  private async footprintsOf(rows: Row[]): Promise<Map<number, { bytes: number; peakBytes: number }>> {
    const at = this.now()
    const identity = (row: Row) => `${row.pid}:${row.startedMs}`
    const current = new Set(rows.map(identity))
    for (const key of this.footprints.keys()) if (!current.has(key)) this.footprints.delete(key)
    const due = rows.filter((row) => {
      const kept = this.footprints.get(identity(row))
      return !kept || at - kept.at > FOOTPRINT_KEEP_MS || Math.abs(row.rssKb - kept.rssKb) > kept.rssKb * FOOTPRINT_DRIFT
    }).sort((a, b) => b.rssKb - a.rssKb).slice(0, FOOTPRINT_MAX_PIDS)
    const read = await physicalFootprints(due.map((row) => row.pid))
    for (const row of due) {
      const reading = read.get(row.pid)
      if (reading) this.footprints.set(identity(row), { ...reading, rssKb: row.rssKb, at })
    }
    return new Map(rows.flatMap((row) => {
      const kept = this.footprints.get(identity(row))
      return kept ? [[row.pid, kept] as const] : []
    }))
  }

  private async recordPeaks(project: string, seen: Seen[], at: number): Promise<void> {
    const changed = seen.filter((entry) => {
      const written = this.peaks.get(`${entry.app}:${entry.up}`)
      return !written || entry.bytes > written.bytes * PEAK_GROWTH || (!written.steady && at - entry.up >= PEAK_STEADY_MS)
    })
    if (!changed.length) return
    const peaks = await this.readPeaks(project)
    for (const entry of changed) {
      const steady = at - entry.up >= PEAK_STEADY_MS
      const current = peaks.runs.find((run) => run.app === entry.app && run.up === entry.up)
      const kept: Peaks["runs"][number] = { app: entry.app, up: entry.up, bytes: Math.max(entry.bytes, current?.bytes ?? 0), steady: steady || Boolean(current?.steady) }
      const containerBytes = Math.max(entry.containerBytes ?? 0, current?.containerBytes ?? 0)
      if (containerBytes) kept.containerBytes = containerBytes
      else if (entry.containers || current?.containers) kept.containers = true
      if (current) {
        delete current.containers
        Object.assign(current, kept)
      } else peaks.runs.push(kept)
      this.peaks.set(`${entry.app}:${entry.up}`, { bytes: kept.bytes, steady: Boolean(kept.steady) })
    }
    // Runs from before Mako read containers miss what theirs held; once one is read they say nothing true.
    if (peaks.runs.some((run) => run.containerBytes)) peaks.runs = peaks.runs.filter((run) => !run.containers)
    peaks.runs = peaks.runs.sort((a, b) => a.up - b.up).slice(-PEAK_RUNS)
    const path = this.peaksFile(project)
    await mkdir(join(this.dependencies.root, MEMORY), { recursive: true, mode: 0o700 })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(peaks), { mode: 0o600 })
    await rename(temporary, path)
  }

  private async readPeaks(project: string): Promise<Peaks> {
    const text = await readFile(this.peaksFile(project), "utf8").catch(() => undefined)
    const parsed = text === undefined ? undefined : PeaksSchema.safeParse((() => {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    })())
    return parsed?.success && parsed.data.project === project ? parsed.data : { project, runs: [] }
  }

  private peaksFile(project: string): string {
    return join(this.dependencies.root, MEMORY, `${createHash("sha256").update(project).digest("hex").slice(0, 16)}.json`)
  }

  private async projectOf(app: AppKey): Promise<string | undefined> {
    const known = this.projects.get(app)
    if (known) return known
    const text = await readFile(join(this.folder(app), "project"), "utf8").catch(() => "")
    if (text) this.projects.set(app, text)
    return text || undefined
  }

  private async upAt(app: AppKey): Promise<number | undefined> {
    const up = Number.parseInt(await readFile(join(this.folder(app), "up"), "utf8").catch(() => ""), 10)
    return Number.isFinite(up) ? up : undefined
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
    if (owner.app && owner.run) return `Port ${port} belongs to ${this.ownerName(owner, app)}.`
    return `Port ${port} is held by ${this.ownerName(owner, app)}. If you started it, stop it and try again; otherwise leave it alone and tell the user.`
  }

  /** Who a port's owner is, in a few words, as seen from `app`. */
  ownerName(owner: PortOwner, app?: AppKey): string {
    if (owner.app && owner.run) {
      const whose = owner.app === app ? "this Thread" : `the app of ${this.dependencies.whose?.(owner.app) || owner.app}`
      return `${whose}: its ${owner.run.kind} ${owner.run.name} (pid ${owner.pid})`
    }
    return `pid ${owner.pid} (${owner.command}), which Mako didn't start`
  }

  private async state(app: AppKey, key: string, record: Run, rows: Row[]): Promise<RunState> {
    if (members(rows, record).length) {
      if (record.ready !== undefined) return (await stat(this.file(app, key, "ready")).catch(() => undefined)) ? { kind: "running" } : { kind: "starting" }
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
    await rm(this.file(app, key, "ready"), { force: true })
    await rm(this.file(app, key, "unready"), { force: true })
    await rename(log, `${log}.1`).catch(() => {})
    const output = await open(log, "a", 0o600)
    let env = spec.env
    if (spec.kind === "check" && stepsOf(spec.command)) {
      const folder = this.stepsFolder(app, key)
      await mkdir(folder, { recursive: true, mode: 0o700 })
      env = { ...spec.env, [STEPS_FOLDER_VARIABLE]: folder }
    }
    try {
      const [shell, args] = spec.background ? belowAgents("/bin/sh", ["-c", WRAPPER, "mako-thread", spec.command, exit]) : ["/bin/sh", ["-c", WRAPPER, "mako-thread", spec.command, exit]]
      const child = spawn(shell, args, {
        cwd: spec.cwd,
        env: { ...env, [RUN_MARK]: app },
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
        if (spec.ready !== undefined) run.ready = spec.ready
        await record(run)
        release.end("go\n")
        if (spec.ready !== undefined) void this.watchReady(app, key, spec.ready, spec, pid)
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

  /**
   * Runs a process's readiness command until it passes, then marks it ready
   * for every host; gives up once the process is gone or another run took its place. Only the host that
   * started it knows its environment, so a start cut short by that host
   * ending stays "starting" until the app is restarted.
   */
  private async watchReady(app: AppKey, key: string, ready: string, spec: RunSpec, pid: number): Promise<void> {
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const began = this.now()
    const ours = async () => alive() && (await this.runs(app))[key]?.pid === pid
    while (await ours()) {
      const tried = await new Promise<ReadyFailure | undefined>((done) => {
        const child = spawn("/bin/sh", ["-c", ready], { cwd: spec.cwd, env: spec.env, stdio: ["ignore", "pipe", "pipe"], detached: true })
        let output = ""
        const keep = (chunk: Buffer) => {
          output = (output + chunk.toString()).slice(-READY_OUTPUT_CHARS)
        }
        child.stdout?.on("data", keep)
        child.stderr?.on("data", keep)
        const timer = setTimeout(() => {
          try {
            process.kill(-child.pid!, "SIGKILL")
          } catch {
            // Over already.
          }
        }, READY_TRY_MS)
        child.once("error", (error) => {
          clearTimeout(timer)
          done({ code: null, output: error.message })
        })
        child.once("close", (code) => {
          clearTimeout(timer)
          done(code === 0 ? undefined : { code, output })
        })
      })
      if (!tried) {
        if (await ours()) {
          await writeFile(this.file(app, key, "ready"), String(this.now()), { mode: 0o600 })
          await rm(this.file(app, key, "unready"), { force: true })
        }
        return
      }
      if (await ours()) await writeFile(this.file(app, key, "unready"), JSON.stringify(tried), { mode: 0o600 })
      await sleep(readyWait(this.now() - began))
    }
  }

  /** `steps` is the folder a check run of steps keeps each step's records in. */
  private file(app: AppKey, key: string, extension: "log" | "exit" | "ready" | "unready" | "steps"): string {
    if (!/^(process|check|prepare)-[a-z][a-z0-9-]*$/.test(key)) throw new Error(`Not a run name: ${key}`)
    return join(this.folder(app), `${key}.${extension}`)
  }

  private stepsFolder(app: AppKey, key: string): string {
    return this.file(app, key, "steps")
  }

  private logFile(app: AppKey, key: string, step: string | undefined): string {
    if (step === undefined) return this.file(app, key, "log")
    if (!/^[a-z][a-z0-9-]*$/.test(step)) throw new Error(`Not a step name: ${step}`)
    return join(this.stepsFolder(app, key), `${step}.log`)
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

/** Whether any process is left in a run's group: a signal to the group reaches its members after the leader has gone. */
function groupAlive(pid: number): boolean {
  return processExists(-pid) || processExists(pid)
}

/**
 * Each process's physical footprint, as Activity Monitor counts it, and the
 * most it has held since it started; resident sizes count shared framework
 * pages in every process, so an Electron app reads high. One `footprint` per
 * process, since one given several measures what they share, which takes
 * seconds. macOS only, and below the agents; a process it can't read is
 * left out.
 */
async function physicalFootprints(pids: number[]): Promise<Map<number, { bytes: number; peakBytes: number }>> {
  const found = new Map<number, { bytes: number; peakBytes: number }>()
  if (process.platform !== "darwin") return found
  const queue = [...pids]
  const readOne = async (pid: number) => {
    const [command, args] = belowAgents("/usr/bin/footprint", ["--noCategories", "-f", "bytes", "-p", String(pid)])
    const stdout = await run(command, args, { timeout: FOOTPRINT_MS }).then((result) => result.stdout, () => "")
    const bytes = Number(/\]: [^\n]*Footprint: (\d+) B/.exec(stdout)?.[1] ?? Number.NaN)
    const peak = Number(/phys_footprint_peak: (\d+) B/.exec(stdout)?.[1] ?? Number.NaN)
    if (Number.isFinite(bytes)) found.set(pid, { bytes, peakBytes: Number.isFinite(peak) ? Math.max(peak, bytes) : bytes })
  }
  await Promise.all(Array.from({ length: Math.min(FOOTPRINT_PARALLEL, queue.length) }, async () => {
    for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) await readOne(pid)
  }))
  return found
}

/** Memory the system could give apps now, and all it has. */
export async function freeMemory(): Promise<{ freeBytes: number; totalBytes: number } | undefined> {
  if (process.platform === "darwin") {
    const values = await run("sysctl", ["-n", "kern.memorystatus_level", "hw.memsize"]).then(({ stdout }) => stdout.trim().split("\n").map(Number), () => [])
    const [level, total] = values
    if (level === undefined || total === undefined || !Number.isFinite(level) || !Number.isFinite(total)) return undefined
    return { freeBytes: Math.round((total * level) / 100), totalBytes: total }
  }
  const text = await readFile("/proc/meminfo", "utf8").catch(() => "")
  const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)?.[1] ?? Number.NaN) * 1024
  const [freeBytes, totalBytes] = [kb("MemAvailable"), kb("MemTotal")]
  return Number.isFinite(freeBytes) && Number.isFinite(totalBytes) ? { freeBytes, totalBytes } : undefined
}

let sharedTable: Promise<Row[]> | undefined

/**
 * The process table for looks that only show or measure: one under way is
 * shared, so the Room's overview and memory look read it once. Never after
 * a spawn or a signal, which a read already under way wouldn't see.
 */
function sharedProcessTable(): Promise<Row[]> {
  sharedTable ??= processTable().finally(() => {
    sharedTable = undefined
  })
  return sharedTable
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

/**
 * The app each process's run mark names, or "" for a process whose
 * environment shows none; a process the system won't show the environment
 * of is left out. macOS shows the environment of this user's processes
 * except Apple's own programs; Linux, of this user's.
 */
async function runMarks(rows: Row[]): Promise<Map<number, string>> {
  const found = new Map<number, string>()
  if (!rows.length) return found
  const markIn = (variables: string) => new RegExp(`(?:^|\\s)${RUN_MARK}=(\\S+)`).exec(variables)?.[1] ?? ""
  if (process.platform === "linux") {
    await Promise.all(rows.map(async (row) => {
      const text = await readFile(`/proc/${row.pid}/environ`, "utf8").catch(() => undefined)
      if (text !== undefined) found.set(row.pid, markIn(text.split("\0").join(" ")))
    }))
    return found
  }
  // ps exits 1 when one of the pids has just ended; what it printed of the others still holds.
  const { stdout } = await run("ps", ["-wwE", "-o", "pid=,command=", "-p", rows.map((row) => row.pid).join(",")], {
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: PROCESS_TABLE_BYTES,
  }).catch((error) => z.object({ stdout: z.string() }).catch({ stdout: "" }).parse(error))
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+) (.*)$/.exec(line)
    const row = match && rows.find((candidate) => candidate.pid === Number(match[1]))
    if (!row || !match[2]!.startsWith(row.command)) continue
    const variables = match[2]!.slice(row.command.length)
    if (/\s[A-Za-z_][A-Za-z0-9_]*=/.test(variables)) found.set(row.pid, markIn(variables))
  }
  return found
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
