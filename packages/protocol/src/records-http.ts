import { z } from "zod"
import { GatewayHttpError, ProblemTitle, gatewayCalls, type GatewayHttpOptions } from "./gateway-http.js"
import {
  RecordHeadAnswerSchema,
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

/** A gateway's records routes for one Thread (a machine's `/v1/machines/<name>/records`, a device's `/v1/threads/<thread>/records`). */
export type RecordsHttpOptions = GatewayHttpOptions

export function recordsOverHttp(options: RecordsHttpOptions): RecordRemote {
  const call = gatewayCalls(options)
  const query = (fields: Record<string, string | number>) => new URLSearchParams(Object.entries(fields).map(([key, value]): [string, string] => [key, String(value)])).toString()
  return {
    id: options.id,
    async missing(hashes, trace) {
      return z.object({ missing: z.array(z.string()) }).parse(await (await call("/chunks/missing", { method: "POST", json: { hashes }, ...trace && { trace } })).json()).missing
    },
    async putChunks(pack, trace) {
      return z.object({ taken: z.number() }).parse(await (await call("/chunks", { method: "PUT", body: encodeChunkPack(pack), ...trace && { trace } })).json())
    },
    async readChunks(hashes, trace) {
      const bytes = new Uint8Array(await (await call("/chunks/read", { method: "POST", json: { hashes }, ...trace && { trace } })).arrayBuffer())
      return decodeChunkPack(bytes).map(({ hash, codec, size, body }): PackedChunk => ({ hash, codec, size, body }))
    },
    async push(bundle, trace) {
      const response = await call("/sessions", { method: "POST", json: bundle, accept: [409], ...trace && { trace } })
      const body: unknown = await response.json()
      if (response.status === 409) {
        const conflict = z.object({ conflict: z.enum(["diverged", "gap"]), key: z.string(), seq: z.number(), head: z.number(), title: z.string() }).safeParse(body)
        if (!conflict.success) throw new GatewayHttpError(409, ProblemTitle.safeParse(body).data?.title ?? "The push was refused")
        const { title, ...refused } = conflict.data
        return { ok: false, ...refused, message: title }
      }
      return RecordPushAnswerSchema.parse(body)
    },
    async pushWith(bundle, chunks, trace) {
      const response = await call("/sessions/with-chunks", { method: "POST", body: encodeRecordPush(bundle, chunks), accept: [409], ...trace && { trace } })
      const body: unknown = await response.json()
      if (response.status === 409) {
        const missing = z.object({ missing: z.array(z.string()) }).safeParse(body)
        if (missing.success) return { missing: missing.data.missing }
        const conflict = z.object({ conflict: z.enum(["diverged", "gap"]), key: z.string(), seq: z.number(), head: z.number(), title: z.string() }).safeParse(body)
        if (!conflict.success) throw new GatewayHttpError(409, ProblemTitle.safeParse(body).data?.title ?? "The push was refused")
        const { title, ...refused } = conflict.data
        return { ok: false, ...refused, message: title }
      }
      return RecordPushAnswerSchema.parse(body)
    },
    async holdings(harness, nativeId, after, trace) {
      return RecordHoldingsPageSchema.parse(await (await call(`/sessions/holdings?${query({ harness, nativeId, after })}`, { ...trace && { trace } })).json())
    },
    async pull(harness, nativeId, after, trace) {
      const response = await call(`/sessions/pull?${query({ harness, nativeId, after })}`, { accept: [404], ...trace && { trace } })
      if (response.status === 404) {
        await response.body?.cancel()
        return null
      }
      return RecordPulledSchema.parse(await response.json())
    },
    async head(harness, nativeId, trace) {
      const response = await call(`/sessions/head?${query({ harness, nativeId })}`, { accept: [404, 413], ...trace && { trace } })
      // The route itself not found (a gateway from before it), or a session too large to answer at once: read by pulling.
      if (response.status === 404 || response.status === 413) {
        await response.body?.cancel()
        return undefined
      }
      return RecordHeadAnswerSchema.parse(await response.json()).head
    },
    async sessions() {
      return z.object({ sessions: z.array(RecordSessionSchema) }).parse(await (await call("/sessions")).json()).sessions
    },
  }
}
