import { randomBytes, randomUUID } from "node:crypto"
import { chmod, rm } from "node:fs/promises"
import { createServer, type Server, type Socket } from "node:net"
import { setTimeout as delay } from "node:timers/promises"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  ComputerDriverExitedError,
  type ComputerDriverCallOptions,
  type ComputerDriverClient,
  type ComputerDriverResult,
  type DriverSuperseded,
} from "./computer-driver-client.js"
import {
  BrokerRequestSchema,
  DriverNotDispatchedError,
  waitFor,
  type BrokerFault,
  type BrokeredDriverEndpoint,
} from "./driver-broker-client.js"
import {
  DaemonUnavailableError,
  daemonMismatch,
  daemonToolResult,
  describeDaemon,
  exchange,
  leaseIdentity,
  openDaemonLease,
  parseReply,
  readLine,
  type DaemonDescription,
  type SnapshotScope,
} from "./driver-daemon.js"
import type { JsonObject } from "./json.js"
import { warmAppshots, type AppshotRead } from "./native-appshot.js"
import { createControlDirectory, createPrivateControlSocket } from "./private-socket.js"

/**
 * The one owner of Mako's connection to its native driver daemon. Every
 * consumer goes through it: the host's Appshots in process, each task's
 * control session from its worker over the broker's private socket, and
 * through those the `mako-control` CLI. It speaks the daemon's own protocol
 * (`driver-daemon.ts`), so no `cua-driver mcp` process runs for anyone.
 *
 * Each consumer holds a lease, which is a transport identity at the daemon:
 * the sessions it names, its agent cursor, its recordings and its
 * screenshot coordinate frames are its own, the daemon refuses another
 * lease's session by name, and closing the lease ends them all. Calls go on
 * connections of their own, so one consumer's slow call never holds
 * another's back. A task's lease runs its calls one after another, as its
 * proxy did; the Appshots lease lets its reads overlap.
 *
 * Element snapshots are each lease's own at a driver that says so
 * (`snapshot_scope: "transport"`): a consumer's tree read replaces only its
 * own earlier read of that window, so its tokens survive everyone else's
 * reads and go when its lease closes. An older driver keeps one snapshot per
 * window for everyone, and there the broker, which sees every tree read,
 * tells the consumer whose snapshot was replaced, by whom. A driver whose
 * daemon contract the broker doesn't speak is refused before any call.
 *
 * It reads the daemon's version and tools once per daemon, reconnects once
 * when the daemon is replaced and warms its first window picture once per
 * daemon. It keeps the last calls' timings, never their contents.
 */

export interface DriverConsumer {
  /** `appshots` for the person's captures, `agent` for a task's session, `broker` for its own warm-up. */
  kind: "appshots" | "agent" | "broker"
  label: string
}

export interface DriverBrokerOptions {
  /** The daemon's socket, starting the daemon when it isn't running; null where there is no driver. */
  socket: () => Promise<string | null>
  /** Mako's own processes, whose window the warm-up pictures rather than anyone else's. */
  own?: () => readonly number[]
  /** One lifecycle line: connected, lost, warmed, leases, and calls that failed or were slow. No contents. */
  log?: (message: string, fields: Record<string, string | number | boolean | undefined>) => void
}

type Outcome = "ok" | "error" | "refused" | "closed" | "unavailable" | "cancelled"

interface CallRecord {
  consumer: string
  tool: string
  /** `pid:window_id` when the call named a window. */
  window?: string
  at: number
  queuedMs: number
  ms?: number
  bytes?: number
  outcome?: Outcome
  /** The caller stopped waiting (cancelled or timed out) while the daemon ran it. */
  abandoned?: boolean
}

/** A call taken on a lease: its reply line, and its record in the readout. */
interface Dispatched {
  reply: Promise<Buffer>
  record: CallRecord
}

type WarmState = { state: "cold" | "warming" | "skipped" | "failed" } | { state: "warm"; ms: number }

interface Generation {
  number: number
  socket: string
  description: DaemonDescription
  connectedAt: number
  connectMs: number
  leases: Set<Lease>
  sentinel: { close(): void }
  lost: boolean
  warm: WarmState
  warming?: Promise<void>
}

interface Lease {
  id: string
  identity: string
  consumer: DriverConsumer
  parallel: boolean
  generation: Generation
  opened: number
  /** The serial lane: settles when the last call the daemon took has answered. */
  tail: Promise<void>
  queued: number
  inFlight: Set<CallRecord>
  calls: number
  errors: number
  superseded: number
  last?: CallRecord
  ended: boolean
  close(): void
  endListeners: Array<() => void>
  supersededListeners: Array<(event: DriverSuperseded) => void>
}

export interface DriverBrokerStatus {
  daemon:
    | { state: "idle" | "connecting" }
    | {
        state: "connected"
        generation: number
        version: string
        contract: string
        /** `lease`: each consumer's snapshots are its own. `window`: shared, and supersession is tracked. */
        snapshots: SnapshotScope
        pid?: number
        socket: string
        connectedForMs: number
        connectMs: number
        tools: number
      }
  warm: WarmState
  reconnects: number
  /** Where workers reach the broker, once a task was granted it. */
  endpoint: string | null
  consumers: Array<{
    consumer: string
    kind: DriverConsumer["kind"]
    mode: "serial" | "parallel"
    leasedForMs: number
    calls: number
    errors: number
    queued: number
    inFlight: number
    superseded: number
    last?: { tool: string; ms?: number; outcome?: Outcome; agoMs: number }
  }>
  inFlight: Array<{ consumer: string; tool: string; window?: string; runningMs: number; abandoned: boolean }>
  recent: Array<{ at: string; consumer: string; tool: string; window?: string; queuedMs: number; ms?: number; bytes?: number; outcome?: Outcome; abandoned?: boolean }>
  totals: { calls: number; errors: number; bytes: number; superseded: number; leases: number }
}

const RECENT = 64
/** Snapshot owners remembered, newest last; past it the oldest is forgotten (its notice is then lost, never wrong). */
const OWNERS = 512
const SLOW_MS = 5_000
const BROKER: DriverConsumer = { kind: "broker", label: "broker" }

const okHead = Buffer.from('{"ok":true')
const isErrorNeedle = Buffer.from('"isError":true')

const WindowArgumentsSchema = z.looseObject({
  pid: z.number().int(),
  window_id: z.number().int(),
  include_accessibility_tree: z.boolean().optional(),
})

/** The code a driver refusal carries, never its words, which can quote a window. */
const RefusalSchema = z.looseObject({ code: z.string().optional(), refusal: z.looseObject({ code: z.string() }).optional() })

/** The window a call names, as `pid:window_id`. */
function windowOf(args: JsonObject): string | undefined {
  const named = WindowArgumentsSchema.safeParse(args)
  return named.success ? `${named.data.pid}:${named.data.window_id}` : undefined
}

/** The tree reads that replace a window's snapshot: a window state that walks the tree. */
function snapshotKey(name: string, args: JsonObject): string | undefined {
  if (name !== "get_window_state") return undefined
  const named = WindowArgumentsSchema.safeParse(args)
  return named.success && named.data.include_accessibility_tree !== false ? `${named.data.pid}:${named.data.window_id}` : undefined
}

/**
 * How a raw reply went, without parsing it: the daemon writes `ok` first, and
 * a result's `"isError":true` can't occur inside a string, where its quotes
 * would be escaped. Logging only; consumers parse the reply themselves.
 */
function outcomeOf(line: Buffer): Outcome {
  if (!line.subarray(0, okHead.length).equals(okHead)) return "refused"
  return line.includes(isErrorNeedle) ? "error" : "ok"
}

export class DriverBroker {
  private readonly options: DriverBrokerOptions
  private connected: Generation | undefined
  private opening: Promise<Generation> | undefined
  private generations = 0
  private reconnects = 0
  private closed = false
  /** The last refusal of a daemon's contract, logged once. */
  private refused: string | undefined
  private readonly leases = new Map<string, Lease>()
  /** Who last read each window's tree, at a daemon whose snapshots are shared: `pid:window_id` → lease id. */
  private readonly owners = new Map<string, string>()
  private readonly recent: CallRecord[] = []
  private readonly totals = { calls: 0, errors: 0, bytes: 0, superseded: 0, leases: 0 }
  private readonly grants = new Map<string, string>()
  private server: Promise<{ path: string; server: Server; close(): Promise<void> }> | undefined
  private endpointPath: string | null = null

  constructor(options: DriverBrokerOptions) {
    this.options = options
  }

  private log(message: string, fields: Record<string, string | number | boolean | undefined> = {}) {
    this.options.log?.(message, fields)
  }

  /* The daemon --------------------------------------------------------------- */

  /** The connected daemon, connecting once however many consumers ask at the same moment. */
  private generation(): Promise<Generation> {
    if (this.closed) return Promise.reject(new DriverNotDispatchedError("Mako's driver broker has stopped; nothing was dispatched."))
    const current = this.connected
    if (current && !current.lost) return Promise.resolve(current)
    return (this.opening ??= this.open().finally(() => {
      this.opening = undefined
    }))
  }

  private async open(): Promise<Generation> {
    const started = performance.now()
    // A daemon that just stopped is replaced on the same socket by its owner
    // (`CuaEmbedded`), which may not have seen the exit yet: ask again briefly.
    const deadline = Date.now() + 5_000
    for (;;) {
      const socket = await this.options.socket()
      if (!socket) throw new DriverNotDispatchedError("Mako's computer-use driver isn't available on this Mac; nothing was dispatched.")
      const [description, sentinel] = await Promise.allSettled([describeDaemon(socket), openDaemonLease(socket, leaseIdentity())])
      if (description.status === "fulfilled" && sentinel.status === "fulfilled") {
        if (this.closed) {
          sentinel.value.close()
          throw new DriverNotDispatchedError("Mako's driver broker has stopped; nothing was dispatched.")
        }
        const mismatch = daemonMismatch(description.value)
        if (mismatch) {
          sentinel.value.close()
          if (this.refused !== mismatch)
            this.log("driver refused", { version: description.value.version, contract: description.value.contract, pid: description.value.pid })
          this.refused = mismatch
          throw new DriverNotDispatchedError(mismatch)
        }
        this.refused = undefined
        const generation: Generation = {
          number: ++this.generations,
          socket,
          description: description.value,
          connectedAt: Date.now(),
          connectMs: Math.round(performance.now() - started),
          leases: new Set(),
          sentinel: sentinel.value,
          lost: false,
          warm: { state: "cold" },
        }
        if (generation.number > 1) this.reconnects++
        this.connected = generation
        void sentinel.value.ended.then(() => this.lose(generation))
        this.log("driver connected", {
          generation: generation.number,
          ms: generation.connectMs,
          version: description.value.version,
          contract: description.value.contract,
          snapshots: description.value.snapshots,
          pid: description.value.pid,
          tools: description.value.tools.length,
        })
        // The first picture a daemon takes costs seconds whoever asks; take it now, once.
        void this.warm()
        return generation
      }
      if (sentinel.status === "fulfilled") sentinel.value.close()
      const failure = description.status === "rejected" ? description.reason : sentinel.status === "rejected" ? sentinel.reason : undefined
      if (!(failure instanceof DaemonUnavailableError) || Date.now() > deadline || this.closed)
        throw failure instanceof Error ? failure : new Error("The native driver could not be reached")
      await delay(100)
    }
  }

  /** The daemon went away: every lease on it ends, and with consumers about, the next daemon is connected and warmed now. */
  private lose(generation: Generation) {
    if (generation.lost) return
    generation.lost = true
    if (this.connected === generation) this.connected = undefined
    const leases = [...generation.leases]
    const inFlight = leases.reduce((count, lease) => count + lease.inFlight.size, 0)
    for (const lease of leases) this.end(lease)
    this.log("driver lost", { generation: generation.number, leases: leases.length, inFlight })
    if (!this.closed && leases.some((lease) => lease.consumer.kind !== "broker")) void this.generation().catch(() => {})
  }

  /**
   * Warm the daemon's first window picture, once per daemon; a warm-up that
   * was skipped (no Screen Recording yet) or failed is tried again next
   * time. Callers go on at once; the promise is for whoever wants to know.
   */
  warm(): Promise<void> {
    return this.generation().then(
      (generation) => (generation.warming ??= this.warmUp(generation)),
      () => {}
    )
  }

  private async warmUp(generation: Generation): Promise<void> {
    generation.warm = { state: "warming" }
    const lease = await this.lease(BROKER, { parallel: true }).catch(() => undefined)
    if (!lease) {
      generation.warm = { state: "failed" }
      generation.warming = undefined
      return
    }
    const read: AppshotRead = async (name, args) => {
      const result = daemonToolResult(parseReply(await this.dispatch(lease, name, args).reply))
      if (result.isError) {
        const refusal = RefusalSchema.safeParse(result.structuredContent ?? {}).data
        throw new Error(`${name} was refused (${refusal?.code ?? refusal?.refusal?.code ?? "no code"})`)
      }
      return result
    }
    try {
      const ms = await warmAppshots(read, this.options.own?.() ?? [])
      if (ms === null) {
        generation.warm = { state: "skipped" }
        generation.warming = undefined
        this.log("driver warm-up skipped", { generation: generation.number, reason: "no screen recording or no window" })
      } else {
        generation.warm = { state: "warm", ms }
        this.log("driver warmed", { generation: generation.number, ms })
      }
    } catch (error) {
      generation.warm = { state: "failed" }
      generation.warming = undefined
      this.log("driver warm-up failed", { generation: generation.number, reason: error instanceof Error ? error.message : String(error) })
    } finally {
      lease.close()
    }
  }

  /* Leases ------------------------------------------------------------------- */

  private async lease(consumer: DriverConsumer, options: { parallel?: boolean } = {}): Promise<Lease> {
    const generation = await this.generation()
    const identity = leaseIdentity()
    let control: Awaited<ReturnType<typeof openDaemonLease>>
    try {
      control = await openDaemonLease(generation.socket, identity)
    } catch (error) {
      if (error instanceof DaemonUnavailableError) this.lose(generation)
      throw new DriverNotDispatchedError(`The native driver could not be reached (${error instanceof Error ? error.message : String(error)}); nothing was dispatched.`)
    }
    const lease: Lease = {
      id: randomUUID(),
      identity,
      consumer,
      parallel: options.parallel ?? false,
      generation,
      opened: Date.now(),
      tail: Promise.resolve(),
      queued: 0,
      inFlight: new Set(),
      calls: 0,
      errors: 0,
      superseded: 0,
      ended: false,
      close: () => this.end(lease),
      endListeners: [],
      supersededListeners: [],
    }
    this.leases.set(lease.id, lease)
    generation.leases.add(lease)
    this.totals.leases++
    // The daemon never closes a lease of its own accord: one that closes from
    // its side is the daemon going, often noticed here before the sentinel.
    void control.ended.then(() => {
      if (!lease.ended) this.lose(generation)
      this.end(lease)
    })
    lease.endListeners.push(() => control.close())
    if (consumer.kind !== "broker") this.log("lease opened", { consumer: consumer.label, mode: lease.parallel ? "parallel" : "serial", generation: generation.number })
    if (generation.lost) this.end(lease)
    return lease
  }

  private end(lease: Lease) {
    if (lease.ended) return
    lease.ended = true
    this.leases.delete(lease.id)
    lease.generation.leases.delete(lease)
    if (lease.consumer.kind !== "broker")
      this.log("lease closed", { consumer: lease.consumer.label, calls: lease.calls, errors: lease.errors, ms: Date.now() - lease.opened })
    for (const listener of lease.endListeners.splice(0)) listener()
  }

  /**
   * One call on `lease`, its raw reply line. The daemon runs a call it has
   * taken to the end, so it is never cancelled here: a caller that stops
   * waiting leaves it running, and a serial lease's next call waits for it,
   * as it did behind a proxy. A call still queued when its caller gives up
   * is never sent.
   */
  private dispatch(lease: Lease, name: string, args: JsonObject, wanted?: AbortSignal): Dispatched {
    const record: CallRecord = { consumer: lease.consumer.label, tool: name, at: Date.now(), queuedMs: 0 }
    if (lease.ended) return { reply: Promise.reject(new DriverNotDispatchedError("This driver lease has ended; nothing was dispatched. The next call connects again.")), record }
    const window = windowOf(args)
    if (window) record.window = window
    const queued = performance.now()
    const run = async (): Promise<Buffer> => {
      record.queuedMs = Math.round(performance.now() - queued)
      if (lease.ended) throw new DriverNotDispatchedError("This driver lease has ended; nothing was dispatched. The next call connects again.")
      if (wanted?.aborted) {
        record.outcome = "cancelled"
        this.remember(lease, record)
        throw new DriverNotDispatchedError("The call was cancelled before the driver took it; nothing was dispatched.")
      }
      const started = performance.now()
      lease.inFlight.add(record)
      try {
        const line = await exchange(lease.generation.socket, {
          method: "call",
          name,
          args,
          session_id: lease.identity,
          ...(lease.generation.description.observes && { observation_origin: "mcp_proxy" as const }),
        })
        record.bytes = line.length
        record.outcome = outcomeOf(line)
        if (record.outcome === "ok") this.published(lease, name, args)
        return line
      } catch (error) {
        record.outcome = error instanceof DaemonUnavailableError ? "unavailable" : "closed"
        if (error instanceof DaemonUnavailableError) this.lose(lease.generation)
        throw error instanceof DaemonUnavailableError
          ? new DriverNotDispatchedError("The native driver isn't running; nothing was dispatched. The next call starts it again.")
          : new ComputerDriverExitedError({ cause: error })
      } finally {
        record.ms = Math.round(performance.now() - started)
        lease.inFlight.delete(record)
        this.remember(lease, record)
      }
    }
    if (lease.parallel) return { reply: run(), record }
    lease.queued++
    const task = lease.tail.then(() => {
      lease.queued--
      return run()
    })
    lease.tail = task.then(
      () => {},
      () => {}
    )
    return { reply: task, record }
  }

  private remember(lease: Lease, record: CallRecord) {
    lease.calls++
    lease.last = record
    this.totals.calls++
    this.totals.bytes += record.bytes ?? 0
    const failed = record.outcome !== "ok" && record.outcome !== "error" && record.outcome !== "cancelled"
    if (failed) {
      lease.errors++
      this.totals.errors++
    }
    this.recent.push(record)
    if (this.recent.length > RECENT) this.recent.shift()
    if (failed || (record.ms ?? 0) >= SLOW_MS)
      this.log(failed ? "driver call failed" : "driver call slow", {
        consumer: record.consumer,
        tool: record.tool,
        window: record.window,
        ms: record.ms,
        queuedMs: record.queuedMs,
        outcome: record.outcome,
      })
  }

  /**
   * A tree read landed: at a daemon whose snapshots are shared, whoever read
   * the window before is told their snapshot is gone. A daemon that keeps each
   * lease's snapshots apart replaced nobody's.
   */
  private published(lease: Lease, name: string, args: JsonObject) {
    if (lease.generation.description.snapshots === "lease") return
    const key = snapshotKey(name, args)
    if (!key) return
    const previous = this.owners.get(key)
    this.owners.delete(key)
    this.owners.set(key, lease.id)
    if (this.owners.size > OWNERS) this.owners.delete(this.owners.keys().next().value!)
    if (!previous || previous === lease.id) return
    const owner = this.leases.get(previous)
    if (!owner || owner.ended) return
    const [pid, window] = key.split(":").map(Number)
    const event: DriverSuperseded = { pid: pid!, window_id: window!, by: lease.consumer.kind }
    owner.superseded++
    this.totals.superseded++
    for (const listener of owner.supersededListeners) listener(event)
  }

  /* In-process consumers ----------------------------------------------------- */

  /**
   * A driver connection for a consumer in this process, on a lease of its
   * own. `parallel` lets its calls overlap; it is for a consumer that only
   * reads, such as Appshots.
   */
  async connect(consumer: DriverConsumer, options: { parallel?: boolean } = {}): Promise<ComputerDriverClient> {
    const lease = await this.lease(consumer, options)
    return new LocalBrokeredDriver(lease, async (name, args, call) => {
      const { reply, record } = this.dispatch(lease, name, args, call.signal)
      const line = await waitFor(reply, name, call, () => {
        if (record.ms === undefined) record.abandoned = true
      })
      return daemonToolResult(parseReply(line))
    })
  }

  /* Out-of-process consumers ------------------------------------------------- */

  /**
   * Where a task's worker reaches the broker, and the grant that names the
   * task. Starting a task's session also starts the daemon in the background,
   * as it always did, so its first call doesn't wait for it.
   */
  async grant(label: string): Promise<BrokeredDriverEndpoint> {
    const { path } = await (this.server ??= this.listen())
    const token = randomBytes(24).toString("base64url")
    this.grants.set(token, label)
    void this.generation().catch(() => {})
    return { broker: path, token }
  }

  /** The task ended: its grants stop working and its leases end. */
  revoke(label: string): void {
    for (const [token, granted] of this.grants) if (granted === label) this.grants.delete(token)
    for (const lease of this.leases.values()) if (lease.consumer.label === label) this.end(lease)
  }

  private async listen() {
    const directory = await createControlDirectory("mako-driver-")
    const endpoint = await createPrivateControlSocket(directory, "broker.sock")
    const server = createServer((connection) => this.serve(connection))
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject)
        server.listen(endpoint.path, () => {
          server.off("error", reject)
          resolve()
        })
      })
      await chmod(endpoint.path, 0o600)
      this.endpointPath = endpoint.path
    } catch (error) {
      server.close()
      await endpoint.close()
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    return {
      path: endpoint.path,
      server,
      close: async () => {
        this.endpointPath = null
        server.close()
        await endpoint.close()
        await rm(directory, { recursive: true, force: true })
      },
    }
  }

  private serve(connection: Socket) {
    connection.on("error", () => connection.destroy())
    const answer = (fault: BrokerFault) => connection.end(`${JSON.stringify(fault)}\n`)
    void readLine(connection, 1024 * 1024)
      .then(async (line) => {
        const request = BrokerRequestSchema.safeParse(JSON.parse(line.toString("utf8")))
        if (!request.success) return answer({ ok: false, broker: "invalid", error: "Not a driver broker request; nothing was dispatched." })
        if (request.data.method === "lease") {
          const label = this.grants.get(request.data.token)
          if (!label) return answer({ ok: false, broker: "ended", error: "This task's driver grant has ended; nothing was dispatched." })
          let lease: Lease
          try {
            lease = await this.lease({ kind: "agent", label }, { parallel: request.data.parallel })
          } catch (error) {
            return answer({ ok: false, broker: "unavailable", error: error instanceof Error ? error.message : String(error) })
          }
          connection.write(
            `${JSON.stringify({
              ok: true,
              lease: lease.id,
              consumer: label,
              generation: lease.generation.number,
              snapshots: lease.generation.description.snapshots,
              tools: lease.generation.description.tools,
            })}\n`
          )
          lease.supersededListeners.push((event) => connection.write(`${JSON.stringify({ event: "superseded", ...event })}\n`))
          lease.endListeners.push(() => connection.end())
          connection.once("close", () => this.end(lease))
          connection.resume()
          return
        }
        const lease = this.leases.get(request.data.lease)
        if (!lease || lease.consumer.kind !== "agent")
          return answer({ ok: false, broker: "ended", error: "This driver lease has ended; nothing was dispatched. The next call connects again." })
        const stopped = new AbortController()
        const { reply, record } = this.dispatch(lease, request.data.name, request.data.args, stopped.signal)
        connection.once("close", () => {
          stopped.abort()
          if (record.ms === undefined) record.abandoned = true
        })
        try {
          const line = await reply
          // The daemon's reply goes back as it came, never parsed here.
          if (!connection.destroyed) connection.end(Buffer.concat([line, Buffer.from("\n")]))
        } catch (error) {
          answer(
            error instanceof ComputerDriverExitedError
              ? { ok: false, broker: "closed", error: error.message }
              : { ok: false, broker: error instanceof DriverNotDispatchedError ? "unavailable" : "closed", error: error instanceof Error ? error.message : String(error) }
          )
        }
      })
      .catch(() => connection.destroy())
  }

  /* The readout -------------------------------------------------------------- */

  status(): DriverBrokerStatus {
    const now = Date.now()
    const current = this.connected
    const leases = [...this.leases.values()].filter((lease) => lease.consumer.kind !== "broker")
    return {
      daemon: current
        ? {
            state: "connected",
            generation: current.number,
            version: current.description.version,
            contract: current.description.contract,
            snapshots: current.description.snapshots,
            ...(current.description.pid !== undefined && { pid: current.description.pid }),
            socket: current.socket,
            connectedForMs: now - current.connectedAt,
            connectMs: current.connectMs,
            tools: current.description.tools.length,
          }
        : { state: this.opening ? "connecting" : "idle" },
      warm: current?.warm ?? { state: "cold" },
      reconnects: this.reconnects,
      endpoint: this.endpointPath,
      consumers: leases.map((lease) => ({
        consumer: lease.consumer.label,
        kind: lease.consumer.kind,
        mode: lease.parallel ? "parallel" : "serial",
        leasedForMs: now - lease.opened,
        calls: lease.calls,
        errors: lease.errors,
        queued: lease.queued,
        inFlight: lease.inFlight.size,
        superseded: lease.superseded,
        ...(lease.last && { last: { tool: lease.last.tool, ms: lease.last.ms, outcome: lease.last.outcome, agoMs: now - lease.last.at } }),
      })),
      inFlight: [...this.leases.values()].flatMap((lease) =>
        [...lease.inFlight].map((record) => ({
          consumer: record.consumer,
          tool: record.tool,
          ...(record.window && { window: record.window }),
          runningMs: now - record.at - record.queuedMs,
          abandoned: record.abandoned === true,
        }))
      ),
      recent: this.recent.map((record) => ({
        at: new Date(record.at).toISOString(),
        consumer: record.consumer,
        tool: record.tool,
        ...(record.window && { window: record.window }),
        queuedMs: record.queuedMs,
        ms: record.ms,
        bytes: record.bytes,
        outcome: record.outcome,
        ...(record.abandoned && { abandoned: true }),
      })),
      totals: { ...this.totals },
    }
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const lease of this.leases.values()) this.end(lease)
    this.grants.clear()
    const current = this.connected
    this.connected = undefined
    if (current) {
      current.lost = true
      current.sentinel.close()
    }
    await (await this.server?.catch(() => undefined))?.close()
  }
}

/** A consumer in the host's own process, on its lease. */
class LocalBrokeredDriver implements ComputerDriverClient {
  private readonly lease: Lease
  private readonly call: (name: string, args: JsonObject, options: ComputerDriverCallOptions) => Promise<ComputerDriverResult>

  constructor(lease: Lease, call: (name: string, args: JsonObject, options: ComputerDriverCallOptions) => Promise<ComputerDriverResult>) {
    this.lease = lease
    this.call = call
  }

  listTools(): Promise<Tool[]> {
    return Promise.resolve(this.lease.generation.description.tools)
  }

  callTool(name: string, args: JsonObject, options: ComputerDriverCallOptions = {}): Promise<ComputerDriverResult> {
    return this.call(name, args, options)
  }

  onClose(listener: () => void): void {
    if (this.lease.ended) listener()
    else this.lease.endListeners.push(listener)
  }

  onSuperseded(listener: (event: DriverSuperseded) => void): void {
    this.lease.supersededListeners.push(listener)
  }

  describe(): JsonObject {
    return {
      via: "broker",
      consumer: this.lease.consumer.label,
      generation: this.lease.generation.number,
      snapshots: this.lease.generation.description.snapshots,
      open: !this.lease.ended,
      calls: this.lease.calls,
    }
  }

  close(): Promise<void> {
    this.lease.close()
    return Promise.resolve()
  }
}
