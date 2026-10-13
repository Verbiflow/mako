import { randomUUID } from "node:crypto"
import { createConnection, type Socket } from "node:net"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { ComputerDriverResultSchema, type ComputerDriverResult } from "./computer-driver-client.js"
import type { JsonObject } from "./json.js"

/**
 * The native driver daemon's own protocol, which its `cua-driver mcp` proxy
 * speaks on the far side: one JSON object per line over the daemon's Unix
 * socket. A `session_begin` on a connection kept open makes that connection a
 * transport lease: every `session` a call names under it belongs to it, and
 * the daemon ends them all when the connection closes. Each `call` goes on a
 * connection of its own, so calls run side by side; the daemon answers each
 * connection's lines in order, which is why a proxy, reading one call at a
 * time, held a quick read behind a slow one for as long as the slow one ran
 * (3.1 s behind a 3 s `verify_state`, measured on 0.28.2+mako.24).
 *
 * The reply to a call is the proxy's MCP result as it is, under `{ok:true}`;
 * a call the daemon refused outright is `{ok:false, error, exit_code}`, which
 * the proxy turns into a `tool_invocation_failed` result (`daemonToolResult`).
 */

export const DaemonReplySchema = z.looseObject({
  ok: z.boolean(),
  result: z.json().optional(),
  error: z.string().optional(),
  exit_code: z.number().optional(),
})
export type DaemonReply = z.infer<typeof DaemonReplySchema>

export interface DaemonRequest {
  method: "call" | "list" | "metadata" | "session_begin"
  name?: string
  args?: JsonObject
  /** The transport lease the call belongs to. */
  session_id?: string
  /** Which side records the call's completion; the proxy says it was the proxy. */
  observation_origin?: "mcp_proxy"
}

/** The daemon wasn't there to take the request: nothing was sent. */
export class DaemonUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("The native driver isn't running", options)
    this.name = "DaemonUnavailableError"
  }
}

/** The daemon took the request and closed without an answer: it stopped while the call ran. */
export class DaemonClosedError extends Error {
  constructor(options?: ErrorOptions) {
    super("The native driver stopped during the call", options)
    this.name = "DaemonClosedError"
  }
}

/** The proxy's per-call deadline (`send_request`): past it the daemon is taken as stuck. */
export const DAEMON_CALL_DEADLINE_MS = 120_000
/** A reply larger than this is not a reply; the widest observed (a 4000-element tree with its picture) is under 8 MB. */
const REPLY_LIMIT = 64 * 1024 * 1024

/** A socket error that means nothing listens there, so nothing was sent. */
const unreachable = (error: NodeJS.ErrnoException) => ["ENOENT", "ECONNREFUSED", "ENOTSOCK"].includes(error.code ?? "")

/** A connection to the daemon's socket, or the reason there is none. */
function connect(socket: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socket)
    const failed = (error: NodeJS.ErrnoException) =>
      reject(unreachable(error) ? new DaemonUnavailableError({ cause: error }) : new DaemonClosedError({ cause: error }))
    connection.once("error", failed)
    connection.once("connect", () => {
      connection.off("error", failed)
      resolve(connection)
    })
  })
}

/**
 * Collect one line from `socket`, as Buffers joined once at the end. Resolves
 * with the line (without its newline); `limit` bounds what is kept.
 */
export function readLine(socket: Socket, limit = REPLY_LIMIT): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    const finish = (error?: Error, line?: Buffer) => {
      socket.off("data", data)
      socket.off("end", ended)
      socket.off("close", ended)
      socket.off("error", failed)
      if (error) reject(error)
      else resolve(line!)
    }
    const data = (chunk: Buffer) => {
      const newline = chunk.indexOf(10)
      if (newline < 0) {
        size += chunk.length
        if (size > limit) return finish(new Error("The native driver's reply is too large"))
        chunks.push(chunk)
        return
      }
      chunks.push(chunk.subarray(0, newline))
      const rest = chunk.subarray(newline + 1)
      // What follows the line stays for the next reader.
      if (rest.length) socket.unshift(rest)
      socket.pause()
      finish(undefined, chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks))
    }
    const ended = () => finish(new DaemonClosedError())
    const failed = (error: Error) => finish(unreachable(error) ? new DaemonUnavailableError({ cause: error }) : new DaemonClosedError({ cause: error }))
    socket.on("data", data)
    socket.once("end", ended)
    socket.once("close", ended)
    socket.once("error", failed)
    socket.resume()
  })
}

/**
 * One request on a connection of its own, and its reply line, raw. Not
 * cancellable on purpose: the daemon runs a call it has read to the end
 * (the proxy drops MCP cancellations too), and its connection is how the
 * caller learns that it ended. A daemon silent past the deadline is stuck.
 */
export async function exchange(socket: string, request: DaemonRequest, deadlineMs = DAEMON_CALL_DEADLINE_MS): Promise<Buffer> {
  const connection = await connect(socket)
  const timer = setTimeout(() => connection.destroy(new Error(`no reply within ${deadlineMs / 1000} s`)), deadlineMs)
  try {
    connection.write(`${JSON.stringify(request)}\n`)
    return await readLine(connection)
  } finally {
    clearTimeout(timer)
    connection.destroy()
  }
}

export function parseReply(line: Buffer): DaemonReply {
  return DaemonReplySchema.parse(JSON.parse(line.toString("utf8")))
}

/** Ask the daemon one thing and read its answer; a refusal throws. */
async function ask(socket: string, request: DaemonRequest): Promise<JsonObject> {
  const reply = parseReply(await exchange(socket, request, 10_000))
  if (!reply.ok) throw new Error(`The native driver refused ${request.method}: ${reply.error ?? "no reason given"}`)
  return z.record(z.string(), z.json()).parse(reply.result ?? {})
}

/** A call's MCP result, as the proxy would have returned it. */
export function daemonToolResult(reply: DaemonReply): ComputerDriverResult {
  if (reply.ok) return ComputerDriverResultSchema.parse(reply.result ?? { content: [], isError: false })
  return {
    content: [{ type: "text", text: reply.error ?? "daemon reported failure" }],
    structuredContent: { code: "tool_invocation_failed", exit_code: reply.exit_code ?? 1 },
    isError: true,
  }
}

const DaemonToolSchema = z.looseObject({
  name: z.string(),
  description: z.string().optional(),
  input_schema: z.record(z.string(), z.json()).optional(),
  output_schema: z.record(z.string(), z.json()).optional(),
  read_only: z.boolean().optional(),
  destructive: z.boolean().optional(),
  idempotent: z.boolean().optional(),
  open_world: z.boolean().optional(),
})
const InputSchemaSchema = z.looseObject({ type: z.literal("object") })

/**
 * The daemon contract the broker speaks (`metadata.contract_version`, major
 * and minor): this line protocol, `session_begin` leases and the reply's shape.
 * A daemon of another contract is refused before anything is dispatched.
 */
export const DAEMON_CONTRACT = "0.8"

/**
 * Who owns a window's element snapshot at the daemon. `lease`: each lease
 * keeps its own (`metadata.snapshot_scope: "transport"`, from
 * `0003-transport-scoped-snapshots.patch`), so another consumer's read leaves
 * a lease's tokens alone. `window`: one per window for every caller, so any
 * tree read retires everyone else's tokens there (drivers before the patch).
 */
export type SnapshotScope = "lease" | "window"

/** What a daemon is and what it offers, read once per daemon. */
export interface DaemonDescription {
  version: string
  /** `metadata.contract_version`, or `unknown` from a daemon that doesn't say. */
  contract: string
  pid: number | undefined
  tools: Tool[]
  /** The daemon records each call's completion when the caller says who it is (`observation_origin`). */
  observes: boolean
  snapshots: SnapshotScope
}

/** Why the broker can't speak to this daemon, or null when it can. */
export function daemonMismatch(description: DaemonDescription): string | null {
  const [major, minor] = description.contract.split(".")
  if (`${major}.${minor}` === DAEMON_CONTRACT) return null
  return `The native driver ${description.version} speaks daemon contract ${description.contract}, and Mako's driver broker speaks ${DAEMON_CONTRACT}.x. Install the driver this build of Mako ships; nothing was dispatched.`
}

/** The daemon's version and its tools in MCP's shape, the reshaping the proxy does once at its start. */
export async function describeDaemon(socket: string): Promise<DaemonDescription> {
  const [metadata, listed] = await Promise.all([ask(socket, { method: "metadata" }), ask(socket, { method: "list" })])
  const tools = z.array(DaemonToolSchema).parse(listed.tools).map((entry): Tool => {
    const tool: Tool = {
      name: entry.name,
      description: entry.description ?? "",
      inputSchema: InputSchemaSchema.parse(entry.input_schema ?? { type: "object", properties: {} }),
      annotations: {
        readOnlyHint: entry.read_only ?? false,
        destructiveHint: entry.destructive ?? false,
        idempotentHint: entry.idempotent ?? false,
        openWorldHint: entry.open_world ?? false,
      },
    }
    if (entry.output_schema) tool.outputSchema = InputSchemaSchema.parse(entry.output_schema)
    return tool
  })
  return {
    version: z.string().catch("unknown").parse(metadata.driver_version),
    contract: z.string().catch("unknown").parse(metadata.contract_version),
    pid: z.number().int().positive().optional().catch(undefined).parse(metadata.pid),
    tools,
    observes: listed.tool_observation_owner === "daemon",
    snapshots: metadata.snapshot_scope === "transport" ? "lease" : "window",
  }
}

/** A transport identity the daemon reads as an MCP proxy's, unique among this daemon's leases. */
export function leaseIdentity(): string {
  return `mcp-mako-${process.pid}-${randomUUID().slice(0, 8)}`
}

/**
 * Open a transport lease: a connection that says `session_begin` and stays
 * open. `ended` settles when the daemon closes it (it stopped) or `close`
 * does; the daemon then ends every session named under it.
 */
export async function openDaemonLease(socket: string, identity: string): Promise<{ ended: Promise<void>; close(): void }> {
  const connection = await connect(socket)
  const timer = setTimeout(() => connection.destroy(new Error("session_begin was not acknowledged")), 4_000)
  try {
    connection.write(`${JSON.stringify({ method: "session_begin", session_id: identity } satisfies DaemonRequest)}\n`)
    const reply = parseReply(await readLine(connection, 64 * 1024))
    if (!reply.ok || !z.looseObject({ session_begin: z.literal(true) }).safeParse(reply.result).success)
      throw new Error("The native driver refused the connection's lease")
  } catch (error) {
    connection.destroy()
    throw error
  } finally {
    clearTimeout(timer)
  }
  const ended = new Promise<void>((done) => connection.once("close", () => done()))
  connection.on("error", () => connection.destroy())
  // Nothing more is said on a lease; anything that comes is drained.
  connection.resume()
  return { ended, close: () => connection.destroy() }
}
