import { z } from "zod"

/**
 * Calls to a gateway's routes over HTTP for a client that may repeat every one: `base` is where they're served,
 * `authorization` the header each call carries, asked for every call so a token that renews is always current. A
 * call that meets a dropped connection or a gateway that's busy or restarting is sent again, a few times, a little
 * later each, and never sooner than the gateway's Retry-After says (`retryAfterMs`); one that takes longer than
 * `timeoutMs`, its body included, is given up as a dropped connection. Each
 * try carries the call's correlation ID, and a call's `trace` says how many tries it took and what ended each, so a
 * call that was sent again never passes for one that was slow.
 */
export type GatewayHttpOptions = {
  id: string
  base: string
  authorization: () => string | Promise<string>
  fetch?: typeof fetch
  /** Waits before each repeat, in ms; the last failure is thrown once they're spent. */
  backoff?: readonly number[]
  timeoutMs?: number
}

/** Which call a refusal answered: its method and route (no query), how many times it was sent, and the gateway's correlation ID. */
export type GatewayCallTried = { method: string; path: string; tries: number; correlationId?: string }

/**
 * A call the gateway answered with a refusal: its status and its problem's title, which is the message, the problem's
 * detail when it gave one (why: "The chunk 9032… isn't the chunk its hash names"), and the call it answered, which
 * `described` adds so a log line leads straight to the gateway's own.
 */
export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    title: string,
    readonly call?: GatewayCallTried,
    readonly detail?: string
  ) {
    super(title)
  }

  /**
   * The title, its detail and the call: "The pack was refused: The chunk 9032… isn't the chunk its hash names (PUT
   * /chunks answered 400, correlation …)".
   */
  get described(): string {
    const said = this.detail ? `${this.message}: ${this.detail}` : this.message
    if (!this.call) return said
    const { method, path, tries, correlationId } = this.call
    return `${said} (${method} ${path} answered ${this.status}${tries > 1 ? `, ${tries} tries` : ""}${correlationId ? `, correlation ${correlationId}` : ""})`
  }
}

/** The most of a problem's detail a refusal keeps: a schema's complaint can run long, and it goes into log lines. */
const DETAIL_KEPT = 500

/** An error's words for a log or an operator: a gateway refusal with the call it answered, anything else its message. */
export function describeGatewayFailure(error: Error): string {
  return error instanceof GatewayHttpError ? error.described : error.message
}

/**
 * How one call went, filled in by the call for whoever times it: the correlation ID every try of it carried (the
 * gateway logs each try under it), how many tries it took, and what ended each try that was sent again.
 */
export type GatewayCallTrace = { correlationId?: string; tries: number; failures: string[] }

export type GatewayCall = (path: string, init?: { method?: string; json?: unknown; body?: Uint8Array<ArrayBuffer>; accept?: number[]; trace?: GatewayCallTrace }) => Promise<Response>

/** The gateway logs and traces a request under the ID this header gives. */
export const CORRELATION_HEADER = "x-mako-correlation-id"
const REPEATED = new Set([429, 500, 502, 503, 504])
export const ProblemTitle = z.object({ title: z.string() }).partial()
const ProblemCorrelation = z.object({ title: z.string(), detail: z.string(), correlationId: z.string() }).partial()

/** What ended a try that got no answer: the network's code ("ECONNRESET"), else the error's name ("TimeoutError"). */
const TryFailure = z.object({ name: z.string(), cause: z.object({ code: z.string() }).partial().optional() }).partial()

export function gatewayCalls(options: GatewayHttpOptions): GatewayCall {
  const send = options.fetch ?? fetch
  const backoff = options.backoff ?? [200, 800, 2_000]
  const timeoutMs = options.timeoutMs ?? 120_000
  return async (path, init = {}) => {
    // Every try of a call carries one correlation ID: a call sent twice shows in the gateway's log as two requests under it.
    const trace = init.trace ?? { tries: 0, failures: [] }
    const correlationId = (trace.correlationId = crypto.randomUUID())
    for (let attempt = 0; ; attempt++) {
      trace.tries = attempt + 1
      const headers = new Headers({ authorization: await options.authorization(), [CORRELATION_HEADER]: correlationId })
      if (init.json !== undefined) headers.set("content-type", "application/json")
      if (init.body) headers.set("content-type", "application/octet-stream")
      let response: Response | undefined
      let failure: unknown
      const began = performance.now()
      try {
        response = await send(`${options.base}${path}`, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        failure = error
      }
      if (response && (response.ok || init.accept?.includes(response.status))) return response
      const repeat = attempt < backoff.length && (!response || REPEATED.has(response.status))
      if (!repeat) {
        if (!response) throw failure
        const problem = ProblemCorrelation.safeParse(await response.json().catch(() => undefined)).data
        const call: GatewayCallTried = { method: init.method ?? "GET", path: path.split("?")[0] ?? path, tries: attempt + 1, correlationId: problem?.correlationId ?? response.headers.get(CORRELATION_HEADER) ?? correlationId }
        throw new GatewayHttpError(response.status, problem?.title ?? `The gateway answered ${response.status}`, call, problem?.detail?.slice(0, DETAIL_KEPT))
      }
      const failed = TryFailure.safeParse(failure).data
      trace.failures.push(`${response ? response.status : (failed?.cause?.code ?? failed?.name ?? "no answer")} after ${Math.round(performance.now() - began)} ms`)
      const wait = Math.max(backoff[attempt] ?? 0, response ? retryAfterMs(response.headers.get("retry-after")) : 0)
      await response?.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** The longest a call waits on a gateway's Retry-After before its next try: a longer one is the caller's to wait out. */
export const RETRY_AFTER_MOST_MS = 30_000

/**
 * How long a gateway's Retry-After asks a client to wait, in ms (seconds or an HTTP date; 0 for none or one that can't
 * be read), at most `RETRY_AFTER_MOST_MS`. A busy gateway says when to come back rather than being asked again at once.
 */
export function retryAfterMs(header: string | null, now = Date.now()): number {
  if (!header) return 0
  const seconds = Number(header)
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now
  return Number.isFinite(ms) ? Math.min(RETRY_AFTER_MOST_MS, Math.max(0, ms)) : 0
}
