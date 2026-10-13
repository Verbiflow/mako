import { createConnection, type Socket } from "node:net"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  ComputerDriverExitedError,
  type ComputerDriverCallOptions,
  type ComputerDriverClient,
  type ComputerDriverResult,
  type DriverSuperseded,
} from "./computer-driver-client.js"
import { DaemonClosedError, DaemonReplySchema, daemonToolResult, readLine, type SnapshotScope } from "./driver-daemon.js"
import type { JsonObject } from "./json.js"

/**
 * A worker's way to the host's driver broker (`DriverBroker`): the private
 * socket it listens on and the grant that names this task. A worker opens
 * no driver connection of its own.
 */
export interface BrokeredDriverEndpoint {
  broker: string
  token: string
}

/**
 * The broker's socket protocol, one JSON line each way per connection. A
 * `lease` connection stays open: its reply carries the lease, who owns its
 * snapshots and the daemon's tools; then, at a daemon whose snapshots are
 * shared, `superseded` events follow; and either side closing it ends the
 * lease. A `call` connection carries one call and its reply,
 * which is the daemon's own reply line, relayed unread; a fault the broker
 * answers itself carries `broker`.
 */
export const BrokerRequestSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("lease"), token: z.string().min(1), parallel: z.boolean().optional() }).strict(),
  z
    .object({
      method: z.literal("call"),
      lease: z.string().min(1),
      name: z.string().min(1).max(128),
      args: z.record(z.string(), z.json()),
    })
    .strict(),
])
export type BrokerRequest = z.infer<typeof BrokerRequestSchema>

/** Why the broker answered a call itself. Only `closed` means the call reached the daemon. */
export const BrokerFaultSchema = z.object({
  ok: z.literal(false),
  broker: z.enum(["unavailable", "ended", "closed", "invalid"]),
  error: z.string(),
})
export type BrokerFault = z.infer<typeof BrokerFaultSchema>

const LeaseReplySchema = z.union([
  z.object({
    ok: z.literal(true),
    lease: z.string(),
    consumer: z.string(),
    generation: z.number(),
    snapshots: z.enum(["lease", "window"]),
    tools: z.array(z.looseObject({ name: z.string() })),
  }),
  BrokerFaultSchema,
])
const EventSchema = z.object({
  event: z.literal("superseded"),
  pid: z.number().int(),
  window_id: z.number().int(),
  by: z.string(),
})

/** A call the broker answered without reaching the daemon: nothing was dispatched. */
export class DriverNotDispatchedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DriverNotDispatchedError"
  }
}

/** Map the broker's own answer to the error a consumer acts on. */
export function brokerFaultError(fault: BrokerFault): Error {
  return fault.broker === "closed" ? new ComputerDriverExitedError({ cause: new Error(fault.error) }) : new DriverNotDispatchedError(fault.error)
}

/** Settle on `work`, or stop waiting for it when `signal` aborts or `timeout` passes; the work itself goes on. */
export async function waitFor<T>(work: Promise<T>, name: string, options: ComputerDriverCallOptions, stop?: () => void): Promise<T> {
  const { signal, timeout } = options
  if (!signal && !timeout) return work
  let quit!: (error: Error) => void
  const stopped = new Promise<never>((_, reject) => {
    quit = (error) => {
      stop?.()
      reject(error)
    }
  })
  const timer = timeout
    ? setTimeout(() => quit(new Error(`The native driver didn't answer ${name} within ${Math.round(timeout / 1000)} s; it may still be running. Observe before acting again.`)), timeout)
    : undefined
  const aborted = () => quit(signal?.reason instanceof Error ? signal.reason : new Error("The call was cancelled"))
  signal?.addEventListener("abort", aborted, { once: true })
  try {
    if (signal?.aborted) aborted()
    return await Promise.race([work, stopped])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", aborted)
  }
}

function connect(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path)
    socket.once("connect", () => {
      socket.removeAllListeners("error")
      resolve(socket)
    })
    socket.once("error", () =>
      reject(new DriverNotDispatchedError("Mako's driver broker isn't reachable; nothing was dispatched. The next call connects again."))
    )
  })
}

class RemoteBrokeredDriver implements ComputerDriverClient {
  private readonly closeListeners: Array<() => void> = []
  private readonly supersededListeners: Array<(event: DriverSuperseded) => void> = []
  private ended = false
  private readonly endpoint: BrokeredDriverEndpoint
  private readonly control: Socket
  private readonly lease: string
  private readonly tools: Tool[]
  readonly consumer: string
  readonly generation: number
  readonly snapshots: SnapshotScope
  private calls = 0
  private inFlight = 0

  constructor(endpoint: BrokeredDriverEndpoint, control: Socket, reply: { lease: string; consumer: string; generation: number; snapshots: SnapshotScope; tools: Tool[] }) {
    this.endpoint = endpoint
    this.control = control
    this.lease = reply.lease
    this.consumer = reply.consumer
    this.generation = reply.generation
    this.snapshots = reply.snapshots
    this.tools = reply.tools
    void this.listen()
  }

  private async listen() {
    try {
      for (;;) {
        const event = EventSchema.safeParse(JSON.parse((await readLine(this.control, 64 * 1024)).toString("utf8")))
        if (!event.success) continue
        const notice: DriverSuperseded = { pid: event.data.pid, window_id: event.data.window_id, by: event.data.by }
        for (const listener of this.supersededListeners) listener(notice)
      }
    } catch {
      // The broker closed the lease, or this end did.
    }
    this.end()
  }

  private end() {
    if (this.ended) return
    this.ended = true
    this.control.destroy()
    for (const listener of this.closeListeners.splice(0)) listener()
  }

  listTools(): Promise<Tool[]> {
    return Promise.resolve(this.tools)
  }

  async callTool(name: string, args: JsonObject, options: ComputerDriverCallOptions = {}): Promise<ComputerDriverResult> {
    if (this.ended) throw new DriverNotDispatchedError("This driver lease has ended; nothing was dispatched. The next call connects again.")
    const socket = await connect(this.endpoint.broker)
    this.calls++
    this.inFlight++
    socket.write(`${JSON.stringify({ method: "call", lease: this.lease, name, args } satisfies BrokerRequest)}\n`)
    try {
      const line = await waitFor(readLine(socket), name, options, () => socket.destroy())
      const raw: unknown = JSON.parse(line.toString("utf8"))
      const fault = BrokerFaultSchema.safeParse(raw)
      if (fault.success) throw brokerFaultError(fault.data)
      return daemonToolResult(DaemonReplySchema.parse(raw))
    } catch (error) {
      // The broker's connection dropping mid-call is the driver going away under it.
      if (error instanceof DaemonClosedError) throw new ComputerDriverExitedError({ cause: error })
      throw error
    } finally {
      this.inFlight--
      socket.destroy()
    }
  }

  onClose(listener: () => void): void {
    if (this.ended) listener()
    else this.closeListeners.push(listener)
  }

  onSuperseded(listener: (event: DriverSuperseded) => void): void {
    this.supersededListeners.push(listener)
  }

  describe(): JsonObject {
    return {
      via: "broker",
      consumer: this.consumer,
      generation: this.generation,
      snapshots: this.snapshots,
      open: !this.ended,
      calls: this.calls,
      inFlight: this.inFlight,
    }
  }

  close(): Promise<void> {
    this.end()
    return Promise.resolve()
  }
}

/**
 * Lease a driver connection from the host's broker. The lease is this
 * task's identity at the driver: its sessions, cursor and recordings are
 * its own, and end when it does. `parallel` lets its calls overlap; without
 * it they run one after another, as a task's calls always have.
 */
export async function connectBrokeredDriver(endpoint: BrokeredDriverEndpoint, options: { parallel?: boolean } = {}): Promise<ComputerDriverClient> {
  const control = await connect(endpoint.broker)
  try {
    control.write(`${JSON.stringify({ method: "lease", token: endpoint.token, parallel: options.parallel } satisfies BrokerRequest)}\n`)
    const reply = LeaseReplySchema.parse(JSON.parse((await readLine(control)).toString("utf8")))
    if (!reply.ok) throw brokerFaultError(reply)
    return new RemoteBrokeredDriver(endpoint, control, {
      lease: reply.lease,
      consumer: reply.consumer,
      generation: reply.generation,
      snapshots: reply.snapshots,
      // SAFETY: the broker sends the tools `describeDaemon` shaped as MCP tools, unchanged.
      tools: reply.tools as Tool[],
    })
  } catch (error) {
    control.destroy()
    throw error
  }
}
