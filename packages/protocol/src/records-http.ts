import { z } from "zod"
import {
  RecordHoldingsPageSchema,
  RecordPulledSchema,
  RecordPushAnswerSchema,
  RecordSessionSchema,
  decodeChunkPack,
  encodeChunkPack,
  encodeRecordPush,
  type PackedChunk,
  type RecordRemote,
} from "./records.js"

/**
 * A gateway's records routes for one Thread, over HTTP: `base` is where they're served (a machine's
 * `/v1/machines/<name>/records`, a device's `/v1/threads/<thread>/records`), `authorization` the header each call
 * carries, asked for every call so a token that renews is always current. Every call is safe to repeat, so one that
 * meets a dropped connection or a gateway that's busy or restarting is sent again, a few times, a little later each.
 */
export type RecordsHttpOptions = {
  id: string
  base: string
  authorization: () => string | Promise<string>
  fetch?: typeof fetch
  /** Waits before each repeat, in ms; the last failure is thrown once they're spent. */
  backoff?: readonly number[]
  /** How long one call may take, its body included, before it's given up as a dropped connection. */
  timeoutMs?: number
}

/** A records call the gateway answered with a refusal: its status and its problem's title. */
export class RecordsHttpError extends Error {
  constructor(
    readonly status: number,
    title: string
  ) {
    super(title)
  }
}

const REPEATED = new Set([429, 500, 502, 503, 504])
const ProblemTitle = z.object({ title: z.string() }).partial()

export function recordsOverHttp(options: RecordsHttpOptions): RecordRemote {
  const send = options.fetch ?? fetch
  const backoff = options.backoff ?? [200, 800, 2_000]
  const timeoutMs = options.timeoutMs ?? 120_000
  const call = async (path: string, init: { method?: string; json?: unknown; body?: Uint8Array<ArrayBuffer>; accept?: number[] } = {}): Promise<Response> => {
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
        throw new RecordsHttpError(response.status, title ?? `The gateway answered ${response.status}`)
      }
      await response?.body?.cancel()
      await new Promise((resolve) => setTimeout(resolve, backoff[attempt]))
    }
  }
  const query = (fields: Record<string, string | number>) => new URLSearchParams(Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)])).toString()
  return {
    id: options.id,
    async missing(hashes) {
      return z.object({ missing: z.array(z.string()) }).parse(await (await call("/chunks/missing", { method: "POST", json: { hashes } })).json()).missing
    },
    async putChunks(pack) {
      return z.object({ taken: z.number() }).parse(await (await call("/chunks", { method: "PUT", body: encodeChunkPack(pack) })).json())
    },
    async readChunks(hashes) {
      const bytes = new Uint8Array(await (await call("/chunks/read", { method: "POST", json: { hashes } })).arrayBuffer())
      return decodeChunkPack(bytes).map(({ hash, codec, size, body }): PackedChunk => ({ hash, codec, size, body }))
    },
    async push(bundle) {
      const response = await call("/sessions", { method: "POST", json: bundle, accept: [409] })
      const body: unknown = await response.json()
      if (response.status === 409) {
        const conflict = z.object({ conflict: z.enum(["diverged", "gap"]), key: z.string(), seq: z.number(), head: z.number(), title: z.string() }).safeParse(body)
        if (!conflict.success) throw new RecordsHttpError(409, ProblemTitle.safeParse(body).data?.title ?? "The push was refused")
        const { title, ...refused } = conflict.data
        return { ok: false, ...refused, message: title }
      }
      return RecordPushAnswerSchema.parse(body)
    },
    async pushWith(bundle, chunks) {
      const response = await call("/sessions/with-chunks", { method: "POST", body: encodeRecordPush(bundle, chunks), accept: [409] })
      const body: unknown = await response.json()
      if (response.status === 409) {
        const missing = z.object({ missing: z.array(z.string()) }).safeParse(body)
        if (missing.success) return { missing: missing.data.missing }
        const conflict = z.object({ conflict: z.enum(["diverged", "gap"]), key: z.string(), seq: z.number(), head: z.number(), title: z.string() }).safeParse(body)
        if (!conflict.success) throw new RecordsHttpError(409, ProblemTitle.safeParse(body).data?.title ?? "The push was refused")
        const { title, ...refused } = conflict.data
        return { ok: false, ...refused, message: title }
      }
      return RecordPushAnswerSchema.parse(body)
    },
    async holdings(harness, nativeId, after) {
      return RecordHoldingsPageSchema.parse(await (await call(`/sessions/holdings?${query({ harness, nativeId, after })}`)).json())
    },
    async pull(harness, nativeId, after) {
      const response = await call(`/sessions/pull?${query({ harness, nativeId, after })}`, { accept: [404] })
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      return RecordPulledSchema.parse(await response.json())
    },
    async sessions() {
      return z.object({ sessions: z.array(RecordSessionSchema) }).parse(await (await call("/sessions")).json()).sessions
    },
  }
}
