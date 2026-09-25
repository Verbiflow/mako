import { parentPort, workerData } from "node:worker_threads"
import { z } from "zod"
import { RecordingEncoderProcess } from "./recording-encoder-process.js"
import {
  RecordingRenderSchema,
  renderRecordingImage,
} from "./recording-render.js"

const port = parentPort
if (!port) throw new Error("Video encoder must run in its owned worker")
const settings = z.object({ directory: z.string() }).parse(workerData)
const command = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("initialize"),
    id: z.number().int(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().int().min(1).max(60),
  }),
  z.object({
    kind: z.literal("frame"),
    id: z.number().int(),
    image: RecordingRenderSchema.extend({
      bytes: z.instanceof(ArrayBuffer),
    }).optional(),
  }),
  z.object({ kind: z.literal("finish"), id: z.number().int() }),
  z.object({ kind: z.literal("abort"), reason: z.string() }),
])
let encoder: RecordingEncoderProcess | undefined
let frameBytes = 0
let width = 0,
  height = 0
let pixels: Buffer | undefined
let busy = false
port.on("message", (input) => {
  const parsed = command.safeParse(input)
  if (!parsed.success) {
    encoder?.abort("Invalid video worker command")
    return
  }
  const value = parsed.data
  if (value.kind === "abort") {
    encoder?.abort(value.reason)
    return
  }
  if (busy) {
    encoder?.abort("Concurrent video worker commands")
    return
  }
  busy = true
  void (async () => {
    if (value.kind === "initialize") {
      if (encoder) throw new Error("Video encoder is already initialized")
      encoder = new RecordingEncoderProcess(
        settings.directory,
        value.width,
        value.height,
        value.fps,
        (reason) => port.postMessage({ kind: "failed", reason })
      )
      frameBytes = value.width * value.height * 4
      width = value.width
      height = value.height
      port.postMessage({ kind: "initialized", id: value.id })
      return
    }
    if (!encoder)
      throw new Error("No video frames were received; no video was produced")
    if (value.kind === "finish") {
      const result = await encoder.finish()
      port.postMessage({ kind: "finished", id: value.id, result })
      port.close()
    } else {
      const renderStart = performance.now()
      if (value.image) {
        const { bytes, frame, at, pointer, press } = value.image
        pixels = await renderRecordingImage(
          Buffer.from(bytes),
          frame,
          at,
          pointer,
          press,
          width,
          height
        )
      }
      if (!pixels || pixels.length !== frameBytes)
        throw new Error("Video worker received invalid frame dimensions")
      const pipeStart = performance.now()
      await encoder.write(pixels)
      port.postMessage({ kind: "written", id: value.id,
        renderMs: pipeStart - renderStart, pipeMs: performance.now() - pipeStart })
    }
  })()
    .catch(async (error) => {
      const reason =
        error instanceof Error ? error.message : "Video encoder failed"
      encoder?.abort(reason)
      port.postMessage({ kind: "failed", id: value.id, reason })
      if (value.kind === "finish") {
        await encoder?.finish().catch(() => {})
        port.close()
      }
    })
    .finally(() => {
      busy = false
    })
})
port.once("close", () => {
  encoder?.abort("Video worker owner closed")
})
port.postMessage({ kind: "ready" })
