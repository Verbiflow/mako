/**
 * The sync daemon: the catalog, running whether or not any window is open.
 *
 * Everything the catalog does — watching five harnesses' stores, peeking
 * changed files, polling remotes — works headless, because the library was
 * built without Electron in it. This wraps one catalog in a Unix-socket
 * server so that *one* process owns the watchers and the peek cache, and
 * every client — the desktop app, a CLI, the next thing — reads the same
 * always-warm state over NDJSON instead of scanning disk themselves.
 *
 * What this buys, concretely: the app's boot goes from "scan the world"
 * to one socket round-trip; the cache never goes cold because the daemon
 * was watching while the app was closed; and two windows cost two socket
 * connections, not two sets of file watchers.
 *
 * The protocol is deliberately small — NDJSON frames on a local socket:
 *
 *   → { id, op: "ping" | "list" | "open" | "follow" | "unfollow", ... }
 *   ← { id, ok, result | error }            responses
 *   ← { event: "added"|"updated"|"removed", ... }   catalog changes
 *   ← { event: "entries", path, entries, replace }  followed-thread tails
 *
 * Single instance by construction: a starting daemon first tries to *be* a
 * client; if something answers the ping, it exits quietly.
 */

import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { z } from "zod"
import { dirname, join } from "node:path"
import type { SessionCatalog } from "./catalog.js"
import {
  LineAssembler,
  parseDaemonEvent,
  parseDaemonRequest,
  parseDaemonResponse,
  parseJsonRecord,
  readDaemonFrameId,
  serializeDaemonFrame,
  type DaemonEvent,
  type DaemonRequestFrame,
  type DaemonResponseFrame,
  type DaemonStats,
  type PendingRequest,
} from "./daemon-wire.js"
import type {
  BlockAddress,
  EntryBlock,
  Thread,
  ThreadPage,
  ThreadPageOptions,
  ThreadRef,
} from "./format.js"

export type { DaemonEvent, DaemonStats } from "./daemon-wire.js"

export function daemonSocketPath(): string {
  if (process.platform === "win32") {
    const user = (process.env.USERNAME ?? "user").replace(/[^a-z0-9_-]/gi, "-")
    return `\\\\.\\pipe\\mako-syncd-${user}`
  }
  return join(homedir(), ".mako", "syncd.sock")
}

/**
 * Bumped when the wire *data* changes shape, not just the ops — a ref that
 * grew a field counts, because a stale daemon would keep serving refs
 * without it forever. Clients that see an older daemon retire it and let a
 * fresh one take the socket.
 */
export const PROTOCOL_VERSION = 31
export const MAX_DAEMON_RSS = 512 * 1024 * 1024
export function daemonMemoryUnsafe(rss: number): boolean {
  return rss > MAX_DAEMON_RSS
}
const MAX_CLIENTS = 64
const MAX_REQUEST_FRAME_BYTES = 1024 * 1024
const MAX_RESPONSE_FRAME_BYTES = 256 * 1024 * 1024
const MAX_PENDING_WRITE_BYTES = 256 * 1024 * 1024

export interface DaemonClaim {
  release(): Promise<void>
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function claimDaemon(
  socketPath = daemonSocketPath()
): Promise<DaemonClaim> {
  const lockPath =
    process.platform === "win32"
      ? join(homedir(), ".mako", socketPath === daemonSocketPath()
          ? "syncd.lock"
          : `catalog-${createHash("sha256").update(socketPath).digest("hex")}.lock`)
      : `${socketPath}.lock`
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(lockPath, String(process.pid), {
        flag: "wx",
        mode: 0o600,
      })
      let released = false
      return {
        async release() {
          if (released) return
          released = true
          const owner = Number(await readFile(lockPath, "utf8").catch(() => ""))
          if (owner === process.pid) await unlink(lockPath).catch(() => {})
        },
      }
    } catch (error) {
      let owner = Number(await readFile(lockPath, "utf8").catch(() => ""))
      if (!Number.isInteger(owner) || owner <= 0) {
        await new Promise((resolve) => setTimeout(resolve, 25))
        owner = Number(await readFile(lockPath, "utf8").catch(() => ""))
      }
      if (Number.isInteger(owner) && owner > 0 && processIsAlive(owner)) {
        throw new Error(`A sync daemon is already starting (pid ${owner})`)
      }
      await unlink(lockPath).catch(() => {})
      if (attempt === 1) throw error
    }
  }
  throw new Error("The sync daemon lock could not be acquired")
}

/**
 * One end of a line-framed link. A Unix socket carries the detached daemon's
 * frames; a `MessagePort` carries a catalog worker's frames inside its host.
 * The socket splits a frame into 8 KB pieces on macOS (`net.local.stream`),
 * and each piece woke Electron's main loop: a 7 MB thread took 200 ms to
 * cross from the worker that had it ready in 45. A port posts it whole.
 */
export interface DaemonLink {
  send(frame: string): void
  onFrame(listener: (raw: string) => void): void
  onClose(listener: () => void): void
  close(): void
}

/**
 * The shape of `MessagePort` this protocol needs. A port carries whatever
 * the other side posted; `portFrame` admits only a string within the frame
 * limit, and anything else closes the link the way an oversized socket
 * frame does.
 */
export interface DaemonPort {
  postMessage(value: string): void
  on(event: "message", listener: (value: PortMessage) => void): void
  on(event: "close", listener: () => void): void
  close(): void
}

type PortMessage = z.infer<typeof portMessage>
const portMessage = z.string()

function socketLink(socket: Socket, frameLimit: number, overflow: string): DaemonLink {
  const lines = new LineAssembler(frameLimit)
  return {
    send(frame) {
      if (socket.destroyed) return
      if (
        socket.writableLength + Buffer.byteLength(frame) >
        MAX_PENDING_WRITE_BYTES
      ) {
        socket.destroy(new Error("The sync daemon client stopped reading"))
        return
      }
      socket.write(frame)
    },
    onFrame(listener) {
      socket.on("data", (chunk) => {
        const complete = lines.push(chunk)
        if (!complete) {
          socket.destroy(new Error(overflow))
          return
        }
        for (const raw of complete) listener(raw)
      })
    },
    onClose(listener) {
      socket.on("close", listener)
      socket.on("error", listener)
    },
    close: () => socket.destroy(),
  }
}

export function portLink(port: DaemonPort, frameLimit: number): DaemonLink {
  let closed = false
  const closeListeners = new Set<() => void>()
  const close = () => {
    if (closed) return
    closed = true
    port.close()
    for (const listener of closeListeners) listener()
  }
  port.on("close", close)
  return {
    send(frame) {
      if (!closed) port.postMessage(frame)
    },
    onFrame(listener) {
      port.on("message", (value) => {
        const frame = portMessage.max(frameLimit).safeParse(value)
        if (!frame.success) {
          close()
          return
        }
        listener(frame.data)
      })
    },
    onClose: (listener) => void closeListeners.add(listener),
    close,
  }
}

/** Serve one catalog over the socket. Resolves once listening. */
export interface ServeCatalogOptions {
  catalogIdentity?: string
  /** On-demand readers retire after their last client leaves; login daemons omit this. */
  idleMs?: number
  /** Lists require complete initial discovery; known-path reads do not. */
  discovery?: Promise<ThreadRef[]>
  /**
   * Retire when the process RSS stays above `MAX_DAEMON_RSS`. On by default
   * for the detached daemon; a catalog served from a worker thread inside a
   * host reads the host's RSS here and must be bounded by the worker's own
   * heap limit instead.
   */
  memoryGuard?: boolean
}

interface CatalogService {
  attach(link: DaemonLink): boolean
  retire(): void
  /** Stop serving without stopping the catalog. */
  dispose(): void
  onRetire(listener: () => void): void
}

function catalogService(
  catalog: SessionCatalog,
  options: ServeCatalogOptions
): CatalogService {
  const startedAt = Date.now()
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 })
  eventLoopDelay.enable()
  const clients = new Set<DaemonLink>()
  const follows = new Map<DaemonLink, Map<string, () => void>>()
  const retireListeners = new Set<() => void>()
  let idleTimer: ReturnType<typeof setTimeout> | undefined

  const broadcast = (frame: DaemonEvent) => {
    const line = serializeDaemonFrame(frame)
    for (const client of clients) client.send(line)
  }

  const stopEvents = catalog.onEvent((event) => {
    if (event.type === "removed") {
      broadcast({ event: "removed", path: event.path })
      return
    }
    broadcast({ event: event.type, ref: event.ref })
  })

  let retiring = false
  const retire = () => {
    if (retiring) return
    retiring = true
    for (const listener of retireListeners) listener()
    setTimeout(() => {
      catalog.stop()
      for (const client of clients) client.close()
    }, 100)
  }
  const watchIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = undefined
    if (options.idleMs !== undefined && clients.size === 0 && !retiring)
      idleTimer = setTimeout(retire, options.idleMs)
  }
  watchIdle()
  let highMemorySamples = 0
  const memoryTimer = setInterval(() => {
    if (options.memoryGuard === false) return
    highMemorySamples = daemonMemoryUnsafe(process.memoryUsage().rss)
      ? highMemorySamples + 1
      : 0
    if (highMemorySamples >= 3) retire()
  }, 5_000)

  const attach = (link: DaemonLink): boolean => {
    if (clients.size >= MAX_CLIENTS) {
      link.close()
      return false
    }
    clients.add(link)
    watchIdle()
    follows.set(link, new Map())

    const reply = (frame: DaemonResponseFrame) => {
      link.send(serializeDaemonFrame(frame))
    }

    const handle = async (frame: DaemonRequestFrame) => {
      try {
        switch (frame.op) {
          case "ping": {
            const memory = process.memoryUsage()
            const cpu = process.cpuUsage()
            reply({
              id: frame.id,
              ok: true,
              result: {
                pid: process.pid,
                startedAt,
                sessions: catalog.count,
                version: PROTOCOL_VERSION,
                script: process.argv[1] ?? "",
                catalogIdentity: options.catalogIdentity,
                runtime: process.execPath,
                rss: memory.rss,
                heapUsed: memory.heapUsed,
                ...catalog.metrics,
                clients: clients.size,
                cpuUserMicros: cpu.user,
                cpuSystemMicros: cpu.system,
                eventLoopP99Ms:
                  Number(eventLoopDelay.percentile(99)) / 1_000_000,
              },
            })
            return
          }
          case "list":
            await options.discovery
            reply({
              id: frame.id,
              ok: true,
              result: catalog.list({ cwd: frame.cwd, harness: frame.harness }),
            })
            return
          case "open":
            reply({
              id: frame.id,
              ok: true,
              result: await catalog.open(frame.path),
            })
            return
          case "page":
            reply({
              id: frame.id,
              ok: true,
              result: await catalog.page(frame.path, frame.before, frame.limit, {
                toolOutputChars: frame.toolOutput,
                maxChars: frame.maxChars,
                preview: frame.preview,
              }),
            })
            return
          case "block":
            reply({
              id: frame.id,
              ok: true,
              result: await catalog.block(frame.path, {
                entry: frame.entry,
                block: frame.block,
              }),
            })
            return
          case "follow": {
            const mine = follows.get(link)
            mine?.get(frame.path)?.()
            const stop = catalog.follow(
              frame.path,
              frame.fromByte,
              (entries, replaced, replaceFrom) => {
                const event: DaemonEvent = {
                  event: "entries",
                  path: frame.path,
                  entries,
                  replace: replaced,
                }
                if (replaceFrom !== undefined) event.replaceFrom = replaceFrom
                link.send(serializeDaemonFrame(event))
              }
            )
            mine?.set(frame.path, stop)
            reply({ id: frame.id, ok: true, result: null })
            return
          }
          case "retire": {
            // A newer client wants this vintage gone. Answer, then leave —
            // the socket frees, and the successor takes over the watchers.
            reply({ id: frame.id, ok: true, result: null })
            retire()
            return
          }
          case "unfollow": {
            const mine = follows.get(link)
            if (frame.path) {
              mine?.get(frame.path)?.()
              mine?.delete(frame.path)
            } else {
              for (const stop of mine?.values() ?? []) stop()
              mine?.clear()
            }
            reply({ id: frame.id, ok: true, result: null })
            return
          }
        }
      } catch (error) {
        reply({
          id: frame.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    link.onFrame((raw) => {
      const frame = parseDaemonRequest(raw)
      if (frame) void handle(frame)
    })
    link.onClose(() => {
      clients.delete(link)
      for (const stop of follows.get(link)?.values() ?? []) stop()
      follows.delete(link)
      watchIdle()
    })
    return true
  }

  return {
    attach,
    retire,
    dispose() {
      if (idleTimer) clearTimeout(idleTimer)
      clearInterval(memoryTimer)
      eventLoopDelay.disable()
      stopEvents()
    },
    onRetire: (listener) => void retireListeners.add(listener),
  }
}

export async function serveCatalog(
  catalog: SessionCatalog,
  socketPath = daemonSocketPath(),
  claim?: DaemonClaim,
  options: ServeCatalogOptions = {}
): Promise<Server> {
  const ownership = claim ?? (await claimDaemon(socketPath))
  const alive = await pingDaemon(socketPath).catch(() => null)
  if (alive) {
    await ownership.release()
    throw new Error(`A sync daemon is already running (pid ${alive.pid})`)
  }
  if (process.platform !== "win32") await unlink(socketPath).catch(() => {})

  const service = catalogService(catalog, options)
  const server = createServer((socket) => {
    if (
      !service.attach(
        socketLink(
          socket,
          MAX_REQUEST_FRAME_BYTES,
          "The sync daemon request was too large"
        )
      )
    )
      socket.destroy(new Error("The sync daemon has too many clients"))
  })
  service.onRetire(() => server.close())

  server.once("close", () => {
    service.dispose()
    void ownership.release()
    if (process.platform !== "win32") void unlink(socketPath).catch(() => {})
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    if (process.platform !== "win32") await chmod(socketPath, 0o600)
    return server
  } catch (error) {
    service.dispose()
    await ownership.release()
    throw error
  }
}

/**
 * Serve one catalog to the other end of a `MessagePort`: the transport for a
 * catalog running on a worker thread of the process that reads it. Serving
 * stops on `close`, on `retire`, or when the port closes.
 */
export interface PortServer {
  close(): void
  onClose(listener: () => void): void
}

export function serveCatalogOnPort(
  catalog: SessionCatalog,
  port: DaemonPort,
  options: ServeCatalogOptions = {}
): PortServer {
  const service = catalogService(catalog, options)
  const link = portLink(port, MAX_REQUEST_FRAME_BYTES)
  service.attach(link)
  const closeListeners = new Set<() => void>()
  let disposed = false
  const close = () => {
    if (disposed) return
    disposed = true
    service.dispose()
    link.close()
    for (const listener of closeListeners) listener()
    closeListeners.clear()
  }
  link.onClose(close)
  service.onRetire(close)
  return { close, onClose: (listener) => void closeListeners.add(listener) }
}

/* ------------------------------------------------------------ client */

export interface DaemonClient {
  stats: DaemonStats
  refresh(): Promise<DaemonStats>
  /** Publish the snapshot in wire order, before any later catalog events. */
  list(
    filter?: { cwd?: string; harness?: string },
    onSnapshot?: (refs: ThreadRef[]) => void
  ): Promise<ThreadRef[]>
  open(path: string): Promise<Thread | null>
  page(
    path: string,
    before?: number,
    limit?: number,
    options?: ThreadPageOptions
  ): Promise<ThreadPage | null>
  /** One complete block an earlier trimmed page left out. */
  block(path: string, at: BlockAddress): Promise<EntryBlock | null>
  follow(path: string, fromByte: number): Promise<void>
  unfollow(path?: string): Promise<void>
  /** Ask the daemon to exit — used to replace an older vintage. */
  retire(): Promise<void>
  onEvent(listener: (event: DaemonEvent) => void): () => void
  /** Fires once if the daemon goes away; the client is dead afterwards. */
  onClose(listener: () => void): void
  close(): void
}

/** One request, no session kept: proof of life and the stats that ride on it. */
export async function pingDaemon(
  socketPath = daemonSocketPath()
): Promise<DaemonStats> {
  const client = await connectDaemon(socketPath, 1500)
  const stats = client.stats
  client.close()
  return stats
}

export async function connectDaemon(
  socketPath = daemonSocketPath(),
  timeoutMs = 3000
): Promise<DaemonClient> {
  const socket = createConnection(socketPath)
  socket.setNoDelay(true)
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("The sync daemon did not answer")),
        timeoutMs
      )
      socket.once("connect", () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
    })
    return await connectDaemonLink(
      socketLink(
        socket,
        MAX_RESPONSE_FRAME_BYTES,
        "The sync daemon response was too large"
      ),
      timeoutMs
    )
  } catch (error) {
    socket.destroy()
    throw error
  }
}

/** The client end of `serveCatalogOnPort`. */
export function connectDaemonPort(
  port: DaemonPort,
  timeoutMs = 3000
): Promise<DaemonClient> {
  return connectDaemonLink(portLink(port, MAX_RESPONSE_FRAME_BYTES), timeoutMs)
}

async function connectDaemonLink(
  link: DaemonLink,
  timeoutMs: number
): Promise<DaemonClient> {
  let nextId = 1
  const pending = new Map<number, PendingRequest>()
  const eventListeners = new Set<(event: DaemonEvent) => void>()
  const closeListeners = new Set<() => void>()

  link.onFrame((raw) => {
    const record = parseJsonRecord(raw)
    if (!record) return
    const id = readDaemonFrameId(record)
    if (id !== undefined) {
      const waiter = pending.get(id)
      if (!waiter) return
      const response = parseDaemonResponse(record, waiter)
      if (!response) return
      pending.delete(id)
      clearTimeout(waiter.timer)
      switch (response.kind) {
        case "ping":
          response.pending.resolve(response.result)
          break
        case "list":
          response.pending.resolve(response.result)
          break
        case "open":
          response.pending.resolve(response.result)
          break
        case "page":
          response.pending.resolve(response.result)
          break
        case "block":
          response.pending.resolve(response.result)
          break
        case "ack":
          response.pending.resolve()
          break
        case "error":
          response.pending.reject(response.error)
          break
      }
      return
    }
    const event = parseDaemonEvent(record)
    if (event) {
      for (const listener of eventListeners) listener(event)
    }
  })

  let dead = false
  link.onClose(() => {
    if (dead) return
    dead = true
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("The sync daemon went away"))
    }
    pending.clear()
    for (const listener of closeListeners) listener()
    closeListeners.clear()
  })

  const send = (frame: DaemonRequestFrame): void => {
    link.send(serializeDaemonFrame(frame))
  }
  const requestTimer = (
    id: number,
    reject: (error: Error) => void,
    requestTimeout = timeoutMs
  ): ReturnType<typeof setTimeout> =>
    setTimeout(() => {
      if (!pending.delete(id)) return
      reject(new Error("The sync daemon request timed out"))
    }, requestTimeout)

  const requestPing = (): Promise<DaemonStats> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject)
      pending.set(id, { kind: "ping", resolve, reject, timer })
      send({ id, op: "ping" })
    })

  const requestList = (
    filter: { cwd?: string; harness?: string } = {},
    onSnapshot?: (refs: ThreadRef[]) => void
  ): Promise<ThreadRef[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      // Initial discovery can outlast a ping. Use the existing data-read budget.
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, {
        kind: "list",
        resolve: (refs) => {
          try {
            onSnapshot?.(refs)
            resolve(refs)
          } catch (error) {
            reject(error)
          }
        },
        reject,
        timer,
      })
      send({ id, op: "list", cwd: filter.cwd, harness: filter.harness })
    })

  const requestOpen = (path: string): Promise<Thread | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "open", resolve, reject, timer })
      send({ id, op: "open", path })
    })

  const requestPage = (
    path: string,
    before?: number,
    limit?: number,
    options: ThreadPageOptions = {}
  ): Promise<ThreadPage | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "page", resolve, reject, timer })
      send({
        id,
        op: "page",
        path,
        before,
        limit,
        toolOutput: options.toolOutputChars,
        maxChars: options.maxChars,
        preview: options.preview,
      })
    })

  const requestBlock = (
    path: string,
    at: BlockAddress
  ): Promise<EntryBlock | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "block", resolve, reject, timer })
      send({ id, op: "block", path, entry: at.entry, block: at.block })
    })

  const requestAck = (
    frame: (id: number) => DaemonRequestFrame
  ): Promise<void> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject)
      pending.set(id, { kind: "ack", resolve, reject, timer })
      send(frame(id))
    })

  try {
    const stats = await requestPing()
    return {
      stats,
      refresh: requestPing,
      list: requestList,
      open: requestOpen,
      page: requestPage,
      block: requestBlock,
      follow: (path, fromByte) =>
        requestAck((id) => ({ id, op: "follow", path, fromByte })),
      unfollow: (path) => requestAck((id) => ({ id, op: "unfollow", path })),
      retire: () => requestAck((id) => ({ id, op: "retire" })),
      onEvent: (listener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      onClose: (listener) => void closeListeners.add(listener),
      close: () => link.close(),
    }
  } catch (error) {
    link.close()
    throw error
  }
}
