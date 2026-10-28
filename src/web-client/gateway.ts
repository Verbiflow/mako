import type { JsonValue } from "@mako/host/contracts/json"
import { z } from "zod"
import { clientSessionOverSockets, problemType, subprotocols, type ClientEndpoint, type ClientSessionOverSockets, type ConnectionCredential, type MessageSocket } from "@mako/protocol"

/** Who this browser is signed in as, as the gateway says it with each connection token. */
export interface WebAccount {
  id: string
  name: string
  email: string
  image: string | null
  entitlements: string[]
}

/**
 * A connection token for this browser, traded for its sign-in: good for a few minutes, renewed in each socket before
 * it runs out. The browser's device is its sign-in's own (`deviceId`), so signing out anywhere removes it.
 */
export interface WebConnection {
  token: string
  /** When it runs out, in ms since the epoch. */
  expiresAt: number
  deviceId: string
  account: WebAccount
}

/** The browser's sign-in ended: signed out here or on another device, or it ran out. Sign in again. */
export class SignedOutError extends Error {
  constructor(message = "This browser isn't signed in to Mako.") {
    super(message)
    this.name = "SignedOutError"
  }
}

/**
 * A gateway's refusal, as its problem document says it, with the correlation ID its logs carry. `problem`: the document
 * itself, for a refusal that carries more than words (a return's 409 carries the return's record).
 */
export class GatewayError extends Error {
  readonly status: number
  readonly correlationId: string | undefined
  readonly problem: JsonValue | undefined

  constructor(status: number, message: string, correlationId: string | undefined, problem?: JsonValue) {
    super(message)
    this.name = "GatewayError"
    this.status = status
    this.correlationId = correlationId
    this.problem = problem
  }
}

/** The browser's lines about its calls and what they carry out: the console, where a person debugging the web looks first. */
export const CONSOLE_LOG = {
  warn: (message: string, fields: LogFields) => console.warn(`[mako] ${message}`, fields),
  info: (message: string, fields: LogFields) => console.info(`[mako] ${message}`, fields),
}
type LogFields = Record<string, string | number | boolean | undefined>

export const CORRELATION_HEADER = "x-mako-correlation-id"
/** Where this browser keeps the plans of archives it runs (`archive.ts`), by account: read at start to settle one left. */
export const ARCHIVE_PLANS = "mako:web:archive:"
/** A token is renewed this long before it runs out, as the host renews its own, or halfway through a shorter one's life. */
const RENEW_BEFORE_MS = 60_000
/** Every connection pings this often; one silent for two pings and ten seconds is ended and opened again. */
const HEARTBEAT_MS = 20_000

/**
 * One browser's reach into its account through the gateway at its own origin: a token supply shared by every socket
 * and request, a client session over WebSockets (one per Thread, runtime or the account), and the account's REST API.
 */
export class Gateway {
  readonly origin: string
  readonly session: ClientSessionOverSockets
  readonly #connect: () => Promise<WebConnection>
  #current: { connection: WebConnection; renewAt: number } | undefined
  #asking: Promise<WebConnection> | undefined
  readonly #signedOut = new Set<() => void>()

  constructor(options: { origin: string; connect: () => Promise<WebConnection> }) {
    this.origin = options.origin
    this.#connect = options.connect
    const credential: ConnectionCredential = {
      token: async () => (await this.connection()).token,
      renewInMs: () => (this.#current ? this.#current.renewAt - Date.now() : 0),
    }
    this.session = clientSessionOverSockets((endpoint) => this.#open(endpoint), {
      heartbeatMs: HEARTBEAT_MS,
      credential,
      onClosing: (_endpoint, problem) => {
        // Removed or signed out: every socket of this browser is refused from now, so the app shows sign-in.
        if (problemType(problem) === "forbidden") this.#endSignIn()
        else this.#current = undefined
      },
    })
  }

  /** A token good for a minute at least: the one held, or a new one, one ask at a time. */
  async connection(): Promise<WebConnection> {
    const held = this.#current
    if (held && held.renewAt > Date.now()) return held.connection
    this.#asking ??= this.#connect()
      .then((connection) => {
        const now = Date.now()
        this.#current = { connection, renewAt: Math.max(connection.expiresAt - RENEW_BEFORE_MS, now + (connection.expiresAt - now) / 2) }
        return connection
      })
      .catch((error) => {
        if (error instanceof SignedOutError) this.#endSignIn()
        throw error
      })
      .finally(() => {
        this.#asking = undefined
      })
    return this.#asking
  }

  /** Told once this browser's sign-in ends, whichever request found it. */
  onSignedOut(listener: () => void): () => void {
    this.#signedOut.add(listener)
    return () => this.#signedOut.delete(listener)
  }

  /**
   * One request to the account's API, as this browser's device: JSON in and out, a refusal thrown as the gateway's own
   * sentence with its correlation ID. A token refused as run out is renewed and the request asked once more. The answer
   * is JSON not yet read as anything: each caller parses it with the schema of the route it asked.
   */
  async rest<Body>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: Body, attempt = 1): Promise<JsonValue | undefined> {
    const { token } = await this.connection()
    const correlationId = crypto.randomUUID()
    const headers = new Headers({ authorization: `Bearer ${token}`, [CORRELATION_HEADER]: correlationId })
    const init: RequestInit = { method, headers }
    if (body !== undefined) {
      headers.set("content-type", "application/json")
      init.body = JSON.stringify(body)
    }
    const response = await fetch(new URL(path, this.origin), init)
    if (response.status === 401 && attempt === 1) {
      this.#current = undefined
      return this.rest(method, path, body, 2)
    }
    if (!response.ok) throw await refusal(response, correlationId)
    if (response.status === 204) return undefined
    const answer: JsonValue = await response.json()
    return answer
  }

  /** After a sleep or a network change: sockets that went quiet end now rather than whenever TCP notices. */
  wake(): void {
    this.session.wake()
  }

  close(): void {
    this.session.close()
  }

  async #open(endpoint: ClientEndpoint): Promise<MessageSocket> {
    const { token } = await this.connection()
    const path =
      endpoint.kind === "thread"
        ? `/v1/threads/${encodeURIComponent(endpoint.threadId)}/connect`
        : endpoint.kind === "runtime"
          ? `/v1/runtimes/${encodeURIComponent(endpoint.runtimeId)}/clients`
          : `/v1/accounts/${encodeURIComponent(endpoint.accountId)}/connect`
    const socket = new WebSocket(new URL(path, this.origin.replace(/^http/, "ws")), subprotocols(token))
    socket.binaryType = "arraybuffer"
    return socket
  }

  #endSignIn(): void {
    this.#current = undefined
    for (const listener of this.#signedOut) listener()
  }
}

/** What a problem document says in words; anything else in it is the refusal's own (`GatewayError.problem`). */
const ProblemWordsSchema = z.object({ title: z.string().optional(), detail: z.string().optional() })

/** A gateway's problem document as an error a person can read, keeping its correlation ID. */
async function refusal(response: Response, sent: string): Promise<GatewayError> {
  const correlationId = response.headers.get(CORRELATION_HEADER) ?? sent
  const body: JsonValue | undefined = await response.json().catch(() => undefined)
  const problem = ProblemWordsSchema.safeParse(body).data
  const title = problem?.title ?? `The gateway answered ${response.status}`
  const detail = problem?.detail ? `: ${problem.detail}` : ""
  return new GatewayError(response.status, `${title}${detail}`, correlationId, body)
}
