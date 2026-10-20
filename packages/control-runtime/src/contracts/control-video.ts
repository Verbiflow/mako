interface ControlVideoCommon {
  width: number
  height: number
  /** The source frame's sequence in its capture; gaps are frames this viewer was not sent. */
  sequence: number
  /** When the browser composited the frame, in milliseconds since 1970 on the capturing machine. */
  capturedAt: number
  data: Uint8Array
}

/** One unit of a live preview, as it crosses to a remote viewer. Video is
 * H.264 as length-prefixed NAL units, what WebCodecs expects. A key unit
 * carries its decoder configuration (an `avcC` record), so a viewer that
 * joins, falls behind or sees the size change needs nothing else to start
 * decoding. A poster is the screencast's own JPEG, sent to a viewer while its
 * first key unit is being encoded, so it paints at once. */
export type ControlVideoPacket =
  | (ControlVideoCommon & { kind: "key"; description: Uint8Array })
  | (ControlVideoCommon & { kind: "delta" })
  | (ControlVideoCommon & { kind: "poster" })

const VERSION = 1
const KINDS = ["delta", "key", "poster"] as const
const HEADER = 24
export const CONTROL_VIDEO_DESCRIPTION_LIMIT = 4096
export const CONTROL_VIDEO_DATA_LIMIT = 4 * 1024 * 1024

export function encodeControlVideo(packet: ControlVideoPacket): Uint8Array<ArrayBuffer> {
  const description = packet.kind === "key" ? packet.description : new Uint8Array()
  if ((packet.kind === "key" && !description.byteLength) || description.byteLength > CONTROL_VIDEO_DESCRIPTION_LIMIT ||
    packet.data.byteLength > CONTROL_VIDEO_DATA_LIMIT || !packet.data.byteLength ||
    !validSize(packet.width) || !validSize(packet.height) ||
    !Number.isInteger(packet.sequence) || packet.sequence < 0 || packet.sequence > 0xffffffff ||
    !Number.isFinite(packet.capturedAt))
    throw new Error("Invalid live video packet")
  const bytes = new Uint8Array(HEADER + description.byteLength + packet.data.byteLength)
  const view = new DataView(bytes.buffer)
  view.setUint8(0, VERSION)
  view.setUint8(1, KINDS.indexOf(packet.kind))
  view.setUint16(2, packet.width)
  view.setUint16(4, packet.height)
  view.setUint16(6, description.byteLength)
  view.setUint32(8, packet.sequence)
  view.setFloat64(12, packet.capturedAt)
  view.setUint32(20, packet.data.byteLength)
  bytes.set(description, HEADER)
  bytes.set(packet.data, HEADER + description.byteLength)
  return bytes
}

/** The packet's parts are views into `bytes`, not copies. */
export function decodeControlVideo(bytes: Uint8Array): ControlVideoPacket {
  if (bytes.byteLength < HEADER) throw new Error("Truncated live video packet")
  const view = new DataView(bytes.buffer, bytes.byteOffset, HEADER)
  const kind = KINDS[view.getUint8(1)]
  const descriptionLength = view.getUint16(6)
  const dataLength = view.getUint32(20)
  const common: ControlVideoCommon = {
    width: view.getUint16(2),
    height: view.getUint16(4),
    sequence: view.getUint32(8),
    capturedAt: view.getFloat64(12),
    data: bytes.subarray(HEADER + descriptionLength),
  }
  if (view.getUint8(0) !== VERSION || !kind ||
    bytes.byteLength !== HEADER + descriptionLength + dataLength || !dataLength ||
    descriptionLength > CONTROL_VIDEO_DESCRIPTION_LIMIT || dataLength > CONTROL_VIDEO_DATA_LIMIT ||
    (kind === "key") !== descriptionLength > 0 || !validSize(common.width) || !validSize(common.height) ||
    !Number.isFinite(common.capturedAt))
    throw new Error("Invalid live video packet")
  return kind === "key"
    ? { ...common, kind, description: bytes.subarray(HEADER, HEADER + descriptionLength) }
    : { ...common, kind }
}

/** The WebCodecs codec string an `avcC` record names: profile, constraint flags and level. */
export function controlVideoCodec(description: Uint8Array): string {
  if (description.byteLength < 4 || description[0] !== 1)
    throw new Error("Not an AVC decoder configuration record")
  return `avc1.${[...description.subarray(1, 4)].map(byte => byte.toString(16).padStart(2, "0")).join("")}`
}

export const CONTROL_VIDEO_BATCH_TYPE = "application/vnd.mako.video-batch.v1"
const BATCH_MAGIC = 0x4d4b5631 // MKV1; network byte order.
const BATCH_HEADER = 9
export const CONTROL_VIDEO_BATCH_LIMIT = 16 * 1024 * 1024

/** The packets a window's viewer was sent since it last read, and whether more
 * come: once `live` is false, nothing comes until the agent acts again. */
export interface ControlVideoBatch {
  live: boolean
  packets: Uint8Array[]
}

export function encodeControlVideoBatch(batch: ControlVideoBatch): Uint8Array<ArrayBuffer> {
  const length = batch.packets.reduce((total, packet) => total + 4 + packet.byteLength, BATCH_HEADER)
  if (length > CONTROL_VIDEO_BATCH_LIMIT) throw new Error("Live video batch exceeds its byte limit")
  const bytes = new Uint8Array(length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, BATCH_MAGIC)
  view.setUint8(4, batch.live ? 1 : 0)
  view.setUint32(5, batch.packets.length)
  let offset = BATCH_HEADER
  for (const packet of batch.packets) {
    view.setUint32(offset, packet.byteLength)
    bytes.set(packet, offset + 4)
    offset += 4 + packet.byteLength
  }
  return bytes
}

/** Each packet is a view into `bytes`, not a copy, and is decoded only by its reader. */
export function decodeControlVideoBatch(bytes: Uint8Array): ControlVideoBatch {
  if (bytes.byteLength < BATCH_HEADER || bytes.byteLength > CONTROL_VIDEO_BATCH_LIMIT)
    throw new Error("Invalid live video batch size")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const flags = view.getUint8(4)
  if (view.getUint32(0) !== BATCH_MAGIC || flags > 1) throw new Error("Invalid live video batch framing")
  const count = view.getUint32(5)
  const packets: Uint8Array[] = []
  let offset = BATCH_HEADER
  for (let index = 0; index < count; index++) {
    if (offset + 4 > bytes.byteLength) throw new Error("Truncated live video batch")
    const length = view.getUint32(offset)
    if (offset + 4 + length > bytes.byteLength) throw new Error("Truncated live video batch")
    packets.push(bytes.subarray(offset + 4, offset + 4 + length))
    offset += 4 + length
  }
  if (offset !== bytes.byteLength) throw new Error("Invalid live video batch framing")
  return { live: flags === 1, packets }
}

function validSize(value: number) {
  return Number.isInteger(value) && value >= 2 && value <= 4096
}
