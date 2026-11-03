import { fork, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { SLOW_DELIVERY_MS, WatcherReplySchema, type DropReason, type HistoryMark, type WatchEvent, type WatcherReply, type WatcherRequest } from "../contracts/watcher-child.js"
import { headlessNodeExecutable } from "../base/headless-node.js"
import { onMac } from "../base/platform.js"
import { WatchReadings, type ChildStart } from "./watch-readings.js"

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
export type WatchBackend = (root: string, ignore: readonly string[], listener: WatchListener) => Promise<WatchSubscription>

type ParcelCallback = (error: Error | null, events: WatchEvent[]) => void
type ParcelSubscribe = (root: string, callback: ParcelCallback, options: { ignore: string[] }) => Promise<WatchSubscription>

/** A backend that calls `subscribe` in this process, as the watcher child does; tests pass a fake. */
export function parcelBackend(subscribe: ParcelSubscribe): WatchBackend {
  return (root, ignore, listener) =>
    subscribe(root, (error, events) => (error ? listener.dropped() : listener.events(events)), { ignore: [...ignore] })
}

/** No watch for this long lets the child go; the next one starts it again. */
const IDLE_MS = 30_000
/** A child that ran this long without crashing resets the backoff. */
const STABLE_MS = 60_000
/** Crashes in a row, each before `STABLE_MS`, after which every watch is given up. */
const MAX_CRASHES = 5
/**
 * A silence restarts the child at most this often. A restart ends a parcel
 * deadlock; a silence soon after one is fseventsd's, which a restart only
 * answers with every stream registered again and every root rescanned.
 */
const RECYCLE_EVERY_MS = 10 * 60_000

interface ChildWatch {
  root: string
  ignore: string[]
  listener: WatchListener
  /** Set until the first subscribe settles; a later "ready" follows a restart. */
  pending?: { resolve(): void; reject(error: Error): void }
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
 * `late`. `readings` hears all of it, for the log and Diagnostics.
 */
export function childBackend(script = defaultChildScript(), readings = new WatchReadings()): WatchBackend {
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
  const ended = new WeakMap<ChildProcess, "idle" | "silence">()

  const post = (request: WatcherRequest) => {
    if (child?.connected) child.send(request)
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

  const forget = (id: number) => {
    if (!watches.delete(id)) return
    readings.unwatched(id)
    post({ t: "unsub", id })
    if (watches.size) return
    hold(false)
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
    const watch = watches.get(reply.id)
    if (!watch) return
    switch (reply.t) {
      case "ready": {
        const pending = watch.pending
        watch.pending = undefined
        if (pending) {
          pending.resolve()
          if (muted) watch.listener.muted(true)
          if (late) watch.listener.late?.(true)
        } else watch.listener.dropped("restarted")
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
    const lost = [...watches.values()]
    for (const id of watches.keys()) forget(id)
    crashes = 0
    for (const watch of lost) {
      if (watch.pending) watch.pending.reject(new Error("The file watcher keeps stopping"))
      else watch.listener.gone()
    }
  }

  const lost = (gone: ChildProcess) => {
    if (child !== gone) return
    child = undefined
    if (!watches.size) return
    crashes = Date.now() - startedAt >= STABLE_MS ? 1 : crashes + 1
    if (crashes >= MAX_CRASHES) return giveUp()
    restart = setTimeout(() => {
      restart = undefined
      if (watches.size) start("crash")
    }, 250 * 2 ** (crashes - 1))
  }

  const start = (why: ChildStart) => {
    const next = fork(script, [], {
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
      const reply = WatcherReplySchema.safeParse(raw)
      if (reply.success) onReply(reply.data)
    })
    next.once("exit", (code, signal) => {
      readings.stopped(next.pid, code, signal, ended.get(next) ?? "exit")
      lost(next)
    })
    next.once("error", () => lost(next))
    for (const [id, watch] of watches) post({ t: "sub", id, root: watch.root, ignore: watch.ignore })
  }

  return (root, ignore, listener) => {
    clearTimeout(idle)
    const id = nextId++
    return new Promise<WatchSubscription>((resolve, reject) => {
      const unsubscribe = async () => forget(id)
      watches.set(id, { root, ignore: [...ignore], listener, pending: { resolve: () => resolve({ unsubscribe }), reject } })
      readings.watched(id, root, ignore)
      if (child) {
        hold(true)
        post({ t: "sub", id, root, ignore: [...ignore] })
      } else if (!restart) start("first")
    })
  }
}

/** What changed on disk in a stretch of time, from the file system's own history. */
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
  since(mark: HistoryMark, roots: readonly string[], options?: { ignore?: readonly string[]; exclude?: readonly string[] }): Promise<{ paths: string[]; lost: string[]; ignored: number[] }>
}

/** A mark is asked for on the way to starting an app, so it waits less than a read of history. */
const MARK_MS = 3_000
/** A read of history this long is stuck, not slow: fseventsd has stopped answering. */
const HISTORY_MS = 120_000

/**
 * The file system's history, read in a watcher child of its own: a read
 * holds parcel's FSEvents lock until the system has replayed everything
 * since the mark, which would stall every watch sharing the child, and a
 * stuck read is ended by killing this child alone. Each request that runs
 * out of time ends the child and every request in it; the next starts one.
 */
export function childHistory(script = defaultChildScript(), readings = new WatchReadings()): FileHistory {
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

  const running = () => {
    clearTimeout(idle)
    if (child) return child
    const next = fork(script, [], {
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
      const going = child
      child = undefined
      going.kill()
    }, IDLE_MS)
    idle.unref()
  }

  const ask = (request: WatcherRequest, ms: number) =>
    new Promise<WatcherReply>((settle, fail) => {
      const current = running()
      current.ref()
      current.channel?.ref()
      const timer = setTimeout(() => end(current, new Error(`The file system's history didn't answer within ${Math.round(ms / 1000)} seconds`)), ms)
      pending.set(request.id, { child: current, settle, fail, timer })
      current.send(request)
    })

  const failed = (reply: WatcherReply) => new Error(reply.t === "failed" ? reply.message : `Unexpected reply ${reply.t}`)

  return {
    async mark() {
      if (!onMac()) throw new Error("The file system's history is read through FSEvents, on macOS only.")
      const reply = await ask({ t: "mark", id: nextId++ }, MARK_MS)
      if (reply.t !== "marked") throw failed(reply)
      return reply.mark
    },
    async since(mark, roots, options) {
      const asked = performance.now()
      const reply = await ask(
        { t: "since", id: nextId++, mark, roots: [...roots], ignore: [...(options?.ignore ?? [])], exclude: [...(options?.exclude ?? [])] },
        HISTORY_MS,
      )
      if (reply.t !== "history") throw failed(reply)
      readings.historyRead(performance.now() - asked, reply.paths.length + reply.ignored.reduce((sum, count) => sum + count, 0), { caughtUpMs: reply.caughtUpMs, readMs: reply.readMs })
      return { paths: reply.paths, lost: reply.lost, ignored: reply.ignored }
    },
  }
}

function defaultChildScript(): string {
  const compiled = fileURLToPath(new URL("./watcher-child-main.js", import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}
