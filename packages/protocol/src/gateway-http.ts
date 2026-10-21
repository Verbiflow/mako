import { z } from "zod"

/**
 * Calls to a gateway's routes over HTTP for a client that may repeat every one: `base` is where they're served,
 * `authorization` the header each call carries, asked for every call so a token that renews is always current. A
 * call that meets a dropped connection or a gateway that's busy or restarting is sent again, a few times, a little
 * later each; one that takes longer than `timeoutMs`, its body included, is given up as a dropped connection.
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

/** A call the gateway answered with a refusal: its status and its problem's title. */
export class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    title: string
  ) {
    super(title)
  }
}

export type GatewayCall = (path: string, init?: { method?: string; json?: unknown; body?: Uint8Array<ArrayBuffer>; accept?: number[] }) => Promise<Response>

const REPEATED = new Set([429, 500, 502, 503, 504])
export const ProblemTitle = z.object({ title: z.string() }).partial()

export function gatewayCalls(options: GatewayHttpOptions): GatewayCall {
  const send = options.fetch ?? fetch
  const backoff = options.backoff ?? [200, 800, 2_000]
  const timeoutMs = options.timeoutMs ?? 120_000
  return async (path, init = {}) => {
    for (let attempt = 0; ; attempt++) {
      const headers = new Headers({ authorization: await options.authorization() })
      if (init.json !== undefined) headers.set("content-type", "application/json")
      if (init.body) headers.set("content-type", "application/octet-stream")
      let response: Response | undefined
      let failure: unknown
      try {
        response = await send(`${options.base}${path}`, { method: init.method ?? "GET", headers, body: init.json !== undefined ? JSON.stringify(init.json) : init.body, signal: AbortSignal.timeout(timeoutMs) })
      } catch (error) {
        failure = error
      }
      if (response && (response.ok || init.accept?.includes(response.status))) return response
      const repeat = attempt < backoff.length && (!response || REPEATED.has(response.status))
      if (!repeat) {
        if (!response) throw failure
        const title = ProblemTitle.safeParse(await response.json().catch(() => undefined)).data?.title
        throw new GatewayHttpError(response.status, title ?? `The gateway answered ${response.status}`)
      }
      await response?.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, backoff[attempt]))
    }
  }
}
