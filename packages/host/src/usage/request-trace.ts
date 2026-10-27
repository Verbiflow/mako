import { subscribe, unsubscribe, type ChannelListener } from "node:diagnostics_channel"
import { Socket } from "node:net"
import { z } from "zod"

/**
 * Where a call to the cloud got to, from what the HTTP client says of it on its diagnostics channels: whether it went
 * out at all, on which connection (opened for it, or kept from earlier calls, and how long that one had been quiet),
 * whether its body went, and whether an answer came. A call that fails or never hears back says which of these it
 * reached, so a stall reads as "never left this Mac" or "went out on a connection that then said nothing", which the
 * cloud's own log can't tell apart: it sees neither.
 *
 * Calls are told apart by the correlation ID each carries. The channels are the process's, so this listens only while
 * one of its calls is on its way.
 */
export class RequestTraces {
  readonly #header: string
  readonly #now: () => number
  readonly #calls = new Map<string, Trace>()
  /** The client's own request objects, for the channels that name only those. */
  readonly #requests = new WeakMap<ClientRequest, Trace>()
  /** Each connection a call went out on: when its first call went, how many went, and when the last was answered. */
  readonly #connections = new WeakMap<Socket, ConnectionUse>()
  readonly #listeners: Array<[string, ChannelListener]>

  constructor(header: string, now: () => number = () => performance.now()) {
    this.#header = header
    this.#now = now
    this.#listeners = [
      ["undici:request:create", aboutRequests((message) => this.#created(message))],
      ["undici:client:sendHeaders", aboutRequests((message) => this.#sent(message))],
      ["undici:request:bodySent", aboutRequests((message) => this.#bodySent(message))],
      ["undici:request:headers", aboutRequests((message) => this.#answered(message))],
    ]
  }

  /** A call about to go under `correlationId`: its trace, ended by `end` however it went. */
  follow(correlationId: string): Trace {
    const trace: Trace = new Trace(this.#now, () => {
      if (this.#calls.get(correlationId) !== trace) return
      this.#calls.delete(correlationId)
      if (this.#calls.size === 0) for (const [name, listener] of this.#listeners) unsubscribe(name, listener)
    })
    if (this.#calls.size === 0) for (const [name, listener] of this.#listeners) subscribe(name, listener)
    this.#calls.set(correlationId, trace)
    return trace
  }

  #created({ request }: RequestMessage): void {
    const id = headerValue(request, this.#header)
    const trace = id === undefined ? undefined : this.#calls.get(id)
    if (!trace) return
    this.#requests.set(request, trace)
    trace.body = request.body !== null && request.body !== undefined
  }

  #sent({ request, socket }: RequestMessage): void {
    const trace = this.#requests.get(request)
    if (!trace || !socket) return
    const at = this.#now()
    const used = this.#connections.get(socket)
    trace.sent = used
      ? { at, connection: { kind: "kept", calls: used.calls, openMs: at - used.first, quietMs: used.answeredAt === undefined ? undefined : at - used.answeredAt } }
      : { at, connection: { kind: "new" } }
    trace.socket = socket
    if (used) used.calls += 1
    else this.#connections.set(socket, { first: at, calls: 1 })
  }

  #bodySent({ request }: RequestMessage): void {
    const trace = this.#requests.get(request)
    if (trace) trace.bodySentAt = this.#now()
  }

  #answered({ request }: RequestMessage): void {
    const trace = this.#requests.get(request)
    if (!trace) return
    trace.answeredAt = this.#now()
    const used = trace.socket && this.#connections.get(trace.socket)
    if (used) used.answeredAt = trace.answeredAt
  }
}

type ConnectionUse = { first: number; calls: number; answeredAt?: number }

/** The connection a call went out on: opened for it, or kept from `calls` earlier ones, quiet since the last answer. */
export type TracedConnection = { kind: "new" } | { kind: "kept"; calls: number; openMs: number; quietMs: number | undefined }

/** One call's way out, as far as it got. */
export class Trace {
  readonly #began: number
  readonly #now: () => number
  sent: { at: number; connection: TracedConnection } | undefined
  /** Whether it carries a body, which goes out after its headers. */
  body = false
  bodySentAt: number | undefined
  answeredAt: number | undefined
  /** The connection it went out on, to note its answer there. */
  socket: Socket | undefined
  /** Stops following it, however it went. */
  readonly end: () => void

  constructor(now: () => number, end: () => void) {
    this.#now = now
    this.#began = now()
    this.end = end
  }

  /**
   * How far it got, in a few words for a log: "waited 15000 ms and never went out", or "went out after 2 ms on a
   * connection kept from 4 calls (open 2100 ms, quiet 120 ms since its last answer); no answer in 15000 ms".
   */
  describe(): string {
    const ms = (at: number) => Math.round(at - this.#began)
    const now = this.#now()
    if (!this.sent) return `waited ${ms(now)} ms and never went out: no connection took it`
    const { connection } = this.sent
    const on = connection.kind === "new"
      ? "a new connection"
      : `a connection kept from ${connection.calls} ${connection.calls === 1 ? "call" : "calls"} (open ${Math.round(connection.openMs)} ms${connection.quietMs === undefined ? ", never answered" : `, quiet ${Math.round(connection.quietMs)} ms since its last answer`})`
    const went = `went out after ${ms(this.sent.at)} ms on ${on}`
    if (this.answeredAt !== undefined) return `${went}; answered after ${ms(this.answeredAt)} ms`
    const body = !this.body ? "" : this.bodySentAt === undefined ? ", its body still going out" : `, its body sent after ${ms(this.bodySentAt)} ms`
    return `${went}${body}; no answer in ${ms(now)} ms`
  }
}

/**
 * The client's own request object, as its channels name it: the key every later message about it is found by, so it's
 * checked in place, never copied. Its headers are a flat list of names and values (a value may be several).
 */
const ClientRequestFieldsSchema = z.object({ headers: z.array(z.union([z.string(), z.array(z.string())])), body: z.unknown() }).loose()
type ClientRequest = z.infer<typeof ClientRequestFieldsSchema>
const ClientRequestSchema = z.custom<ClientRequest>((value) => ClientRequestFieldsSchema.safeParse(value).success)

/** A message about a request; `sendHeaders` names the connection it went out on too. */
const RequestMessageSchema = z.object({ request: ClientRequestSchema, socket: z.instanceof(Socket).optional() })
type RequestMessage = z.infer<typeof RequestMessageSchema>

/** A channel's listener that reads only messages about requests, and passes over anything else. */
function aboutRequests(read: (message: RequestMessage) => void): ChannelListener {
  return (message) => {
    const parsed = RequestMessageSchema.safeParse(message)
    if (parsed.success) read(parsed.data)
  }
}

/** A header's value in the client's request: the first, for one sent several times. */
function headerValue(request: ClientRequest, name: string): string | undefined {
  for (let index = 0; index + 1 < request.headers.length; index += 2) {
    const [key, value] = [request.headers[index], request.headers[index + 1]]
    if (key === name || (!Array.isArray(key) && key?.toLowerCase() === name)) return Array.isArray(value) ? value[0] : value
  }
  return undefined
}
