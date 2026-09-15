import { existsSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"
import {
  INLINE_IMAGE_COUNT,
  INLINE_TEXT_BUDGET,
  INLINE_TOTAL_BUDGET,
  spillImage,
  spillJson,
} from "./artifacts.js"

const messageSchema = z.discriminatedUnion("kind", [
  z.object({
    runId: z.number(),
    kind: z.literal("call"),
    id: z.number(),
    namespace: z.string(),
    command: z.record(z.string(), z.json()),
  }),
  z.object({ runId: z.number(), kind: z.literal("output"), value: z.json() }),
  z.object({ runId: z.number(), kind: z.literal("image"), value: z.json() }),
  z.object({ runId: z.number(), kind: z.literal("done"), value: z.json() }),
  z.object({
    runId: z.number(),
    kind: z.literal("error"),
    message: z.string(),
  }),
])

export const PROGRAM_TIME_LIMIT_MS = 60_000

export type ControlProgramOutput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export interface ControlProgramFault {
  code: "cancelled" | "timed-out"
  message: string
  outcome: "unknown"
}

export interface ControlProgramOptions {
  /** The object programs are written against and whose helpers they get. */
  namespace: string
  actions: readonly string[]
  /**
   * Further objects a program may call, by name: the computer server
   * lends programs the `browser` object for an application's page route.
   */
  extra?: Readonly<Record<string, readonly string[]>>
  /** Where results past the inline budget are written whole. */
  artifacts: string
  call(
    command: JsonObject,
    signal: AbortSignal,
    namespace: string
  ): Promise<JsonValue>
  image(value: JsonValue): ControlProgramOutput[]
  fault(detail: ControlProgramFault): Error
}

/**
 * Runs trusted local control programs away from the host's event loop.
 *
 * Authority stays in the adapter: every requested action crosses back into
 * the host, where the browser or computer owner validates identity, policy,
 * arguments, and cancellation before dispatch. Output is never cut: a value
 * past the inline budget is written to an artifact file and the result
 * carries its receipt (`control-artifacts.ts`).
 */
export class ControlProgramRuntime {
  private sequence = 0
  private worker?: Worker
  private tail: Promise<void> = Promise.resolve()
  private readonly stopping = new AbortController()
  private readonly options: ControlProgramOptions

  constructor(options: ControlProgramOptions) {
    this.options = options
  }

  run(source: string, signal: AbortSignal): Promise<ControlProgramOutput[]> {
    const active = AbortSignal.any([signal, this.stopping.signal])
    const result = this.tail.then(() => {
      active.throwIfAborted()
      return this.execute(source, active)
    })
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private execute(
    source: string,
    signal: AbortSignal
  ): Promise<ControlProgramOutput[]> {
    const compiled = new URL("./worker.js", import.meta.url)
    this.worker ??= new Worker(
      existsSync(compiled) ? compiled : new URL("./worker.ts", import.meta.url),
      { env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } }
    )
    const worker = this.worker
    const runId = ++this.sequence
    const controller = new AbortController()
    const active = AbortSignal.any([signal, controller.signal])
    const { artifacts, namespace } = this.options
    return new Promise((resolve, reject) => {
      // Blocks keep their order; a spilled block is a pending receipt.
      const output: Array<
        ControlProgramOutput | Promise<ControlProgramOutput>
      > = []
      let inlineText = 0
      let inlineImages = 0
      let finished = false
      /**
       * A program's own rejection (`retainWorker`) leaves the worker and its
       * `state` in place: the worker reported it in order and is idle. Only
       * a timeout, a cancellation or a worker fault terminates the worker,
       * because then nothing about its state is known.
       */
      const finish = (error?: Error, retainWorker = false) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        signal.removeEventListener("abort", abort)
        worker.removeListener("message", message)
        worker.removeListener("error", failed)
        worker.removeListener("exit", exited)
        controller.abort()
        if (error) {
          if (!retainWorker) {
            this.worker = undefined
            void worker.terminate()
          }
          reject(error)
        } else Promise.all(output).then(resolve, reject)
      }
      const receipt = (pending: Promise<{ artifact: true }>) =>
        pending.then((value): ControlProgramOutput => ({
          type: "text",
          text: JSON.stringify(value),
        }))
      const appendText = (label: string, value: JsonValue) => {
        const text = JSON.stringify(value)
        const bytes = Buffer.byteLength(text)
        if (
          bytes >= INLINE_TEXT_BUDGET ||
          inlineText + bytes > INLINE_TOTAL_BUDGET
        ) {
          output.push(
            receipt(spillJson(artifacts, `${namespace}-${label}`, value, text))
          )
          return
        }
        inlineText += bytes
        output.push({ type: "text", text })
      }
      const appendImage = (block: ControlProgramOutput) => {
        if (block.type === "text") {
          output.push(block)
          return
        }
        if (inlineImages >= INLINE_IMAGE_COUNT) {
          output.push(
            receipt(
              spillImage(
                artifacts,
                `${namespace}-image`,
                block.data,
                block.mimeType
              )
            )
          )
          return
        }
        inlineImages += 1
        output.push(block)
      }
      const failed = (error: Error) => finish(error)
      const exited = () =>
        finish(
          new Error(
            "Control script worker exited. Its last action may have completed."
          )
        )
      const message = (raw: JsonValue) => {
        const parsed = messageSchema.safeParse(raw)
        if (!parsed.success) {
          finish(new Error("Control script returned an invalid message"))
          return
        }
        const value = parsed.data
        if (value.runId !== runId || finished) return
        if (value.kind === "call") {
          void Promise.resolve()
            .then(() =>
              this.options.call(value.command, active, value.namespace)
            )
            .then(
              (result) => {
                if (!finished)
                  worker.postMessage({
                    kind: "reply",
                    id: value.id,
                    value: result,
                  })
              },
              (error) => {
                if (!finished)
                  worker.postMessage({
                    kind: "reply",
                    id: value.id,
                    error:
                      error instanceof Error ? error.message : String(error),
                  })
              }
            )
        } else if (value.kind === "output") appendText("log", value.value)
        else if (value.kind === "image") {
          try {
            for (const block of this.options.image(value.value))
              appendImage(block)
          } catch (error) {
            finish(
              error instanceof Error
                ? error
                : new Error("Control script returned an invalid image")
            )
          }
        } else if (value.kind === "error")
          finish(new Error(value.message), true)
        else {
          if (value.value !== null) appendText("result", value.value)
          finish()
        }
      }
      const abort = () =>
        finish(
          this.options.fault({
            code: "cancelled",
            message:
              "Script cancelled. The worker was stopped; observe any dispatched control action before retrying.",
            outcome: "unknown",
          })
        )
      const timer = setTimeout(
        () =>
          finish(
            this.options.fault({
              code: "timed-out",
              message: `Script exceeded ${PROGRAM_TIME_LIMIT_MS / 1000} seconds. Observe before retrying; script state was reset.`,
              outcome: "unknown",
            })
          ),
        PROGRAM_TIME_LIMIT_MS
      )
      signal.addEventListener("abort", abort, { once: true })
      worker.on("message", message)
      worker.once("error", failed)
      worker.once("exit", exited)
      worker.postMessage({
        kind: "run",
        runId,
        source,
        namespace,
        actions: this.options.actions,
        extra: this.options.extra ?? {},
        artifacts,
      })
    })
  }

  async close(): Promise<void> {
    this.stopping.abort()
    await this.tail
    await this.worker?.terminate()
    this.worker = undefined
  }
}
