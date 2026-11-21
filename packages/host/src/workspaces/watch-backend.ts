import { hostStopping } from "../base/host-stopping.js"
import { hostCommand, hostFork } from "../base/host-command.js"
import type { JobDemand } from "../base/host-jobs.js"
import type { HostProbes, ProbeOptions, RunningCommand } from "../base/host-stopping.js"
import type { ChildProcess } from "node:child_process"
import { z } from "zod"
import { existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { SLOW_DELIVERY_MS, WatcherReplySchema, type DropReason, type HistoryMark, type WatchEvent, type WatcherReply, type WatcherRequest, type NativeWatch } from "../contracts/watcher-child.js"
import { headlessNodeExecutable } from "../base/headless-node.js"
import { onLinux, onMac } from "../base/platform.js"
import { WatchReadings, type ChildStart } from "./watch-readings.js"
import type { Row, RunLeader } from "./process-table.js"
import { sendToChild } from "@mako/sessions/child-input"

export interface WatchListener {
  events(events: readonly WatchEvent[]): void
  /** Events were dropped (by whom, where the system says) or missed while the child restarted: anything under the root may have changed. */
  dropped(reason?: DropReason | "restarted"): void
  /** The watch stopped for good, such as its root going away. */
  gone(): void
  /** Nothing is being delivered, though the watch stands (true), or delivery is back (false). */
  muted(muted: boolean): void
  /** Events come later than `SLOW_DELIVERY_MS` (true), or on time again (false). */
  late?(late: boolean): void
}

export interface WatchSubscription {
  unsubscribe(): Promise<void>
}

/** Settles once the root is watched; rejects when it can't be. */
export type WatchBackend = (root: string, ignore: readonly string[], listener: WatchListener, native?: NativeWatch) => Promise<WatchSubscription>

/**
 * The host's backend: every watch in one child, which `recover` starts again once fseventsd has, so every watch hears
 * `dropped` and rescans; and told how far behind each poll that stands in for it runs (`paced`, `WatchReadings`).
 */
export type ChildWatchBackend = WatchBackend & { recover(): void; paced(poll: symbol, spacingMs: number | undefined): void }

type ParcelCallback = (error: Error | null, events: WatchEvent[]) => void
type ParcelSubscribe = (root: string, callback: ParcelCallback, options: { ignore: string[] }) => Promise<WatchSubscription>

/** A backend that calls `subscribe` in this process, as the watcher child does; tests pass a fake. */
export function parcelBackend(subscribe: ParcelSubscribe): WatchBackend {
  return (root, ignore, listener, native) => native
    ? Promise.reject(new Error("Native watches require the watcher child."))
    : subscribe(root, (error, events) => (error ? listener.dropped() : listener.events(events)), { ignore: [...ignore] })
}

/** No watch for this long lets the child go; the next one starts it again. */
const IDLE_MS = 30_000
/** Callers bound their own waits; keep a slow child's late subscription owned until this final deadline. */
const READY_MS = 30_000
/** A child that ran this long without crashing resets the backoff. */
const STABLE_MS = 60_000
/** Crashes in a row, each before `STABLE_MS`, after which every watch is given up. */
const MAX_CRASHES = 5
/**
 * A silence restarts the child at most this often. A restart ends a parcel
 * deadlock; a silence soon after one is fseventsd's, which restarting the
 * child only answers with every stream registered again and every root
 * rescanned. Restarting fseventsd itself is what ends that, offered by
 * `file-events-service.ts`.
 */
const RECYCLE_EVERY_MS = 10 * 60_000

interface ChildWatch {
  root: string
  ignore: string[]
  native?: NativeWatch
  listener: WatchListener
  /** Set until the first subscribe settles; a later "ready" follows a restart. */
  pending?: { resolve(): void; reject(error: Error): void }
  readyTimer?: NodeJS.Timeout
}

/**
 * Every watch in one child process running @parcel/watcher. A crash there
 * restarts it with backoff and subscribes every watch again, each hearing
 * `dropped` since events were missed in between; a watch whose root can't
 * be subscribed again hears `gone`.
 *
 * When the child's canary goes unheard every watch hears `muted`, and the
 * child is restarted once, which ends a deadlock inside parcel, unless a
 * silence restarted it within `RECYCLE_EVERY_MS`. A silent fseventsd
 * outlives the restart; the watches stay muted until a canary is heard
 * again. A canary heard later than `SLOW_DELIVERY_MS` tells every watch it's
 * `late`. `readings` hears all of it, each beat too, for the log,
 * Diagnostics and the read of fseventsd's health. `recover` restarts the
 * child after fseventsd started over: every watch hears `dropped`.
 */
export function childBackend(script = defaultChildScript(), readings = new WatchReadings()): ChildWatchBackend {
  const stopping = hostStopping()?.signal
  const watches = new Map<number, ChildWatch>()
  let child: ChildProcess | undefined
  let startedAt = 0
  let crashes = 0
  let nextId = 1
  let idle: NodeJS.Timeout | undefined
  let restart: NodeJS.Timeout | undefined
  let muted = false
  let late = false
  /** This silence already cost the child one restart. */
  let recycled = false
  let recycledAt = -Infinity
  /** Children this backend ended itself, and why, for the line their exit writes. */
  const ended = new WeakMap<ChildProcess, "idle" | "silence" | "recovery">()

  const post = (request: WatcherRequest) => {
    // A child gone as it's told ends as its `exit` says, and the next watch starts another.
    if (child) sendToChild(child, request).catch(() => {})
  }

  // Like a watch in this process, a watch keeps the process alive; an idle child doesn't.
  const hold = (held: boolean) => {
    if (held) {
      child?.ref()
      child?.channel?.ref()
    } else {
      child?.unref()
      child?.channel?.unref()
    }
  }

  // Native Git markers were persistent:false. Pending readiness and all other watches still hold their caller.
  const keepsAlive = () => {
    for (const watch of watches.values()) if (watch.pending || watch.native?.kind !== "git-markers") return true
    return false
  }

  const forget = (id: number) => {
    const watch = watches.get(id)
    if (!watches.delete(id)) return
    clearTimeout(watch?.readyTimer)
    readings.unwatched(id)
    post({ t: "unsub", id })
    hold(keepsAlive())
    if (watches.size) return
    clearTimeout(idle)
    idle = setTimeout(() => {
      if (watches.size || !child) return
      const going = child
      child = undefined
      muted = false
      recycled = false
      ended.set(going, "idle")
      going.kill()
    }, IDLE_MS)
    idle.unref()
  }

  const limitReadiness = (id: number, watch: ChildWatch) => {
    // A restart cannot extend the first deadline; an already-ready watch gets a new bound for recovery.
    if (watch.readyTimer) return
    const timer = setTimeout(() => {
      if (watches.get(id) !== watch || watch.readyTimer !== timer) return
      forget(id)
      watch.pending?.reject(new Error("The file watcher did not become ready in time"))
      watch.listener.gone()
    }, READY_MS)
    watch.readyTimer = timer
  }

  const onDelivery = (ok: boolean, lagMs: number | undefined) => {
    readings.delivered(ok, lagMs)
    if (ok) recycled = false
    if (ok && lagMs !== undefined && lagMs > SLOW_DELIVERY_MS !== late) {
      late = !late
      for (const watch of watches.values()) if (!watch.pending) watch.listener.late?.(late)
    }
    if (muted !== ok) return
    muted = !ok
    for (const watch of watches.values()) if (!watch.pending) watch.listener.muted(muted)
    if (muted && !recycled && child && Date.now() - recycledAt >= RECYCLE_EVERY_MS) {
      recycled = true
      recycledAt = Date.now()
      const stuck = child
      child = undefined
      ended.set(stuck, "silence")
      stuck.kill()
      start("silence")
    }
  }

  const onReply = (reply: WatcherReply) => {
    if (reply.t === "delivery") return onDelivery(reply.ok, reply.lagMs)
    if (reply.t === "beat") return readings.beat(reply.lagMs)
    if (!("id" in reply)) return
    const watch = watches.get(reply.id)
    if (!watch) return
    switch (reply.t) {
      case "ready": {
        const pending = watch.pending
        clearTimeout(watch.readyTimer)
        watch.readyTimer = undefined
        watch.pending = undefined
        if (pending) {
          pending.resolve()
          if (muted) watch.listener.muted(true)
          if (late) watch.listener.late?.(true)
        } else watch.listener.dropped("restarted")
        hold(keepsAlive())
        return
      }
      case "failed":
        forget(reply.id)
        if (watch.pending) watch.pending.reject(new Error(reply.message))
        else watch.listener.gone()
        return
      case "events":
        readings.heard(reply.events.length)
        watch.listener.events(reply.events)
        return
      case "dropped":
        readings.dropped(watch.root, reply.reason)
        watch.listener.dropped(reply.reason)
        return
    }
  }

  const giveUp = () => {
    clearTimeout(restart)
    restart = undefined
    const lost = [...watches.values()]
    for (const id of watches.keys()) forget(id)
    crashes = 0
    for (const watch of lost) {
      if (watch.pending) watch.pending.reject(new Error("The file watcher keeps stopping"))
      else watch.listener.gone()
    }
  }

  stopping?.addEventListener("abort", giveUp, { once: true })

  const lost = (gone: ChildProcess) => {
    if (child !== gone) return
    child = undefined
    if (!watches.size) return
    if (stopping?.aborted) return giveUp()
    crashes = Date.now() - startedAt >= STABLE_MS ? 1 : crashes + 1
    if (crashes >= MAX_CRASHES) return giveUp()
    restart = setTimeout(() => {
      restart = undefined
      if (watches.size) {
        try { start("crash") } catch { giveUp() }
      }
    }, 250 * 2 ** (crashes - 1))
  }

  const start = (why: ChildStart) => {
    const next = hostFork(script, ["watch"], {
      execPath: headlessNodeExecutable(),
      // Under tsx (tests, development scripts) the child needs its loader to run TypeScript.
      execArgv: script.endsWith(".ts") ? process.execArgv : [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    child = next
    startedAt = Date.now()
    readings.started(next.pid, why)
    next.on("message", (raw) => {
      if (child !== next || stopping?.aborted) return
      const reply = WatcherReplySchema.safeParse(raw)
      if (reply.success) onReply(reply.data)
    })
    next.once("exit", (code, signal) => {
      readings.stopped(next.pid, code, signal, ended.get(next) ?? "exit")
      lost(next)
    })
    next.once("error", () => lost(next))
    for (const [id, watch] of watches) {
      limitReadiness(id, watch)
      post({ t: "sub", id, root: watch.root, ignore: watch.ignore, ...watch.native && { native: watch.native } })
    }
    hold(keepsAlive())
  }

  const backend: WatchBackend = (root, ignore, listener, native) => {
    if (stopping?.aborted) return Promise.reject(stopping.reason)
    clearTimeout(idle)
    const id = nextId++
    return new Promise<WatchSubscription>((resolve, reject) => {
      const unsubscribe = async () => forget(id)
      const watch = { root, ignore: [...ignore], ...native && { native }, listener, pending: { resolve: () => resolve({ unsubscribe }), reject } }
      watches.set(id, watch)
      limitReadiness(id, watch)
      readings.watched(id, root, ignore)
      try {
        if (child) {
          hold(true)
          post({ t: "sub", id, root, ignore: [...ignore], ...native && { native } })
        } else if (!restart) start("first")
      } catch (error) {
        forget(id)
        reject(error)
      }
    })
  }
  // Streams registered with the fseventsd that's gone may never hear again: a new child registers each with the new one.
  const recover = () => {
    if (stopping?.aborted) { giveUp(); return }
    if (!child || !watches.size) return
    const stale = child
    child = undefined
    ended.set(stale, "recovery")
    stale.kill()
    try { start("recovery") } catch { giveUp() }
  }
  return Object.assign(backend, { recover, paced: (poll: symbol, spacingMs: number | undefined) => readings.paced(poll, spacingMs) })
}

/** What changed on disk in a stretch of time, from the file system's own history. */
export interface HistoryOptions {
  ignore?: readonly string[]
  exclude?: readonly string[]
  /** At most this many paths of each folder one level into a root; a folder that had more is named in `capped`. */
  perFolder?: number
}

export interface HistoryRead {
  paths: string[]
  lost: string[]
  ignored: number[]
  /** With `perFolder`: the folders that had more paths than were sent. */
  capped?: string[]
}

export interface FileHistory {
  /** Where the history stands now. */
  mark(): Promise<HistoryMark>
  /**
   * Every path under `roots` changed after `mark` and before the call,
   * however far the system's history runs behind; `lost` roots had events
   * dropped, so theirs may be incomplete. Paths in or under an `ignore`
   * folder are left out in the reader and counted per folder in `ignored`;
   * paths under an `exclude` folder inside a root are never read at all.
   */
  since(mark: HistoryMark, roots: readonly string[], options?: HistoryOptions): Promise<HistoryRead>
  /** fseventsd started over: reads under way end, reported as failed, and the next starts a reader afresh. */
  recover?(): void
}

/**
 * Whether fseventsd started over since a time, as the host has seen its
 * process id change (`file-events-service.ts`). A read of history across a
 * restart may miss what the daemon held but hadn't written, so every root
 * of it is reported lost. Each answer looks at the daemon again first.
 */
export interface DaemonRestarts {
  restartedSince(ms: number): Promise<boolean>
}

/** A mark's time, parcel's nanoseconds of wall-clock time, in milliseconds. */
export function markMs(mark: HistoryMark): number {
  return Number(BigInt(mark.at) / 1_000_000n)
}

/** A mark is asked for on the way to starting an app, so it waits less than a read of history. */
const MARK_MS = 3_000
/** A read of history this long is stuck, not slow: fseventsd has stopped answering. */
const HISTORY_MS = 120_000
/** A native history wait can stop Node exiting even after SIGTERM; only an actual exit ends retirement. */
const HISTORY_EXIT_GRACE_MS = 500

/**
 * The file system's history, read in a watcher child of its own: a read
 * holds parcel's FSEvents lock until the system has replayed everything
 * since the mark, which would stall every watch sharing the child, and a
 * stuck read is ended by killing this child alone. Each request that runs
 * out of time ends the child and every request in it; the next starts one.
 * A read whose mark is from before fseventsd last started over (`daemon`)
 * reports every root lost, whatever it found. The child goes after `idleMs`
 * without an ask, or after `kept.idleMs` while `kept.while` is on (someone may ask again soon, and a child started for
 * the ask would answer later); the next ask starts one again. A mark is the system's own position, so a child gone
 * loses none.
 */
export function childHistory(script = defaultChildScript(), readings = new WatchReadings(), daemon?: DaemonRestarts, idleMs = IDLE_MS, { kept, role = "history" }: { kept?: { idleMs: number; while: Pick<JobDemand, "on" | "onChange"> }; role?: string } = {}): FileHistory {
  let child: ChildProcess | undefined
  let nextId = 1
  let idle: NodeJS.Timeout | undefined
  const pending = new Map<number, { child: ChildProcess; settle(reply: WatcherReply): void; fail(error: Error): void; timer: NodeJS.Timeout }>()
  const ending = new WeakSet<ChildProcess>()

  const end = (gone: ChildProcess, error: Error) => {
    if (child === gone) { child = undefined; clearTimeout(idle) }
    if (gone.pid !== undefined && gone.exitCode === null && gone.signalCode === null && !ending.has(gone)) {
      ending.add(gone)
      // Even an idle, unref'd child belongs to this host until it has really exited.
      gone.ref()
      const force = setTimeout(() => {
        if (gone.exitCode === null && gone.signalCode === null) gone.kill("SIGKILL")
      }, HISTORY_EXIT_GRACE_MS)
      gone.once("exit", () => clearTimeout(force))
      gone.kill("SIGTERM")
    }
    for (const [id, request] of pending) {
      if (request.child !== gone) continue
      pending.delete(id)
      clearTimeout(request.timer)
      request.fail(error)
    }
  }

  const running = () => {
    clearTimeout(idle)
    if (child) return child
    const next = hostFork(script, [role], {
      execPath: headlessNodeExecutable(),
      execArgv: script.endsWith(".ts") ? process.execArgv : [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    child = next
    readings.historyReader(next.pid)
    next.once("exit", () => {
      if (!child || child === next) readings.historyReader(undefined)
    })
    next.on("message", (raw) => {
      const reply = WatcherReplySchema.safeParse(raw)
      if (!reply.success || !("id" in reply.data)) return
      const request = pending.get(reply.data.id)
      if (!request) return
      pending.delete(reply.data.id)
      clearTimeout(request.timer)
      request.settle(reply.data)
      if (![...pending.values()].some((other) => other.child === next)) rest()
    })
    next.once("exit", () => end(next, new Error("The file system's history reader stopped")))
    next.once("error", (error) => end(next, error))
    return next
  }

  const rest = () => {
    child?.unref()
    child?.channel?.unref()
    clearTimeout(idle)
    idle = setTimeout(() => {
      if (pending.size || !child) return
      end(child, new Error("The file system's history reader was idle"))
    }, kept?.while.on ? kept.idleMs : idleMs)
    idle.unref()
  }
  // A child resting on the long wait when nobody may ask soon any more goes after the short one, and the other way.
  kept?.while.onChange(() => {
    if (child && !pending.size) rest()
  })

  const ask = (request: WatcherRequest, ms: number) =>
    new Promise<WatcherReply>((settle, fail) => {
      const current = running()
      current.ref()
      current.channel?.ref()
      const timer = setTimeout(afterReplies(() => pending.has(request.id), () => end(current, new Error(`The file system's history didn't answer within ${Math.round(ms / 1000)} seconds`)), ms), ms)
      pending.set(request.id, { child: current, settle, fail, timer })
      sendToChild(current, request).catch((error: Error) => end(current, error))
    })

  const failed = (reply: WatcherReply) => new Error(reply.t === "failed" ? reply.message : `Unexpected reply ${reply.t}`)

  return {
    async mark() {
      if (!onMac()) throw new Error("The file system's history is read through FSEvents, on macOS only.")
      // Looked at beside the mark, not before it: a turn's checkpoint waits on the mark, and on a busy Mac the `ps`
      // this spawns took seconds, past the checkpoint's wait for history, so every send captured afresh. A restart
      // found only after the mark is dated when it was found, so a later read counts it as after the mark and reports
      // its roots lost: a whole capture, never a missed change.
      void daemon?.restartedSince(Date.now()).catch(() => false)
      const reply = await ask({ t: "mark", id: nextId++ }, MARK_MS)
      if (reply.t !== "marked") throw failed(reply)
      return reply.mark
    },
    async since(mark, roots, options) {
      const asked = performance.now()
      const reply = await ask(
        { t: "since", id: nextId++, mark, roots: [...roots], ignore: [...(options?.ignore ?? [])], exclude: [...(options?.exclude ?? [])], ...(options?.perFolder !== undefined && { perFolder: options.perFolder }) },
        HISTORY_MS,
      )
      if (reply.t !== "history") throw failed(reply)
      readings.historyRead(performance.now() - asked, reply.paths.length + (reply.unsent ?? 0) + reply.ignored.reduce((sum, count) => sum + count, 0), { caughtUpMs: reply.caughtUpMs, readMs: reply.readMs })
      const crossed = daemon ? await daemon.restartedSince(markMs(mark)).catch(() => false) : false
      return { paths: reply.paths, lost: crossed ? roots.filter((root) => existsSync(root)) : reply.lost, ignored: reply.ignored, ...(reply.capped && { capped: reply.capped }) }
    },
    recover() {
      if (child) end(child, new Error("macOS's file-change service started over during the read"))
    },
  }
}

/**
 * A deadline's action, taken only if `waiting` still holds once the replies the child sent in time have been read. A
 * timer that comes due while the host's loop is held fires before the loop reads what the child sent meanwhile, and a
 * reply as long as the process table comes over the channel a piece at a time: it ended a child that had answered in
 * time. A timer firing more than `LATE_MS` after its deadline gives the reply `GRACE_MS` of a running loop first.
 */
function afterReplies(waiting: () => boolean, overdue: () => void, waitMs: number): () => void {
  const dueAt = performance.now() + waitMs
  return () => setImmediate(() => {
    if (!waiting()) return
    if (performance.now() - dueAt < LATE_MS) return overdue()
    setTimeout(() => {
      if (waiting()) overdue()
    }, GRACE_MS).unref()
  })
}
/** A deadline's timer this late was held by the host's loop, not waiting on the child. */
const LATE_MS = 250
/** What a late deadline gives the reply to arrive over a running loop. */
const GRACE_MS = 2_000

/** One read of the process names serves every probe that asks within this long: the activity engine asks for each harness at once. */
const NAMES_FRESH_MS = 2_000

/**
 * Every process's `comm` on Linux, the name `lsof -c` matches there, and the start of its command line: files read,
 * no process started. Undefined if /proc can't be read.
 */
async function procCommands(): Promise<RunningCommand[] | undefined> {
  try {
    const pids = (await readdir("/proc")).filter((entry) => /^\d+$/.test(entry))
    const read = await Promise.all(pids.map(async (pid): Promise<RunningCommand | undefined> => {
      try {
        const [comm, cmdline] = await Promise.all([readFile(`/proc/${pid}/comm`, "utf8"), readFile(`/proc/${pid}/cmdline`, "utf8")])
        return { comm: comm.trimEnd(), args: cmdline.slice(0, ARGS_CHARS).replaceAll("\0", " ").trimEnd() }
      } catch {
        return undefined
      }
    }))
    return read.filter((command) => command !== undefined)
  } catch {
    return undefined
  }
}
/** As much of a command line as a probe matches against: the program and its first arguments. */
const ARGS_CHARS = 1_024

/** `ps` for every process's name and command line on a Mac, and how many bytes of a name it prints (the kernel's `p_comm`). */
const MAC_NAMES_ARGS = ["-Axo", "ucomm=,args="] as const
const MAC_NAME_BYTES = 16

/**
 * Every process's name and command line as a Mac's `ps -Axo ucomm=,args=` printed them: the name fills a column of
 * `MAC_NAME_BYTES`, and one that fills it whole may be the start of a longer name, which `lsof -c` would match in full.
 */
export function macCommands(printed: string): RunningCommand[] {
  return printed.split("\n").flatMap((line): RunningCommand[] => {
    const comm = line.slice(0, MAC_NAME_BYTES).trimEnd()
    if (!comm) return []
    const command: RunningCommand = { comm, args: line.slice(MAC_NAME_BYTES + 1, MAC_NAME_BYTES + 1 + ARGS_CHARS).trimEnd() }
    if (Buffer.byteLength(comm) >= MAC_NAME_BYTES) command.cut = true
    return [command]
  })
}

/** At most this much of `ps`'s names and command lines. */
const TABLE_OUTPUT_BYTES = 16 * 1024 * 1024

/**
 * No ask for this long lets the probes' child go. Longer than the half minute between looks at harnesses with nothing
 * open (`IDLE_POLL_MS`): on a Mac each look is one `ps` here, and at the same half minute the child went a moment
 * before every look, which then started another.
 */
const PROBES_IDLE_MS = 45_000

/** A table this late means the child is stuck; it's ended and the caller reads its own. */
const TABLE_ASK_MS = 20_000

/** The process table read off the host's loop (`childProcessReader`), and the host's probes run there. */
export interface ProcessReader extends HostProbes {
  /** Every process, as `ps` prints it. */
  table(): Promise<string>
  /** Only the processes of `runs`, parsed and matched in the child (`membersOnly`); `self` is the host. */
  members(runs: RunLeader[], self: number): Promise<Row[]>
}

/**
 * The process table read in a watcher child of its own, so `ps`'s spawn and its wait leave the host's loop: what
 * reads the apps' marks and traces asks every few seconds while an app runs, and on a busy Mac one spawn from the
 * host's thread held it for seconds. `members` leaves the parsing and matching there too, and sends back only the
 * rows the runs asked about. The child starts at the first ask and goes after `PROBES_IDLE_MS` without one; one that
 * doesn't answer in time is ended with what it had, and the next ask starts another.
 */
export function childProcessReader(script = defaultChildScript(), askMs = TABLE_ASK_MS): ProcessReader {
  let child: ChildProcess | undefined
  let nextId = 1
  let idle: NodeJS.Timeout | undefined
  const pending = new Map<number, { child: ChildProcess; settle(reply: WatcherReply): void; fail(error: Error): void; timer: NodeJS.Timeout }>()

  const end = (gone: ChildProcess, error: Error) => {
    if (child === gone) child = undefined
    gone.kill()
    for (const [id, request] of pending) {
      if (request.child !== gone) continue
      pending.delete(id)
      clearTimeout(request.timer)
      request.fail(error)
    }
  }

  const rest = (current: ChildProcess) => {
    current.unref()
    current.channel?.unref()
    clearTimeout(idle)
    idle = setTimeout(() => {
      if (pending.size || child !== current) return
      child = undefined
      current.kill()
    }, PROBES_IDLE_MS)
    idle.unref()
  }

  const running = () => {
    clearTimeout(idle)
    if (child) return child
    const next = hostFork(script, ["probes"], {
      execPath: headlessNodeExecutable(),
      execArgv: script.endsWith(".ts") ? process.execArgv : [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    child = next
    next.on("message", (raw) => {
      const reply = WatcherReplySchema.safeParse(raw)
      if (!reply.success || !("id" in reply.data)) return
      const request = pending.get(reply.data.id)
      if (!request) return
      pending.delete(reply.data.id)
      clearTimeout(request.timer)
      if (reply.data.t === "failed") request.fail(new Error(reply.data.message))
      else request.settle(reply.data)
      if (![...pending.values()].some((other) => other.child === next)) rest(next)
    })
    next.once("exit", () => end(next, new Error("The process table's reader stopped")))
    next.once("error", (error) => end(next, error))
    return next
  }

  const ask = (request: (id: number) => WatcherRequest, waitMs = askMs) => new Promise<WatcherReply>((settle, fail) => {
    const current = running()
    current.ref()
    current.channel?.ref()
    const id = nextId++
    const timer = setTimeout(afterReplies(() => pending.has(id), () => end(current, new Error(`The process table's reader didn't answer within ${Math.round(waitMs / 1000)} seconds`)), waitMs), waitMs)
    pending.set(id, { child: current, settle, fail, timer })
    sendToChild(current, request(id)).catch((error: Error) => end(current, error))
  })
  const unexpected = (reply: WatcherReply) => new Error(`Unexpected reply ${reply.t}`)

  /** A probe in the child, answered as `hostCommand` answers; one the child can't run is run here. */
  const run = (file: string, args: readonly string[], options: ProbeOptions): Promise<{ stdout: string; stderr: string }> => {
    options.signal?.throwIfAborted()
    let asked: number | undefined
    const answered = ask((id) => {
      asked = id
      const request: WatcherRequest = { t: "run", id, file, args: [...args] }
      if (options.env) request.env = Object.fromEntries(Object.entries(options.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
      if (options.cwd !== undefined) request.cwd = options.cwd
      if (options.timeout !== undefined) request.timeout = options.timeout
      if (options.maxBuffer !== undefined) request.maxBuffer = options.maxBuffer
      return request
    }, (options.timeout ?? 0) + askMs)
    const command = `${file} ${args.join(" ")}`
    const result = answered.then((reply) => {
      if (reply.t !== "ran") throw unexpected(reply)
      if (reply.code === 0) return { stdout: reply.stdout, stderr: reply.stderr }
      const failed = new Error(reply.failure?.message ?? `Command failed: ${command}\n${reply.stderr}`)
      throw Object.assign(failed, { cmd: command, code: reply.failure?.code ?? reply.code ?? undefined, signal: reply.signal ?? undefined, killed: reply.killed, stdout: reply.stdout, stderr: reply.stderr })
    }, (error: Error) => {
      // The child couldn't take it (gone, stuck, refused): run it here, as it was before there was a child.
      if (options.signal?.aborted) throw options.signal.reason
      if (error.message.startsWith("Not a probe")) throw error
      return hostCommand(file, args, options)
    })
    if (!options.signal) return result
    const signal = options.signal
    const abort = () => {
      if (asked !== undefined && child) sendToChild(child, { t: "cancel", id: asked }).catch(() => {})
    }
    signal.addEventListener("abort", abort, { once: true })
    return Promise.race([result, new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason)
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true })
    })]).finally(() => signal.removeEventListener("abort", abort))
  }

  // Start times asked for in one turn, read by one `ps` (`startedAt`).
  let starts: Map<number, { settle(at: number): void; fail(error: Error): void }[]> | undefined
  const readStarts = async (asked: Map<number, { settle(at: number): void; fail(error: Error): void }[]>) => {
    const unreadable = () => new Error("Process start time is unreadable")
    const stdout = await (async () => {
      try {
        return (await run("ps", ["-o", "pid=,lstart=", "-p", [...asked.keys()].join(",")], { env: { ...process.env, LC_ALL: "C" }, maxBuffer: 1024 * 1024, timeout: 5_000 })).stdout
      } catch (error) {
        // ps exits 1 when any pid has ended; the rest it printed still hold.
        const printed = z.object({ code: z.literal(1), stdout: z.string() }).safeParse(error)
        if (printed.success) return printed.data.stdout
        const failure = error instanceof Error ? error : unreadable()
        for (const waiting of asked.values()) for (const one of waiting) one.fail(failure)
        return ""
      }
    })()
    const read = new Map<number, number>()
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      const at = match ? Date.parse(match[2]!.trim()) : Number.NaN
      if (match && Number.isFinite(at)) read.set(Number(match[1]), at)
    }
    for (const [pid, waiting] of asked) {
      const at = read.get(pid)
      for (const one of waiting) {
        if (at === undefined) one.fail(unreadable())
        else one.settle(at)
      }
    }
  }

  // Each process's command name, read once for every probe asking within `NAMES_FRESH_MS` (`HostProbes.commands`).
  let names: { at: number; read: Promise<RunningCommand[] | undefined> } | undefined
  const commands = (): Promise<RunningCommand[] | undefined> => {
    if (!onLinux() && !onMac()) return Promise.resolve(undefined)
    const now = performance.now()
    if (names && now - names.at < NAMES_FRESH_MS) return names.read
    // A Mac has no /proc: one `ps` in the child says every name, where each harness's `lsof` or `pgrep` was asked.
    const read = onLinux() ? procCommands() : run("ps", MAC_NAMES_ARGS, { env: { ...process.env, LC_ALL: "C" }, maxBuffer: TABLE_OUTPUT_BYTES, timeout: 5_000 })
      .then(({ stdout }) => macCommands(stdout), () => undefined)
    names = { at: now, read }
    return names.read
  }

  return {
    run,
    commands,
    startedAt: (pid, signal) => new Promise<number>((settle, fail) => {
      signal?.throwIfAborted()
      if (!starts) {
        const batch = new Map<number, { settle(at: number): void; fail(error: Error): void }[]>()
        starts = batch
        setImmediate(() => {
          if (starts === batch) starts = undefined
          void readStarts(batch)
        })
      }
      starts.set(pid, [...starts.get(pid) ?? [], { settle, fail }])
    }),
    table: () => ask((id) => ({ t: "table", id })).then((reply) => {
      if (reply.t === "table") return reply.text
      throw unexpected(reply)
    }),
    members: (runs, self) => ask((id) => ({ t: "members", id, self, runs: runs.map(({ pid, startedMs }) => ({ pid, startedMs })) })).then((reply) => {
      if (reply.t === "members") return reply.rows
      throw unexpected(reply)
    }),
  }
}

/**
 * Delivery measured now, in a child of its own that ends with it: how late
 * `beats` writes to a fresh folder are heard, one after another. Empty when
 * none was heard, or the child couldn't run.
 */
export function probeDelivery(script = defaultChildScript(), beats = 5): Promise<number[]> {
  return new Promise((settle) => {
    const child = hostFork(script, ["delivery"], {
      execPath: headlessNodeExecutable(),
      execArgv: script.endsWith(".ts") ? process.execArgv : [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    const done = (lags: number[]) => {
      clearTimeout(timer)
      child.kill()
      settle(lags)
    }
    const timer = setTimeout(() => done([]), beats * 11_000 + 5_000)
    child.on("message", (raw) => {
      const reply = WatcherReplySchema.safeParse(raw)
      if (reply.success && reply.data.t === "probed") done(reply.data.lagsMs)
      else if (reply.success && reply.data.t === "failed") done([])
    })
    child.once("exit", () => done([]))
    child.once("error", () => done([]))
    sendToChild(child, { t: "probe", id: 1, beats } satisfies WatcherRequest).catch(() => done([]))
  })
}

// Each child is started with what it's for as its one argument (`watch`, `probes`, `history`, `checkpoints`,
// `delivery`), which the child doesn't read: a process listing says which of them still runs.
function defaultChildScript(): string {
  const compiled = fileURLToPath(new URL("./watcher-child-main.js", import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}
