import { z } from "zod"
import { ControlPreviewSchema, type ControlPreview } from "./control-preview.js"

export const PREVIEW_MEDIA_TYPE = "application/vnd.mako.preview.v1"
export const PREVIEW_METADATA_LIMIT = 16 * 1024
export const PREVIEW_IMAGE_LIMIT = 2 * 1024 * 1024
export const PREVIEW_PACKET_LIMIT = 12 + PREVIEW_METADATA_LIMIT + PREVIEW_IMAGE_LIMIT
const MAGIC = 0x4d4b5031 // MKP1; network byte order.
const metadataSchema = ControlPreviewSchema.omit({ frame: true }).extend({
  frame: ControlPreviewSchema.shape.frame.unwrap().omit({ image: true }).extend({
    mimeType: z.enum(["image/png", "image/jpeg"]),
  }).nullable(),
}).nullable()

/** A small JSON header followed by exact encoded pixels. No image recompression,
 * base64 expansion, Node-only types or general-purpose serialization protocol. */
export function encodePreviewMedia(input: ControlPreview | null) {
  const preview = ControlPreviewSchema.nullable().parse(input)
  const frame = preview?.frame
  const bytes = frame?.image.bytes ?? new Uint8Array()
  const metadata = new TextEncoder().encode(JSON.stringify(preview && {
    activity: preview.activity, window: preview.window,
    frame: frame ? { id: frame.id, capturedAt: frame.capturedAt,
      publishedAt: frame.publishedAt, mimeType: frame.image.mimeType } : null,
  }))
  if (metadata.byteLength > PREVIEW_METADATA_LIMIT) throw new Error("Preview metadata exceeds its byte limit")
  const header = new Uint8Array(12 + metadata.byteLength)
  const view = new DataView(header.buffer)
  view.setUint32(0, MAGIC)
  view.setUint32(4, metadata.byteLength)
  view.setUint32(8, bytes.byteLength)
  header.set(metadata, 12)
  return { header, bytes }
}

export function decodePreviewMedia(packet: Uint8Array<ArrayBuffer>): ControlPreview | null {
  if (packet.byteLength < 12 || packet.byteLength > PREVIEW_PACKET_LIMIT)
    throw new Error("Invalid preview packet size")
  const header = new DataView(packet.buffer, packet.byteOffset, 12)
  const metadataLength = header.getUint32(4), imageLength = header.getUint32(8)
  if (header.getUint32(0) !== MAGIC || metadataLength > PREVIEW_METADATA_LIMIT ||
      imageLength > PREVIEW_IMAGE_LIMIT || packet.byteLength !== 12 + metadataLength + imageLength)
    throw new Error("Invalid preview packet framing")
  const metadata = metadataSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(packet.subarray(12, 12 + metadataLength))))
  if (!metadata?.frame) {
    if (imageLength !== 0) throw new Error("Unexpected preview image bytes")
    return metadata ? { ...metadata, frame: null } : null
  }
  if (!imageLength) throw new Error("Missing preview image bytes")
  const { mimeType, ...frame } = metadata.frame
  return { ...metadata, frame: { ...frame, image: { mimeType, bytes: packet.subarray(12 + metadataLength) } } }
}

/** Both fetch and Node adapters enforce the limit while reading, before joining. */
export async function collectPreviewMedia(chunks: AsyncIterable<Uint8Array>) {
  const parts: Uint8Array[] = []
  let length = 0
  for await (const part of chunks) {
    length += part.byteLength
    if (length > PREVIEW_PACKET_LIMIT) throw new Error("Preview response exceeds its byte limit")
    parts.push(part)
  }
  const packet = new Uint8Array(length)
  let offset = 0
  for (const part of parts) { packet.set(part, offset); offset += part.byteLength }
  return { preview: decodePreviewMedia(packet), bytes: length }
}
