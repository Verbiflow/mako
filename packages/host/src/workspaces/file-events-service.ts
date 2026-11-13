import { hostCommand, hostProbe } from "../base/host-command.js"
import { appendFile, copyFile, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import {
  DEGRADED_LAG_MS, DEGRADED_MEMORY_BYTES, DEGRADED_SILENCE_MS, EPISODE_GAP_MS, LAG_BEATS, LAG_BEATS_NEEDED, MEMORY_READINGS_NEEDED, SAMPLE_EVERY_MS, SETTLE_MS, WORSE_BY,
  FileEventsSampleSchema, type FileEventsContext, type FileEventsMeasure, type FileEventsRestart, type FileEventsRestartStep, type FileEventsSample, type FileEventsService, type FileEventsState,
} from "../contracts/file-events-service.js"
import type { MethodTable } from "../base/methods.js"
import type { DaemonRestarts, FileHistory } from "./watch-backend.js"
import type { DeliveryListener } from "./watch-readings.js"

const execute = hostCommand

const DAY_MS = 24 * 3_600_000
/** Samples the file keeps: a week. */
const KEPT_MS = 7 * DAY_MS
/** A pid looked up this recently answers `restartedSince` without asking `ps` again. */
const PID_FRESH_MS = 1_000
/** Beats a median is said from in Diagnostics and a restart's outcome; judging waits for `LAG_BEATS_NEEDED`. */
const SHOWN_BEATS = 4
/** How long a restarted fseventsd is waited for before Mako measures it. */
const RESTARTED_WITHIN_MS = 15_000
/** What the password dialog says, under macOS's own line. */
const PROMPT = "Mako wants to restart macOS's file-change service (fseventsd). It saves what the service is doing first, for diagnosing why it slowed down."
/** Where the privileged step makes its evidence folder, `mktemp`'s template without its Xs; a folder it prints elsewhere is refused. */
const EVIDENCE_TEMPORARY = "/private/tmp/mako-fseventsd."
const EVIDENCE_FILES = ["ps.txt", "sample.txt", "vmmap.txt", "footprint.txt", "log.txt"] as const

/** fseventsd's process and the memory it holds resident, as `ps` reads it. */
export interface DaemonReading {
  pid: number
  residentBytes: number
}

/**
 * fseventsd as `ps` reads it, which needs no root: the pid known is read
 * first, so the daemon is looked up by name only once and after it restarts.
 */
export async function readFseventsd(known?: number): Promise<DaemonReading | undefined> {
  const resident = async (pid: number) => {
    const { stdout } = await hostProbe("ps", ["-o", "rss=", "-p", String(pid)], { timeout: 5_000 }).catch(() => ({ stdout: "" }))
    const kb = Number(stdout.trim())
    return stdout.trim() && Number.isFinite(kb) ? { pid, residentBytes: kb * 1024 } : undefined
  }
  if (known !== undefined) {
    const reading = await resident(known)
    if (reading) return reading
  }
  const { stdout } = await hostProbe("pgrep", ["-x", "fseventsd"], { timeout: 5_000 }).catch(() => ({ stdout: "" }))
  const pid = Number(stdout.trim().split("\n")[0])
  return Number.isInteger(pid) && pid > 0 ? resident(pid) : undefined
}

export type PrivilegedOutcome = { kind: "done"; stdout: string } | { kind: "cancelled" } | { kind: "failed"; message: string }
/** Runs `command` as root once the person allows it; `prompt` is said in the dialog. */
export type RunPrivileged = (command: string, prompt: string) => Promise<PrivilegedOutcome>

/**
 * macOS's administrator password dialog, through `osascript`: the command
 * goes in as an argument, so nothing in it is read as AppleScript.
 */
export const administratorPrompt: RunPrivileged = async (command, prompt) => {
  try {
    const { stdout } = await execute("/usr/bin/osascript", [
      "-e", "on run argv",
      "-e", "do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges",
      "-e", "end run",
      command, prompt,
    ], { timeout: 10 * 60_000, maxBuffer: 1024 * 1024 })
    return { kind: "done", stdout }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/User canceled|\(-128\)/.test(message)) return { kind: "cancelled" }
    return { kind: "failed", message: message.split("\n").filter(Boolean).at(-1) ?? message }
  }
}

/**
 * The privileged step, whole: evidence first, then the restart, which
 * launchd answers by starting fseventsd again. Root writes only into a
 * folder it makes itself, hands it to `uid` when done, and prints where it
 * is. `sample` and `vmmap --summary` show what the daemon is doing and what
 * it holds (`DefaultMallocZone` and `PathStringZone` counts); the sample's
 * `com.apple.fseventsd.client.<pid>` threads are who subscribes, including
 * processes already gone.
 */
export function restartCommand(uid: number, temporary = EVIDENCE_TEMPORARY): string {
  if (!Number.isInteger(uid) || uid < 0) throw new Error("Not a user id")
  if (!/^[A-Za-z0-9/._-]+$/.test(temporary)) throw new Error("Not a folder for the evidence")
  return [
    `out=$(/usr/bin/mktemp -d ${temporary}XXXXXX) || exit 1`,
    "pid=$(/usr/bin/pgrep -x fseventsd | /usr/bin/head -n 1)",
    "if [ -n \"$pid\" ]; then",
    "  /bin/ps -o pid,%cpu,rss,vsz,etime,time -p \"$pid\" > \"$out/ps.txt\" 2>&1",
    "  /usr/bin/sample \"$pid\" 5 -mayDie -file \"$out/sample.txt\" > /dev/null 2>&1",
    "  /usr/bin/vmmap --summary \"$pid\" > \"$out/vmmap.txt\" 2>&1",
    "  /usr/bin/footprint \"$pid\" > \"$out/footprint.txt\" 2>&1",
    "fi",
    "/usr/bin/log show --last 2h --predicate 'process == \"fseventsd\"' --info > \"$out/log.txt\" 2>&1",
    "/usr/bin/killall fseventsd",
    `/usr/sbin/chown -R ${uid} "$out"`,
    "echo \"$out\"",
  ].join("\n")
}

/** The allocation counts `vmmap --summary` lists for fseventsd's two zones: what it holds, as objects and as path strings. */
export interface ZoneCounts {
  DefaultMallocZone?: number
  PathStringZone?: number
}

export function zoneCounts(vmmap: string): ZoneCounts {
  const count = (zone: keyof ZoneCounts) => {
    const match = new RegExp(`^${zone}\\S*\\s+\\S+\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\d+)\\s`, "m").exec(vmmap)
    return match ? Number(match[1]) : undefined
  }
  const objects = count("DefaultMallocZone")
  const paths = count("PathStringZone")
  return { ...(objects !== undefined && { DefaultMallocZone: objects }), ...(paths !== undefined && { PathStringZone: paths }) }
}

/** The pids of the client threads in a `sample` of fseventsd, each once, in the order first seen. */
export function clientPids(sample: string): number[] {
  return [...new Set([...sample.matchAll(/com\.apple\.fseventsd\.client\.(\d+)/g)].map((match) => Number(match[1])))]
}

export interface FileEventsServiceDeps {
  /** Off macOS there's no fseventsd: the state stays unknown and nothing is read. */
  mac: boolean
  readDaemon(known?: number): Promise<DaemonReading | undefined>
  privileged: RunPrivileged
  /** Beats' lags measured now, for after a restart. */
  probe(): Promise<number[]>
  /** Every watch and history reader starts over with the new daemon. */
  recover(): void
  /** What Mako does now: watches and streams, children started and history reads so far, turns running. */
  activity(): { watched: number; streams: number; childStarts: number; historyReads: number; turnsRunning: number }
  emit(service: FileEventsService): void
  log(message: string, fields: Record<string, string | number | boolean>): void
  /** The rolling history, one sample a line; none in tests that keep it in memory. */
  historyFile?: string
  /** Where each restart's evidence is saved, a folder of its own each. */
  evidenceRoot: string
  /** Read across the restart, to say whether it kept what was written just before. */
  history?(): FileHistory | undefined
  uid: number
  /** `EVIDENCE_TEMPORARY` but in tests, where no root makes the folder. */
  evidenceTemporary?: string
  /** Whether other work keeps this Mac busy now: a late canary then says nothing about fseventsd. */
  machineBusy?(): Promise<boolean>
  /** Where "Not now" and the episode it was pressed in are kept, so neither is said again after a restart of the host. */
  noticeFile?: string
  now?(): number
}

/** What was degraded, and how badly, when the person said "Not now" or restarted it. */
const BaselineSchema = z.object({ lag: z.boolean(), memory: z.boolean(), lagMs: z.number().optional(), residentBytes: z.number().optional() })
type Baseline = z.infer<typeof BaselineSchema>

/** A stretch of degraded readings, until `EPISODE_GAP_MS` healthy ends it; `acknowledged` once said and answered. */
const EpisodeSchema = z.object({ since: z.number(), lastDegradedAt: z.number(), acknowledged: z.boolean(), baseline: BaselineSchema.optional() })

const NoticeStateSchema = z.object({
  episode: EpisodeSchema.optional(),
  snooze: z.object({ until: z.number(), baseline: BaselineSchema }).optional(),
})
type NoticeState = z.infer<typeof NoticeStateSchema>

/** Local midnight after `at`: "Not now" holds for the rest of the day. */
function endOfDay(at: number): number {
  const day = new Date(at)
  day.setHours(24, 0, 0, 0)
  return day.getTime()
}

/**
 * The read of fseventsd's health, for the notice and Diagnostics: the
 * canary's beats (from `WatchReadings`), the daemon's resident memory read
 * every `tick`, a rolling history sampled every `SAMPLE_EVERY_MS` and at
 * each change, and the restart. It also answers whether the daemon started
 * over since a time, for history reads (`DaemonRestarts`).
 */
export class FileEventsServiceWatch implements DeliveryListener, DaemonRestarts {
  private readonly deps: FileEventsServiceDeps
  private readonly now: () => number
  private beats: number[] = []
  private silentSince: number | undefined
  private reading: (DaemonReading & { at: number }) | undefined
  /** The daemon's pid as last seen, by this host or the one before it: another one is a restart. */
  private knownPid: number | undefined
  private pidAt = -Infinity
  private overMemory = 0
  private state: FileEventsState = "unknown"
  private degraded: FileEventsService["degraded"]
  private samples: FileEventsSample[] = []
  private lastSampleAt = -Infinity
  private lastTotals: { childStarts: number; historyReads: number } | undefined
  private wakes = 0
  /** When Mako saw fseventsd start over: a read of history from before any of these is lost. */
  private restarts: number[] = []
  private restarting: FileEventsRestartStep | undefined
  private lastRestart: FileEventsRestart | undefined
  private loaded: Promise<void> | undefined
  private looking: Promise<void> | undefined
  private busy = false
  private settlingUntil = -Infinity
  private notices: NoticeState = {}
  private restartSeen = false
  private noticed = false

  constructor(deps: FileEventsServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  beat(lagMs: number): void {
    this.beats.push(lagMs)
    if (this.beats.length > LAG_BEATS) this.beats.shift()
    this.evaluate()
  }

  delivered(ok: boolean): void {
    this.silentSince = ok ? undefined : this.silentSince ?? this.now()
    this.evaluate()
  }

  /** The Mac woke: counted into the next sample. */
  woke(): void {
    this.wakes += 1
  }

  /** Reads the daemon's memory and keeps a sample when one is due; the host runs it every minute. */
  async tick(): Promise<void> {
    if (!this.deps.mac) return
    await this.load()
    await this.look(true)
    this.busy = await this.deps.machineBusy?.().catch(() => false) ?? false
    this.evaluate()
    if (this.now() - this.lastSampleAt >= SAMPLE_EVERY_MS) await this.sample()
    if (this.state === "degraded") this.publish()
  }

  async restartedSince(ms: number): Promise<boolean> {
    if (!this.deps.mac) return false
    await this.load()
    if (this.now() - this.pidAt >= PID_FRESH_MS) await this.look(false)
    return this.restarts.some((at) => at > ms)
  }

  snapshot(): FileEventsService {
    const lagMs = this.median()
    const now = this.now()
    return {
      state: this.state,
      ...(this.degraded && { degraded: { ...this.degraded } }),
      ...(lagMs !== undefined && { lagMs, slowestMs: Math.max(...this.beats) }),
      beats: this.beats.length,
      ...(this.silentSince !== undefined && { silentMs: now - this.silentSince }),
      ...(this.reading && { pid: this.reading.pid, residentBytes: this.reading.residentBytes, readAt: this.reading.at }),
      history: this.samples.filter((sample) => sample.at >= now - DAY_MS),
      ...(this.restarting && { restarting: this.restarting }),
      ...(this.lastRestart && { restart: { ...this.lastRestart, ...(this.restartSeen && { seen: true }) } }),
      notice: this.noticeDue(),
      ...(this.notices.snooze && this.notices.snooze.until > now && { snoozedUntil: this.notices.snooze.until }),
      ...(this.settlingUntil > now && { settlingUntil: this.settlingUntil }),
      ...(this.busy && { busy: true }),
    }
  }

  /**
   * "Not now", or closing the restart's outcome: the notice isn't said again
   * this episode, nor for the rest of the day, unless a reading gets
   * `WORSE_BY` worse or degrades for another reason.
   */
  async dismiss(): Promise<FileEventsService> {
    await this.load()
    const baseline = this.baseline()
    this.notices.snooze = { until: endOfDay(this.now()), baseline }
    if (this.notices.episode) this.notices.episode = { ...this.notices.episode, acknowledged: true, baseline }
    if (this.lastRestart) this.restartSeen = true
    await this.saveNotices()
    this.publish()
    return this.snapshot()
  }

  /**
   * Restarts fseventsd through the administrator password dialog, once:
   * the evidence is captured in the same privileged step, then saved in
   * Mako's diagnostics, every watch starts over with the new daemon, and
   * delivery is measured again.
   */
  async restart(): Promise<FileEventsService> {
    if (!this.deps.mac) throw new Error("fseventsd is macOS's; there's nothing to restart here.")
    if (this.restarting) return this.snapshot()
    this.step("restarting")
    try {
      await this.restartOnce()
    } finally {
      this.restarting = undefined
      this.evaluate(true)
    }
    return this.snapshot()
  }

  private async restartOnce(): Promise<void> {
    const at = this.now()
    const before = this.measure()
    const kept = await this.markBefore()
    const outcome = await this.deps.privileged(restartCommand(this.deps.uid, this.deps.evidenceTemporary), PROMPT)
    if (outcome.kind !== "done") {
      await kept?.(false)
      this.lastRestart = { at, outcome: outcome.kind, before, ...(outcome.kind === "failed" && { message: outcome.message }) }
      this.deps.log(outcome.kind === "cancelled" ? "fseventsd restart cancelled" : "fseventsd restart failed", outcome.kind === "failed" ? { message: outcome.message } : {})
      return
    }
    const evidence = await this.saveEvidence(outcome.stdout.trim(), at, before).catch((error) => {
      this.deps.log("fseventsd evidence not saved", { message: error instanceof Error ? error.message : String(error) })
      return undefined
    })
    const restarted = await this.restartedDaemon(this.knownPid)
    const now = this.now()
    this.restarts.push(now)
    this.reading = restarted && { ...restarted, at: now }
    if (restarted) [this.knownPid, this.pidAt] = [restarted.pid, now]
    this.beats = []
    this.overMemory = 0
    this.silentSince = undefined
    this.settlingUntil = now + SETTLE_MS
    this.restartSeen = false
    this.deps.recover()
    this.step("measuring")
    const lags = await this.deps.probe().catch(() => [])
    for (const lag of lags) this.beat(lag)
    const after = { ...this.measure(), ...(lags.length && { lagMs: medianOf(lags) }) }
    // The restart answered this episode: its outcome is said instead, and only worse than after brings the notice back.
    if (this.notices.episode) {
      this.notices.episode = { ...this.notices.episode, acknowledged: true, baseline: { lag: false, memory: false, ...after } }
      await this.saveNotices()
    }
    const historyKept = await kept?.(true)
    this.lastRestart = { at, outcome: "restarted", before, after, ...(evidence && { evidence }), ...(historyKept !== undefined && { historyKept }) }
    if (evidence) await writeFile(join(evidence, "summary.json"), JSON.stringify({ ...this.lastRestart, samples: this.samples.filter((sample) => sample.at >= at - DAY_MS) }, null, 2)).catch(() => {})
    this.deps.log("fseventsd restarted", { pid: restarted?.pid ?? 0, ...numbers("before", before), ...numbers("after", after), historyKept: historyKept ?? false })
    await this.sample("restarted")
  }

  private step(step: FileEventsRestartStep): void {
    this.restarting = step
    this.publish()
  }

  private publish(): void {
    const service = this.snapshot()
    this.noticed = service.notice
    this.deps.emit(service)
  }

  /** What's degraded now and how badly, to hold "Not now" against. */
  private baseline(): Baseline {
    return { lag: this.degraded?.lag ?? false, memory: this.degraded?.memory ?? false, ...this.measure() }
  }

  /** Worse than `baseline`: degraded for a reason it wasn't, or `WORSE_BY` times the lag or memory it was. */
  private worse(baseline: Baseline | undefined): boolean {
    if (!baseline) return true
    const now = this.baseline()
    if ((now.lag && !baseline.lag) || (now.memory && !baseline.memory)) return true
    const grew = (value: number | undefined, was: number | undefined) => value !== undefined && was !== undefined && was > 0 && value >= was * WORSE_BY
    return (now.lag && grew(now.lagMs, baseline.lagMs)) || (now.memory && grew(now.residentBytes, baseline.residentBytes))
  }

  /** Whether the desk says it: degraded, once an episode, and not while "Not now" holds unless it got worse. */
  private noticeDue(): boolean {
    if (this.state !== "degraded" || this.restarting) return false
    const { episode, snooze } = this.notices
    if (episode?.acknowledged && !this.worse(episode.baseline)) return false
    if (snooze && snooze.until > this.now() && !this.worse(snooze.baseline)) return false
    return true
  }

  private async saveNotices(): Promise<void> {
    const file = this.deps.noticeFile
    if (!file) return
    await mkdir(join(file, ".."), { recursive: true }).catch(() => {})
    await writeFile(file, JSON.stringify(this.notices)).catch(() => {})
  }

  /** The median of the kept beats, said from `SHOWN_BEATS`, judged from `LAG_BEATS_NEEDED`. */
  private median(needed = SHOWN_BEATS): number | undefined {
    return this.beats.length < needed ? undefined : medianOf(this.beats)
  }

  private measure(): FileEventsMeasure {
    const lagMs = this.median()
    return { ...(lagMs !== undefined && { lagMs }), ...(this.reading && { residentBytes: this.reading.residentBytes }) }
  }

  /**
   * Degraded is memory past `DEGRADED_MEMORY_BYTES`, or a canary late past
   * `DEGRADED_LAG_MS` at the median of five minutes or unheard for three,
   * on a Mac not busy with other work and not just after a restart, when
   * only memory is judged.
   */
  private evaluate(force = false): void {
    if (!this.deps.mac) return
    const now = this.now()
    const lagMs = this.median(LAG_BEATS_NEEDED)
    const judged = now >= this.settlingUntil && !this.busy
    const silent = this.silentSince !== undefined && now - this.silentSince >= DEGRADED_SILENCE_MS
    const lag = judged && (silent || (lagMs !== undefined && lagMs > DEGRADED_LAG_MS))
    const memory = this.overMemory >= MEMORY_READINGS_NEEDED
    const state: FileEventsState = lag || memory ? "degraded" : lagMs !== undefined || this.reading ? "healthy" : "unknown"
    const changed = state !== this.state || (state === "degraded" && (this.degraded?.lag !== lag || this.degraded?.memory !== memory))
    if (state === "degraded") {
      const episode = this.notices.episode
      if (episode && now - episode.lastDegradedAt < EPISODE_GAP_MS) this.notices.episode = { ...episode, lastDegradedAt: now }
      else {
        this.notices.episode = { since: now, lastDegradedAt: now, acknowledged: false }
        void this.saveNotices()
      }
      this.degraded = { since: this.notices.episode.since, lag, memory }
    } else this.degraded = undefined
    if (state !== this.state) {
      this.deps.log(state === "degraded" ? "fseventsd is degraded" : state === "healthy" ? "fseventsd is healthy" : "fseventsd unread", {
        ...(lagMs !== undefined && { lagMs }), ...(this.reading && { residentBytes: this.reading.residentBytes, pid: this.reading.pid }), lag, memory,
      })
      this.state = state
      void this.sample("state")
    }
    if (changed || force || this.noticeDue() !== this.noticed) this.publish()
  }

  /**
   * The daemon's memory now; a new pid is a restart, Mako's or anyone's,
   * after which every watch starts over. Only the minute's look (`counted`)
   * counts toward `MEMORY_READINGS_NEEDED`.
   */
  private async look(counted: boolean): Promise<void> {
    while (this.looking) await this.looking
    this.looking = (async () => {
      const known = this.knownPid
      const reading = await this.deps.readDaemon(known).catch(() => undefined)
      if (!reading) return
      const at = this.now()
      const over = reading.residentBytes > DEGRADED_MEMORY_BYTES
      if (counted) this.overMemory = over ? this.overMemory + 1 : 0
      this.reading = { ...reading, at }
      this.knownPid = reading.pid
      this.pidAt = at
      if (known === undefined || known === reading.pid || this.restarting) return
      this.restarts.push(at)
      this.beats = []
      this.overMemory = over && counted ? 1 : 0
      this.settlingUntil = at + SETTLE_MS
      this.deps.log("fseventsd started over", { pid: reading.pid, was: known })
      this.deps.recover()
      await this.sample("restarted")
    })().finally(() => {
      this.looking = undefined
    })
    return this.looking
  }

  /** Waits for launchd's new fseventsd; undefined if none showed in time. */
  private async restartedDaemon(previous: number | undefined): Promise<DaemonReading | undefined> {
    for (const deadline = performance.now() + RESTARTED_WITHIN_MS; ; await new Promise((resolve) => setTimeout(resolve, 250))) {
      const reading = await this.deps.readDaemon().catch(() => undefined)
      if (reading && reading.pid !== previous) return reading
      if (performance.now() >= deadline) return reading
    }
  }

  /** A change written after a mark and before the restart: whether the history still has it afterwards. */
  private async markBefore(): Promise<((read: boolean) => Promise<boolean | undefined>) | undefined> {
    const history = this.deps.history?.()
    if (!history) return undefined
    const mark = await history.mark().catch(() => undefined)
    if (!mark) return undefined
    const folder = await mkdtemp(join(tmpdir(), "mako-fseventsd-kept-")).then((made) => realpath(made), () => undefined)
    if (!folder) return undefined
    const written = join(folder, "before")
    await writeFile(written, "")
    return async (read) => {
      try {
        if (!read) return undefined
        const found = await history.since(mark, [folder])
        return found.paths.includes(written)
      } catch {
        return undefined
      } finally {
        await rm(folder, { recursive: true, force: true })
      }
    }
  }

  /** The privileged step's folder, checked to be what it made and handed over, copied into Mako's diagnostics with who was subscribed. */
  private async saveEvidence(made: string, at: number, before: FileEventsMeasure): Promise<string> {
    const temporary = this.deps.evidenceTemporary ?? EVIDENCE_TEMPORARY
    if (!made.startsWith(temporary) || !/^[A-Za-z0-9]+$/.test(made.slice(temporary.length))) throw new Error(`The restart didn't say where its evidence is (${made.slice(0, 80)})`)
    const stat = await lstat(made)
    if (!stat.isDirectory() || stat.uid !== this.deps.uid) throw new Error("The evidence folder isn't the one the restart made")
    const folder = join(this.deps.evidenceRoot, `fseventsd-${new Date(at).toISOString().replace(/[:.]/g, "-")}`)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    try {
      for (const name of EVIDENCE_FILES) await copyFile(join(made, name), join(folder, name)).catch(() => {})
    } finally {
      await rm(made, { recursive: true, force: true }).catch(() => {})
    }
    const sample = await readFile(join(folder, "sample.txt"), "utf8").catch(() => "")
    const clients = await Promise.all(clientPids(sample).map(async (pid) => {
      const { stdout } = await hostProbe("ps", ["-o", "command=", "-p", String(pid)], { timeout: 5_000 }).catch(() => ({ stdout: "" }))
      return `${pid}\t${stdout.trim().split(" ")[0] || "(exited)"}`
    }))
    await writeFile(join(folder, "clients.txt"), `${clients.join("\n")}\n`)
    const zones = zoneCounts(await readFile(join(folder, "vmmap.txt"), "utf8").catch(() => ""))
    await writeFile(join(folder, "summary.json"), JSON.stringify({ at, before, zones, clients: clients.length }, null, 2))
    return folder
  }

  /** Keeps a sample, in memory for a day and in the file for a week. */
  private async sample(why?: FileEventsSample["why"]): Promise<void> {
    await this.load()
    const at = this.now()
    const lagMs = this.median()
    const activity = this.deps.activity()
    const context: FileEventsContext = {
      watched: activity.watched,
      streams: activity.streams,
      childStarts: activity.childStarts - (this.lastTotals?.childStarts ?? 0),
      historyReads: activity.historyReads - (this.lastTotals?.historyReads ?? 0),
      turnsRunning: activity.turnsRunning,
      wakes: this.wakes,
    }
    this.lastTotals = { childStarts: activity.childStarts, historyReads: activity.historyReads }
    this.wakes = 0
    const sample: FileEventsSample = {
      at,
      ...(this.reading && { pid: this.reading.pid, residentBytes: this.reading.residentBytes }),
      ...(lagMs !== undefined && { lagMs }),
      beats: this.beats.length,
      state: this.state,
      ...(why && { why }),
      context,
    }
    if (!why) this.lastSampleAt = at
    this.samples.push(sample)
    this.samples = this.samples.filter((kept) => kept.at >= at - DAY_MS)
    const file = this.deps.historyFile
    if (!file) return
    await mkdir(join(file, ".."), { recursive: true }).catch(() => {})
    await appendFile(file, `${JSON.stringify(sample)}\n`).catch(() => {})
  }

  /** The samples an earlier host kept, and the restarts among them; a file past a week is written again without the older. */
  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (this.deps.noticeFile) {
        const text = await readFile(this.deps.noticeFile, "utf8").catch(() => "")
        const notices = NoticeStateSchema.safeParse(jsonOrEmpty(text))
        if (notices.success) {
          // Beats heard before this read may have begun an episode: one the file holds within the gap is the same one.
          const kept = notices.data
          const live = this.notices.episode
          if (live && kept.episode && live.since - kept.episode.lastDegradedAt < EPISODE_GAP_MS) kept.episode = { ...kept.episode, lastDegradedAt: live.lastDegradedAt }
          else if (live) kept.episode = live
          this.notices = { ...kept, ...(!kept.snooze && this.notices.snooze && { snooze: this.notices.snooze }) }
        }
      }
      const file = this.deps.historyFile
      if (!file) return
      const text = await readFile(file, "utf8").catch(() => "")
      const cutoff = this.now() - KEPT_MS
      const lines = text.split("\n").filter(Boolean)
      const kept: FileEventsSample[] = []
      for (const line of lines) {
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // A line cut short by a host that stopped mid-write.
          continue
        }
        const sample = FileEventsSampleSchema.safeParse(parsed)
        if (sample.success && sample.data.at >= cutoff) kept.push(sample.data)
      }
      // A restart is wherever the pid changed from one sample to the next.
      for (let index = 1; index < kept.length; index++)
        if (kept[index]!.pid !== undefined && kept[index - 1]!.pid !== undefined && kept[index]!.pid !== kept[index - 1]!.pid) this.restarts.push(kept[index]!.at)
      this.samples = [...kept.filter((sample) => sample.at >= this.now() - DAY_MS), ...this.samples]
      // A daemon that started over while no host ran is a restart too, found at the first look.
      this.knownPid ??= [...kept].reverse().find((sample) => sample.pid !== undefined)?.pid
      if (kept.length < lines.length) await writeFile(file, kept.map((sample) => `${JSON.stringify(sample)}\n`).join("")).catch(() => {})
    })()
    return this.loaded
  }
}

/** fseventsd's health as it stands (`mako:file-events-service`), and the restart (`mako:file-events-restart`), which asks for the password. */
export function declareFileEventsMethods(methods: MethodTable, service: FileEventsServiceWatch): void {
  methods.handle("mako:file-events-service", () => service.snapshot())
  methods.handle("mako:file-events-restart", () => service.restart())
  methods.handle("mako:file-events-dismiss", () => service.dismiss())
}

/** A file's JSON, or an empty object for one that's missing or cut short. */
function jsonOrEmpty(text: string) {
  try {
    return text ? JSON.parse(text) : {}
  } catch {
    return {}
  }
}

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = sorted.length / 2
  return Math.round(sorted.length % 2 ? sorted[Math.floor(middle)]! : (sorted[middle - 1]! + sorted[middle]!) / 2)
}

function numbers(prefix: "before" | "after", measure: FileEventsMeasure) {
  return { ...(measure.lagMs !== undefined && { [`${prefix}LagMs`]: measure.lagMs }), ...(measure.residentBytes !== undefined && { [`${prefix}Bytes`]: measure.residentBytes }) }
}
