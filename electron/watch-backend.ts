import { fork, type ChildProcess } from "node:child_process"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { WatcherReplySchema, type WatchEvent, type WatcherReply, type WatcherRequest } from "./contracts/watcher-child.js"
import { headlessNodeExecutable } from "./headless-node.js"

export interface WatchListener {
  events(events: readonly WatchEvent[]): void
  /** The system dropped events: anything under the root may have changed. */
  dropped(): void
  /** The watch stopped for good, such as its root going away. */
  gone(): void
  /** Nothing is being delivered, though the watch stands (true), or delivery is back (false). */
  muted(muted: boolean): void
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
 * child is restarted once, which ends a deadlock inside parcel. A silent
 * fseventsd outlives the restart; the watches stay muted until a canary is
 * heard again.
 */
export function childBackend(script = defaultChildScript()): WatchBackend {
  const watches = new Map<number, ChildWatch>()
  let child: ChildProcess | undefined
  let startedAt = 0
  let crashes = 0
  let nextId = 1
  let idle: NodeJS.Timeout | undefined
  let restart: NodeJS.Timeout | undefined
  let muted = false
  /** This silence already cost the child one restart. */
  let recycled = false

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
      going.kill()
    }, IDLE_MS)
    idle.unref()
  }

  const onDelivery = (ok: boolean) => {
    if (ok) recycled = false
    if (muted !== ok) return
    muted = !ok
    for (const watch of watches.values()) if (!watch.pending) watch.listener.muted(muted)
    if (muted && !recycled && child) {
      recycled = true
      const stuck = child
      child = undefined
      stuck.kill()
      start()
    }
  }

  const onReply = (reply: WatcherReply) => {
    if (reply.t === "delivery") return onDelivery(reply.ok)
    const watch = watches.get(reply.id)
    if (!watch) return
    switch (reply.t) {
      case "ready": {
        const pending = watch.pending
        watch.pending = undefined
        if (pending) {
          pending.resolve()
          if (muted) watch.listener.muted(true)
        } else watch.listener.dropped()
        return
      }
      case "failed":
        forget(reply.id)
        if (watch.pending) watch.pending.reject(new Error(reply.message))
        else watch.listener.gone()
        return
      case "events":
        watch.listener.events(reply.events)
        return
      case "dropped":
        watch.listener.dropped()
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
      if (watches.size) start()
    }, 250 * 2 ** (crashes - 1))
  }

  const start = () => {
    const next = fork(script, [], {
      execPath: headlessNodeExecutable(),
      // Under tsx (tests, development scripts) the child needs its loader to run TypeScript.
      execArgv: script.endsWith(".ts") ? process.execArgv : [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    child = next
    startedAt = Date.now()
    next.on("message", (raw) => {
      const reply = WatcherReplySchema.safeParse(raw)
      if (reply.success) onReply(reply.data)
    })
    next.once("exit", () => lost(next))
    next.once("error", () => lost(next))
    for (const [id, watch] of watches) post({ t: "sub", id, root: watch.root, ignore: watch.ignore })
  }

  return (root, ignore, listener) => {
    clearTimeout(idle)
    const id = nextId++
    return new Promise<WatchSubscription>((resolve, reject) => {
      const unsubscribe = async () => forget(id)
      watches.set(id, { root, ignore: [...ignore], listener, pending: { resolve: () => resolve({ unsubscribe }), reject } })
      if (child) {
        hold(true)
        post({ t: "sub", id, root, ignore: [...ignore] })
      } else if (!restart) start()
    })
  }
}

function defaultChildScript(): string {
  const compiled = fileURLToPath(new URL("./watcher-child-main.js", import.meta.url))
  return existsSync(compiled) ? compiled : compiled.replace(/\.js$/, ".ts")
}
