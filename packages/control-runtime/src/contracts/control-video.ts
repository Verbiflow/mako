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

function validSize(value: number) {
  return Number.isInteger(value) && value >= 2 && value <= 4096
}
