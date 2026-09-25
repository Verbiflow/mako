import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { RecordingRender } from "./recording-render.js"

const resultSchema = z.object({
  path: z.string(),
  durationMs: z.number().positive(),
  retainedFrames: z.number().int().positive().optional(),
  error: z.string().optional(),
})
const replySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ready") }),
  z.object({ kind: z.literal("initialized"), id: z.number().int() }),
  z.object({
    kind: z.literal("written"),
    id: z.number().int(),
    renderMs: z.number().nonnegative(),
    pipeMs: z.number().nonnegative(),
  }),
  z.object({
    kind: z.literal("failed"),
    reason: z.string(),
    id: z.number().int().optional(),
  }),
  z.object({
    kind: z.literal("finished"),
    id: z.number().int(),
    result: resultSchema,
  }),
])
type Reply = z.infer<typeof replySchema>

/** Keep pipe callbacks away from browser/preview RPC. Transfer one frame at a
 * time; repeated output reuses pixels already held by the worker. */
export class RecordingEncoder {
  private readonly worker: Worker
  private startupResolve!: () => void
  private startupReject!: (error: Error) => void
  readonly ready = new Promise<void>((resolve, reject) => {
    this.startupResolve = resolve
    this.startupReject = reject
  })
  private pending?: {
    id: number
    resolve: (reply: Reply) => void
    reject: (error: Error) => void
  }
  private nextId = 0
  private failure?: string
  private finishing?: Promise<z.infer<typeof resultSchema>>
  private ended = false
  private terminating = false

  constructor(directory: string, failed: (reason: string) => void) {
    // Source tests must not silently pick up a stale compiled worker from a
    // previous build. Shipped JS requires its matching packaged JS sidecar.
    const worker = new URL(
      import.meta.url.endsWith(".ts")
        ? "./recording-encoder-worker.ts"
        : "./recording-encoder-worker.js",
      import.meta.url
    )
    this.worker = new Worker(worker, {
      workerData: { directory },
      // A public SDK may be called from `node --input-type=module`/stdin.
      // That flag cannot be inherited by a file-backed worker. Compiled workers
      // need no caller flags; source tests retain their TypeScript loader.
      execArgv: import.meta.url.endsWith(".ts")
        ? process.execArgv.filter(
            (arg, index, args) =>
              arg !== "--input-type" &&
              !arg.startsWith("--input-type=") &&
              args[index - 1] !== "--input-type"
          )
        : [],
      resourceLimits: { maxOldGenerationSizeMb: 64 },
    })
    const startupTimeout = setTimeout(() => {
      this.startupReject(new Error("Video worker startup timed out"))
      this.terminating = true
      void this.worker.terminate()
    }, 5000)
    void this.ready.then(
      () => clearTimeout(startupTimeout),
      () => clearTimeout(startupTimeout)
    )
    const notify = (reason: string) => {
      if (this.failure) return
      this.failure = reason
      failed(reason)
    }
    const fail = (reason: string) => {
      this.startupReject(new Error(reason))
      this.pending?.reject(new Error(reason))
      this.pending = undefined
      notify(reason)
    }
    this.worker.on("message", (input) => {
      const reply = replySchema.safeParse(input)
      if (!reply.success) {
        fail("Video worker returned an invalid response")
        return
      }
      if (reply.data.kind === "ready") {
        this.startupResolve()
        return
      }
      if (reply.data.kind === "failed") {
        if (reply.data.id !== undefined && reply.data.id === this.pending?.id) {
          this.pending.reject(new Error(reply.data.reason))
          this.pending = undefined
        }
        notify(reply.data.reason)
        return
      }
      if (reply.data.id !== this.pending?.id) return
      this.pending?.resolve(reply.data)
      this.pending = undefined
    })
    this.worker.on("error", (error) =>
      fail(`Video worker failed: ${error.message}`)
    )
    this.worker.once("exit", (code) => {
      this.ended = true
      if ((!this.terminating && code !== 0) || this.pending)
        fail(`Video worker exited: ${code}`)
    })
  }
  private request(
    message:
      | { kind: "frame"; image?: RecordingRender & { bytes: ArrayBuffer } }
      | { kind: "finish" }
      | { kind: "initialize"; width: number; height: number; fps: number }
  ) {
    if (this.pending)
      return Promise.reject(
        new Error("Video worker already has an outstanding request")
      )
    if (this.ended)
      return Promise.reject(new Error(this.failure ?? "Video worker ended"))
    return new Promise<Reply>((resolve, reject) => {
      const id = ++this.nextId
      const timeout = setTimeout(
        () => {
          this.abort("Video worker response timed out")
          this.pending = undefined
          reject(new Error("Video worker response timed out"))
        },
        message.kind === "finish" ? 35_000 : 10_000
      )
      this.pending = {
        id,
        resolve: (reply) => {
          clearTimeout(timeout)
          resolve(reply)
        },
        reject: (error) => {
          clearTimeout(timeout)
          reject(error)
        },
      }
      try {
        this.worker.postMessage(
          { ...message, id },
          message.kind === "frame" && message.image ? [message.image.bytes] : []
        )
      } catch (error) {
        clearTimeout(timeout)
        this.pending = undefined
        reject(error)
      }
    })
  }
  async initialize(width: number, height: number, fps: number) {
    await this.ready
    const reply = await this.request({ kind: "initialize", width, height, fps })
    if (reply.kind !== "initialized")
      throw new Error("Video worker did not initialize its encoder")
  }
  async write(frame?: RecordingRender & { bytes: Buffer }) {
    if (this.failure) throw new Error(this.failure)
    // Transfer compressed source pixels, never full RGBA frames through the host.
    // Make an owned copy: the recorder still retains the source for CFR repeats.
    const image =
      frame === undefined
        ? undefined
        : { ...frame, bytes: Uint8Array.from(frame.bytes).buffer }
    const reply = await this.request({ kind: "frame", image })
    if (reply.kind !== "written")
      throw new Error("Video worker did not acknowledge its frame")
    return { renderMs: reply.renderMs, pipeMs: reply.pipeMs }
  }
  abort(reason: string) {
    this.failure ??= reason
    if (!this.ended) this.worker.postMessage({ kind: "abort", reason })
  }
  finish() {
    return (this.finishing ??= (async () => {
      const reply = await this.request({ kind: "finish" })
      if (reply.kind !== "finished")
        throw new Error("Video worker did not finalize recording")
      return reply.result
    })().finally(async () => {
      this.terminating = true
      await this.worker.terminate()
    }))
  }
}
