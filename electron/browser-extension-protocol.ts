import { z } from "zod"

export const ExtensionFieldsSchema = z.record(z.string(), z.json())
const fields = ExtensionFieldsSchema
export const ExtensionCommandSchema = z.object({
  id: z.number().int().positive(),
  method: z.string().max(200),
  params: fields.default({}),
  sessionId: z.string().max(200).optional(),
})
export const ExtensionHostMessageSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("request"), client: z.string(), command: ExtensionCommandSchema }),
  z.object({ kind: z.literal("disconnect"), client: z.string() }),
])
export const ExtensionMessageSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("hello"),
    profileId: z.string().uuid(),
    label: z.string().min(1).max(80),
    family: z.literal("chromium"),
    product: z.string().min(1).max(80),
  }),
  z.object({ kind: z.literal("response"), client: z.string(), id: z.number().int(), result: fields }),
  z.object({ kind: z.literal("error"), client: z.string(), id: z.number().int(), message: z.string().max(4000) }),
  z.object({ kind: z.literal("event"), client: z.string(), sessionId: z.string().optional(), method: z.string().max(200), params: fields }),
])
export const ExtensionRegistrationSchema = z.object({
  version: z.literal(1),
  id: z.string().max(100),
  name: z.string().max(100),
  endpoint: z.string().url(),
  pid: z.number().int().positive(),
})
export type ExtensionCommand = z.infer<typeof ExtensionCommandSchema>
export type ExtensionMessage = z.infer<typeof ExtensionMessageSchema>
export type ExtensionHostMessage = z.infer<typeof ExtensionHostMessageSchema>

/** Native Messaging frames have a four-byte little-endian length prefix. */
export class NativeMessageDecoder {
  private readonly header = new Uint8Array(4)
  private headerSize = 0
  private body: Uint8Array | null = null
  private bodySize = 0
  private readonly limit: number
  constructor(limit: number) { this.limit = limit }
  push(chunk: Uint8Array): string[] {
    const frames: string[] = []
    let offset = 0
    while (offset < chunk.byteLength) {
      if (!this.body) {
        const count = Math.min(4 - this.headerSize, chunk.byteLength - offset)
        this.header.set(chunk.subarray(offset, offset + count), this.headerSize)
        this.headerSize += count
        offset += count
        if (this.headerSize < 4) continue
        const size = new DataView(this.header.buffer).getUint32(0, true)
        if (size < 1 || size > this.limit) throw new Error("Native message exceeds its size limit")
        this.body = new Uint8Array(size)
        this.bodySize = 0
      }
      const count = Math.min(this.body.byteLength - this.bodySize, chunk.byteLength - offset)
      this.body.set(chunk.subarray(offset, offset + count), this.bodySize)
      this.bodySize += count
      offset += count
      if (this.bodySize === this.body.byteLength) {
        frames.push(new TextDecoder("utf-8", { fatal: true }).decode(this.body))
        this.body = null
        this.headerSize = 0
      }
    }
    return frames
  }
}
