#!/usr/bin/env node
// Speaks mako-video's protocol for scripts/test-video-helper-protocol.ts: logs each command it reads to
// $FAKE_VIDEO_LOG, answers a 'K' or an 'F' with a key unit, and for window 0 ends at once the way the real helper
// does when it can't capture.
import { appendFileSync } from "node:fs"
import { encodeControlVideo } from "../../packages/control-runtime/dist/contracts/control-video.js"

const [source, ...rest] = process.argv.slice(2)
appendFileSync(process.env.FAKE_VIDEO_LOG, `${JSON.stringify({ args: [source, ...rest] })}\n`)
if (source === "window" && rest[0] === "0") {
  process.stderr.write("ended: That window is gone\n{\"frames\":0}\n")
  process.exit(0)
}
let sequence = 0
const unit = (key, width = 64, height = 32, tag = ++sequence, capturedAt = Date.now()) => {
  const packet = encodeControlVideo(key
    ? { kind: "key", width, height, sequence: tag, capturedAt, data: Uint8Array.of(0, 0, 0, 1, 0x65), description: Uint8Array.of(1, 0x42, 0, 0x1e, 0xff, 0xe1) }
    : { kind: "delta", width, height, sequence: tag, capturedAt, data: Uint8Array.of(0, 0, 0, 1, 0x41) })
  const length = Buffer.alloc(4)
  length.writeUInt32BE(packet.byteLength)
  process.stdout.write(Buffer.concat([length, packet]))
}
if (source !== "frames") unit(true)
let buffer = Buffer.alloc(0)
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  while (buffer.length >= 5 && buffer.length >= 5 + buffer.readUInt32BE(1)) {
    const type = String.fromCharCode(buffer[0]), body = buffer.subarray(5, 5 + buffer.readUInt32BE(1))
    buffer = buffer.subarray(5 + body.length)
    const entry = { type, length: body.length }
    if (type === "B") Object.assign(entry, { width: body.readUInt16BE(0), height: body.readUInt16BE(2) })
    if (type === "R") entry.bitrate = body.readUInt32BE(0)
    if (type === "F") Object.assign(entry, { format: body[0], sequence: body.readUInt32BE(1), capturedAt: body.readDoubleBE(5) })
    appendFileSync(process.env.FAKE_VIDEO_LOG, `${JSON.stringify(entry)}\n`)
    if (type === "K") unit(true)
    if (type === "F") unit(true, 64, 32, entry.sequence, entry.capturedAt)
  }
})
process.stdin.on("end", () => {
  process.stderr.write("{\"frames\":1}\n")
  process.exit(0)
})
