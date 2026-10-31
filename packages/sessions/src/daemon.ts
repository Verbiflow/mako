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
 *   ← { event: "reload", path }                     a follow that ended for a fresh page
 *
 * Single instance by construction: a starting daemon first tries to *be* a
 * client; if something answers the ping, it exits quietly.
 */

import type { ReceivedRecords, ReceivingSession, RecordsLink, SentRecords, StagedRecords } from "./record-sync.js"
import type { CopyPage } from "./reading-copies.js"
import type { CatalogSyncStatus, SyncScope } from "./scoped-uploads.js"
import type { InstalledReading } from "./record-writers.js"
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net"
import { closeSync, constants, openSync } from "node:fs"
import { chmod, mkdir, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { createHash } from "node:crypto"
import { monitorEventLoopDelay } from "node:perf_hooks"
import { z } from "zod"
import { dirname, join } from "node:path"
import type { SessionCatalog } from "./catalog.js"
import { namedWork, watchLoop, type WorkUnderWay } from "./loop-watch.js"
import { MemoryGuard } from "./memory-guard.js"
import {
  LineAssembler,
  parseDaemonEvent,
  parseDaemonRequest,
  parseDaemonResponse,
  parseJsonRecord,
  readDaemonFrameId,
  refusedRequest,
  serializeDaemonFrame,
  syncStatusOnWire,
  type DaemonEvent,
  type DaemonRequestFrame,
  type DaemonResponseFrame,
  type DaemonStats,
  type PendingRequest,
} from "./daemon-wire.js"
import type { Entry } from "./entries.js"
import type { EntryOriginal } from "./record-original.js"
import type {
  Thread,
  ThreadPage,
  ThreadPageOptions,
  ThreadRef,
} from "./format.js"
import type { ChildTranscripts } from "./children.js"
import type { KeptRestore } from "./kept-restore.js"
import { onMac, onWindows } from "./platform.js"

export type { DaemonEvent, DaemonStats } from "./daemon-wire.js"

export function daemonSocketPath(): string {
  if (onWindows()) {
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
export const PROTOCOL_VERSION = 34
/**
 * The resident memory past which a host retires its sync daemon: a daemon whose own guard (`MemoryGuard`, which sheds
 * its uploads first and retires itself at a lower mark only once they've drained) couldn't bring it down.
 */
export const MAX_DAEMON_RSS = 1024 * 1024 * 1024
export function daemonMemoryUnsafe(rss: number): boolean {
  return rss > MAX_DAEMON_RSS
}
const MAX_CLIENTS = 64
const HOLD_TIMEOUT_MS = 15 * 60_000
const MAX_REQUEST_FRAME_BYTES = 1024 * 1024
const MAX_RESPONSE_FRAME_BYTES = 256 * 1024 * 1024
const MAX_PENDING_WRITE_BYTES = 256 * 1024 * 1024

export interface DaemonClaim {
  release(): Promise<void>
}

/** Another daemon holds the socket: the first to start serves, and the rest leave. */
export class DaemonAlreadyServing extends Error {}

/** BSD's open(2) flag for an exclusive lock taken with the open; Node passes it through but doesn't name it. */
const O_EXLOCK = 0x20

/**
 * The right to start the daemon for `socketPath`, held by the kernel as the
 * host's own lock is (packages/host/src/base/host-lock.ts) and dropped when
 * this process exits, however it exits. A pid in a file outlived its process,
 * and once the number was reused (after a reboot, in a container started from
 * an image, in a restored sandbox) every start deferred to a stranger.
 *
 * - macOS: `<socket>.lock`, opened with `O_EXLOCK` and never removed.
 * - Linux: a listening socket in the abstract namespace named for the socket.
 * - Windows: a named pipe named for it.
 */
export async function claimDaemon(
  socketPath = daemonSocketPath()
): Promise<DaemonClaim> {
  const taken = () => new DaemonAlreadyServing("A sync daemon is already starting")
  // The folder the claimant will bind the socket in, private to this user.
  if (!onWindows()) await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  if (onMac()) {
    let fd: number
    try {
      fd = openSync(`${socketPath}.lock`, constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK, 0o600)
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      throw code === "EAGAIN" || code === "EWOULDBLOCK" ? taken() : error
    }
    let released = false
    return {
      async release() {
        if (released) return
        released = true
        closeSync(fd)
      },
    }
  }
  const id = createHash("sha256").update(socketPath).digest("hex").slice(0, 32)
  const server = createServer((socket) => socket.destroy())
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "EADDRINUSE" ? taken() : error))
    server.listen(onWindows() ? `\\\\.\\pipe\\mako-syncd-claim-${id}` : `\0mako-syncd-claim-${id}`, resolve)
  })
  server.unref()
  return { release: () => new Promise((done) => server.close(() => done())) }
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
  /** Fires when the link ends, with the error that ended it when one did. */
  onClose(listener: (error?: Error) => void): void
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
      socket.on("close", () => listener())
      socket.on("error", (error) => listener(error))
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

/**
 * Where a serving reader says what happens to it: clients coming and going,
 * and why it retires. The detached reader keeps these lines in `syncd.log`
 * (`daemon-main.ts`); nothing else is told why a reader went away.
 */
export type DaemonLogger = (
  level: "info" | "warn" | "error",
  message: string,
  fields?: Record<string, string | number | boolean | undefined>
) => void

/** Why a serving catalog retires: its last client left long enough ago, its memory stayed over its limits with its uploads shed (`MemoryGuard`), or a client asked (a newer build, or a host that saw its memory). */
export type DaemonRetireReason = "no clients" | "memory" | "asked"

/** Serve one catalog over the socket. Resolves once listening. */
export interface ServeCatalogOptions {
  log?: DaemonLogger
  catalogIdentity?: string
  /** On-demand readers retire after their last client leaves; login daemons omit this. */
  idleMs?: number
  /** Lists require complete initial discovery; known-path reads do not. */
  discovery?: Promise<ThreadRef[]>
  /**
   * Keep the process under its memory limits (`MemoryGuard`): shed the catalog's uploads, and retire only if that
   * fails. On by default for the detached daemon; a catalog served from a worker thread inside a host reads the
   * host's memory here and must be bounded by the worker's own heap limit instead.
   */
  memoryGuard?: boolean
  /** What the process does, by name: a request is named to it, and a hold of the loop says what was under way. */
  work?: WorkUnderWay
}

interface CatalogService {
  attach(link: DaemonLink): boolean
  retire(reason: DaemonRetireReason): void
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
  // A hold of this thread is a request answered late, or past the host's timeout: said with what held it.
  const stopWatch = options.log && options.work ? watchLoop(options.work, (ms, during) => options.log?.("warn", "loop held", { ms, during })) : () => {}
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
  const retire = (reason: DaemonRetireReason, fields: Record<string, string | number> = {}) => {
    if (retiring) return
    retiring = true
    options.log?.(reason === "memory" ? "warn" : "info", "retiring", { reason, clients: clients.size, ...fields })
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
      idleTimer = setTimeout(retire, options.idleMs, "no clients", { idleMs: options.idleMs })
  }
  watchIdle()
  const guard = new MemoryGuard(catalog.uploadBudget, (level, message, fields) => options.log?.(level, message, fields))
  const memoryTimer = setInterval(() => {
    if (options.memoryGuard === false || retiring) return
    const over = guard.sample()
    if (over) retire("memory", over)
  }, 5_000)

  const attach = (link: DaemonLink): boolean => {
    if (clients.size >= MAX_CLIENTS) {
      options.log?.("warn", "client refused", { clients: clients.size, max: MAX_CLIENTS })
      link.close()
      return false
    }
    clients.add(link)
    options.log?.("info", "client connected", { clients: clients.size })
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
          case "page": {
            const options: ThreadPageOptions = { toolOutputChars: frame.toolOutput, maxChars: frame.maxChars, preview: frame.preview }
            if (frame.stale) options.stale = true
            if (frame.asOf !== undefined) options.asOf = frame.asOf
            reply({ id: frame.id, ok: true, result: await catalog.page(frame.path, frame.before, frame.limit, options) })
            return
          }
          case "entry":
            reply({ id: frame.id, ok: true, result: await catalog.entry(frame.path, frame.entry) })
            return
          case "original":
            reply({ id: frame.id, ok: true, result: await catalog.original(frame.path, frame.entry) })
            return
          case "children":
            reply({ id: frame.id, ok: true, result: await catalog.children(frame.path) })
            return
          case "hold":
            reply({ id: frame.id, ok: true, result: await catalog.hold(frame.path) })
            return
          case "restore":
            reply({ id: frame.id, ok: true, result: await catalog.restoreKept(frame.path, frame.installed) })
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
              },
              frame.reloads ? () => link.send(serializeDaemonFrame({ event: "reload", path: frame.path })) : undefined
            )
            mine?.set(frame.path, stop)
            reply({ id: frame.id, ok: true, result: null })
            return
          }
          case "records":
            catalog.syncRecords(frame.link)
            reply({ id: frame.id, ok: true, result: null })
            return
          case "copies":
            catalog.syncCopies(frame.link)
            reply({ id: frame.id, ok: true, result: null })
            return
          case "originals":
            catalog.syncOriginals(frame.link)
            reply({ id: frame.id, ok: true, result: null })
            return
          case "sync-scope":
            catalog.scopeSync(frame.scope)
            reply({ id: frame.id, ok: true, result: null })
            return
          case "sync-status":
            reply({ id: frame.id, ok: true, result: syncStatusOnWire(await catalog.syncStatus()) })
            return
          case "send-records":
            reply({ id: frame.id, ok: true, result: await catalog.sendRecords(frame.link, frame.paths) })
            return
          case "receive-records":
            reply({ id: frame.id, ok: true, result: await catalog.receiveRecords(frame.link, frame.sessions, frame.installed) })
            return
          case "stage-records":
            reply({ id: frame.id, ok: true, result: await catalog.stageRecords(frame.link, frame.sessions) })
            return
          case "copy-page":
            reply({ id: frame.id, ok: true, result: await catalog.copyPage(frame.link, frame.harness, frame.nativeId, frame.before, frame.limit) })
            return
          case "retire": {
            // A newer client wants this vintage gone. Answer, then leave —
            // the socket frees, and the successor takes over the watchers.
            reply({ id: frame.id, ok: true, result: null })
            retire("asked")
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
      if (frame) {
        void namedWork(options.work, `request ${frame.op}`, () => handle(frame))
        return
      }
      // A request this build can't read (another build's, or a malformed one) is said, and answered when it can be:
      // its sender hears why at once rather than waiting out its timeout.
      const { id, op } = refusedRequest(raw)
      console.warn("mako-syncd: refused a request it couldn't read", JSON.stringify({ op: op ?? "unknown", id: id ?? "none", protocol: PROTOCOL_VERSION }))
      if (id !== undefined)
        reply({ id, ok: false, error: `The sync daemon couldn't read this ${op ?? "unnamed"} request: it may come from another Mako build (protocol ${PROTOCOL_VERSION})` })
    })
    link.onClose((error) => {
      // A socket that errors closes too; the client left once.
      if (!clients.delete(link)) return
      options.log?.("info", "client left", { clients: clients.size, ...error && { error: error.message } })
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
      stopWatch()
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
    throw new DaemonAlreadyServing(`A sync daemon is already running (pid ${alive.pid})`)
  }
  if (!onWindows()) await unlink(socketPath).catch(() => {})

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
    if (!onWindows()) void unlink(socketPath).catch(() => {})
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(socketPath, resolve)
    })
    if (!onWindows()) await chmod(socketPath, 0o600)
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
  /** One entry whole, by id, that an earlier trimmed page cut. */
  entry(path: string, id: string): Promise<Entry | null>
  /** The bytes an entry was read from, by its id (`SessionCatalog.original`). */
  original(path: string, id: string): Promise<EntryOriginal | null>
  /** The child agents a session started (`SessionCatalog.children`). */
  children(path: string): Promise<ChildTranscripts | null>
  /** Takes the session into the record store now (`SessionCatalog.hold`). */
  hold(path: string): Promise<boolean>
  /** Puts a session its harness deleted back into the harness's store (`SessionCatalog.restoreKept`), when `installed` may read its records. */
  restoreKept(path: string, installed?: string | InstalledReading | null): Promise<KeptRestore>
  follow(path: string, fromByte: number): Promise<void>
  unfollow(path?: string): Promise<void>
  /** Ask the daemon to exit — used to replace an older vintage. */
  retire(): Promise<void>
  /** Keeps a remote store in step with the catalog's (`SessionCatalog.syncRecords`); null stops. */
  syncRecords(link: RecordsLink | null): Promise<void>
  /** Where this device's reading copies go (`SessionCatalog.syncCopies`); null stops them. */
  syncCopies(link: RecordsLink | null): Promise<void>
  /** Where this device's originals go (`SessionCatalog.syncOriginals`); null stops them. */
  syncOriginals(link: RecordsLink | null): Promise<void>
  /** Which Sessions it keeps in the account, most wanted first (`SessionCatalog.scopeSync`). */
  scopeSync(scope: SyncScope): Promise<void>
  /** How its sync stands (`SessionCatalog.syncStatus`). */
  syncStatus(): Promise<CatalogSyncStatus>
  /** Sends sessions' records to a remote store now (`SessionCatalog.sendRecords`). */
  sendRecords(link: RecordsLink, paths: string[]): Promise<SentRecords[]>
  /** Takes sessions' records from a remote store into their harnesses' stores here (`SessionCatalog.receiveRecords`). */
  receiveRecords(link: RecordsLink, sessions: ReceivingSession[], installed: Record<string, InstalledReading | null>): Promise<ReceivedRecords[]>
  /** Pulls sessions' records from a remote store into this one ahead of a move (`SessionCatalog.stageRecords`). */
  stageRecords(link: RecordsLink, sessions: ReceivingSession[]): Promise<StagedRecords[]>
  /** A page of the copy another device keeps of a Session (`SessionCatalog.copyPage`). */
  copyPage(link: RecordsLink, harness: string, nativeId: string, before: number | undefined, limit: number): Promise<CopyPage | null>
  onEvent(listener: (event: DaemonEvent) => void): () => void
  /**
   * Fires once if the daemon goes away, with why: `closed here` when this
   * client closed it, `closed` when the other end did, or the link's error.
   * The client is dead afterwards.
   */
  onClose(listener: (reason: string) => void): void
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
  const closeListeners = new Set<(reason: string) => void>()
  let closedHere = false

  link.onFrame((raw) => {
    const record = parseJsonRecord(raw)
    if (!record) return
    const id = readDaemonFrameId(record)
    if (id !== undefined) {
      const waiter = pending.get(id)
      if (!waiter) return
      const response = parseDaemonResponse(record, waiter)
      pending.delete(id)
      clearTimeout(waiter.timer)
      if (!response) {
        waiter.reject(new Error(`The sync daemon's ${waiter.kind} reply doesn't match this build's schema`))
        return
      }
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
        case "entry":
          response.pending.resolve(response.result)
          break
        case "original":
          response.pending.resolve(response.result)
          break
        case "children":
          response.pending.resolve(response.result)
          break
        case "hold":
          response.pending.resolve(response.result)
          break
        case "restore":
          response.pending.resolve(response.result)
          break
        case "send-records":
          response.pending.resolve(response.result)
          break
        case "receive-records":
          response.pending.resolve(response.result)
          break
        case "stage-records":
          response.pending.resolve(response.result)
          break
        case "copy-page":
          response.pending.resolve(response.result)
          break
        case "sync-status":
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
  link.onClose((error) => {
    if (dead) return
    dead = true
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error("The sync daemon went away"))
    }
    pending.clear()
    const reason = closedHere ? "closed here" : error ? error.message : "closed"
    for (const listener of closeListeners) listener(reason)
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
        stale: options.stale,
        asOf: options.asOf,
      })
    })

  const requestEntry = (path: string, entry: string): Promise<Entry | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "entry", resolve, reject, timer })
      send({ id, op: "entry", path, entry })
    })

  const requestOriginal = (path: string, entry: string): Promise<EntryOriginal | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "original", resolve, reject, timer })
      send({ id, op: "original", path, entry })
    })

  const requestChildren = (path: string): Promise<ChildTranscripts | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, 30_000))
      pending.set(id, { kind: "children", resolve, reject, timer })
      send({ id, op: "children", path })
    })

  // A first capture of a store of gigabytes takes minutes.
  const requestHold = (path: string): Promise<boolean> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, HOLD_TIMEOUT_MS))
      pending.set(id, { kind: "hold", resolve, reject, timer })
      send({ id, op: "hold", path })
    })

  // A restore writes the session whole, as a hold reads it whole.
  const requestRestore = (path: string, installed?: string | InstalledReading | null): Promise<KeptRestore> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, HOLD_TIMEOUT_MS))
      pending.set(id, { kind: "restore", resolve, reject, timer })
      send(installed === undefined ? { id, op: "restore", path } : { id, op: "restore", path, installed })
    })

  // Records go over the network: a move's session may be large.
  const requestSendRecords = (link: RecordsLink, paths: string[]): Promise<SentRecords[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, HOLD_TIMEOUT_MS))
      pending.set(id, { kind: "send-records", resolve, reject, timer })
      send({ id, op: "send-records", link, paths })
    })

  const requestReceiveRecords = (link: RecordsLink, sessions: ReceivingSession[], installed: Record<string, InstalledReading | null>): Promise<ReceivedRecords[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, HOLD_TIMEOUT_MS))
      pending.set(id, { kind: "receive-records", resolve, reject, timer })
      send({ id, op: "receive-records", link, sessions, installed })
    })

  const requestStageRecords = (link: RecordsLink, sessions: ReceivingSession[]): Promise<StagedRecords[]> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, HOLD_TIMEOUT_MS))
      pending.set(id, { kind: "stage-records", resolve, reject, timer })
      send({ id, op: "stage-records", link, sessions })
    })

  const requestCopyPage = (link: RecordsLink, harness: string, nativeId: string, before: number | undefined, limit: number): Promise<CopyPage | null> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, Math.max(timeoutMs, HOLD_TIMEOUT_MS))
      pending.set(id, { kind: "copy-page", resolve, reject, timer })
      send(before === undefined ? { id, op: "copy-page", link, harness, nativeId, limit } : { id, op: "copy-page", link, harness, nativeId, before, limit })
    })

  const requestSyncStatus = (): Promise<CatalogSyncStatus> =>
    new Promise((resolve, reject) => {
      const id = nextId++
      const timer = requestTimer(id, reject, timeoutMs)
      pending.set(id, { kind: "sync-status", resolve, reject, timer })
      send({ id, op: "sync-status" })
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
      entry: requestEntry,
      original: requestOriginal,
      children: requestChildren,
      hold: requestHold,
      restoreKept: requestRestore,
      follow: (path, fromByte) =>
        requestAck((id) => ({ id, op: "follow", path, fromByte, reloads: true })),
      unfollow: (path) => requestAck((id) => ({ id, op: "unfollow", path })),
      retire: () => requestAck((id) => ({ id, op: "retire" })),
      syncRecords: (link) => requestAck((id) => ({ id, op: "records", link })),
      syncCopies: (link) => requestAck((id) => ({ id, op: "copies", link })),
      syncOriginals: (link) => requestAck((id) => ({ id, op: "originals", link })),
      scopeSync: (scope) => requestAck((id) => ({ id, op: "sync-scope", scope })),
      syncStatus: requestSyncStatus,
      sendRecords: requestSendRecords,
      receiveRecords: requestReceiveRecords,
      stageRecords: requestStageRecords,
      copyPage: requestCopyPage,
      onEvent: (listener) => {
        eventListeners.add(listener)
        return () => eventListeners.delete(listener)
      },
      onClose: (listener) => void closeListeners.add(listener),
      close: () => {
        closedHere = true
        link.close()
      },
    }
  } catch (error) {
    link.close()
    throw error
  }
}
