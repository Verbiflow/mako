import {
  ControlFault,
  ControlFaultSchema,
  controlFaultData,
} from "../control/fault.js"
import { existsSync } from "node:fs"
import { Worker } from "node:worker_threads"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"
import {
  INLINE_IMAGE_COUNT,
  INLINE_IMAGE_BYTES,
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
    fault: ControlFaultSchema.optional(),
  }),
])

export const PROGRAM_TIME_LIMIT_MS = 60_000
export const PROGRAM_YIELD_MS = 10_000
const MAX_RETAINED_CELLS = 8

export const ControlProgramRequestSchema = z
  .object({
    source: z
      .string()
      .min(1)
      .max(100_000)
      .optional()
      .describe('Async JavaScript, e.g. {"source":"return 1"}.'),
    cell: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Numeric continuation ID, e.g. {"cell":1}.'),
  })
  .refine(
    (request) =>
      (request.source === undefined) !== (request.cell === undefined),
    { message: "Pass exactly one of source or cell" }
  )
  .strict()
/** Publish the XOR as well as enforcing it: Zod refinements are not JSON Schema. */
export const ControlProgramInputSchema = {
  ...z.toJSONSchema(ControlProgramRequestSchema, { io: "input" }),
  oneOf: [{ required: ["source"] }, { required: ["cell"] }],
}

export type ControlProgramRequest = z.infer<typeof ControlProgramRequestSchema>

export type ControlProgramOutput =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }

export interface ControlProgramExecution {
  yield?: boolean
  mode?: "script" | "repl"
  timeoutMs?: number
}

/** Keep already-emitted evidence when a later statement fails. */
export class ControlProgramError extends Error {
  constructor(readonly output: ControlProgramOutput[], readonly cause: Error) {
    super(cause.message)
    this.name = "ControlProgramError"
  }
}

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
  /** Model instructions emitted only by the REPL, refreshed after worker reset. */
  replDocumentation?: string
  call(
    command: JsonObject,
    signal: AbortSignal,
    namespace: string
  ): Promise<JsonValue>
  image(value: JsonValue): ControlProgramOutput[]
  fault(detail: ControlProgramFault): Error
  /** Test override; production cells yield after ten seconds. */
  yieldAfterMs?: number
}

interface ProgramCell {
  promise: Promise<ControlProgramOutput[]>
  settled: boolean
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
  private readonly cells = new Map<number, ProgramCell>()

  constructor(options: ControlProgramOptions) {
    this.options = options
  }

  run(source: string, signal: AbortSignal, options: ControlProgramExecution = {}): Promise<ControlProgramOutput[]> {
    if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > PROGRAM_TIME_LIMIT_MS))
      return Promise.reject(new ControlFault("invalid-request", `Program timeout must be an integer from 1 to ${PROGRAM_TIME_LIMIT_MS} milliseconds.`, "not-dispatched"))
    const retained = this.cells.keys().next().value
    if (retained !== undefined)
      return Promise.reject(
        new ControlFault(
          "cell-pending",
          `Control cell ${String(retained)} must be collected before another program starts. Call this same exec tool with ${JSON.stringify({ cell: retained })}.`,
          "not-dispatched"
        )
      )
    const active = AbortSignal.any([signal, this.stopping.signal])
    const cellId = ++this.sequence
    const result = this.tail.then(() => {
      active.throwIfAborted()
      return this.execute(source, active, cellId, options)
    })
    this.tail = result.then(
      () => undefined,
      () => undefined
    )
    if (options.yield === false) return result
    return new Promise((resolve, reject) => {
      let yielded = false
      const timer = setTimeout(() => {
        yielded = true
        this.retainCell(cellId, result)
        resolve([
          {
            type: "text",
            text: JSON.stringify({
              cell: cellId,
              status: "running",
              wait: `Call this same exec tool with ${JSON.stringify({ cell: cellId })} to collect this program. Do not resubmit its source.`,
            }),
          },
        ])
      }, this.options.yieldAfterMs ?? PROGRAM_YIELD_MS)
      void result.then(
        (output) => {
          if (yielded) return
          clearTimeout(timer)
          resolve(output)
        },
        (error) => {
          if (yielded) return
          clearTimeout(timer)
          reject(error)
        }
      )
    })
  }

  wait(cellId: number, signal: AbortSignal): Promise<ControlProgramOutput[]> {
    signal.throwIfAborted()
    const cell = this.cells.get(cellId)
    if (!cell)
      return Promise.reject(
        new ControlFault(
          "cell-not-found",
          `Control cell ${String(cellId)} is not retained; it was already collected or belongs to another MCP client. No program was started. Check the original result or client before considering another mutation.`,
          "not-dispatched"
        )
      )
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort)
        reject(
          this.options.fault({
            code: "cancelled",
            message:
              "Stopped waiting for the control cell. The cell may still complete; wait for the same cell before starting another mutation.",
            outcome: "unknown",
          })
        )
      }
      signal.addEventListener("abort", abort, { once: true })
      void cell.promise.then(
        (output) => {
          signal.removeEventListener("abort", abort)
          // An abandoned wait never consumes the eventual action receipt.
          if (signal.aborted) return
          this.cells.delete(cellId)
          resolve(output)
        },
        (error) => {
          signal.removeEventListener("abort", abort)
          // An abandoned wait never consumes the eventual action receipt.
          if (signal.aborted) return
          this.cells.delete(cellId)
          reject(error)
        }
      )
    })
  }

  private retainCell(
    cellId: number,
    promise: Promise<ControlProgramOutput[]>
  ): void {
    while (this.cells.size >= MAX_RETAINED_CELLS) {
      const settled = [...this.cells].find(([, cell]) => cell.settled)
      if (!settled)
        throw new Error(
          "Too many control cells are still running; wait for one before starting another."
        )
      this.cells.delete(settled[0])
    }
    const cell: ProgramCell = { promise, settled: false }
    this.cells.set(cellId, cell)
    void promise.then(
      () => {
        cell.settled = true
      },
      () => {
        cell.settled = true
      }
    )
  }

  private execute(
    source: string,
    signal: AbortSignal,
    runId: number,
    execution: ControlProgramExecution
  ): Promise<ControlProgramOutput[]> {
    const compiled = new URL("./worker.js", import.meta.url)
    this.worker ??= new Worker(
      existsSync(compiled) ? compiled : new URL("./worker.ts", import.meta.url),
      { env: {}, resourceLimits: { maxOldGenerationSizeMb: 128 } }
    )
    const worker = this.worker
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
      let inlineImageBytes = 0
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
          if (execution.mode === "repl")
            void Promise.all(output).then(blocks => reject(new ControlProgramError(blocks, error)), reject)
          else reject(error)
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
        if (inlineImages >= INLINE_IMAGE_COUNT || inlineImageBytes + block.data.length > INLINE_IMAGE_BYTES) {
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
        inlineImageBytes += block.data.length
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
                    fault: controlFaultData(error),
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
          finish(
            value.fault
              ? new ControlFault(
                  value.fault.code,
                  value.message,
                  value.fault.outcome
                )
              : new Error(value.message),
            true
          )
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
              message: `Script exceeded ${(execution.timeoutMs ?? PROGRAM_TIME_LIMIT_MS) / 1000} seconds. Observe before retrying; script state was reset.`,
              outcome: "unknown",
            })
          ),
        execution.timeoutMs ?? PROGRAM_TIME_LIMIT_MS
      )
      signal.addEventListener("abort", abort, { once: true })
      worker.on("message", message)
      worker.once("error", failed)
      worker.once("exit", exited)
      worker.postMessage({
        kind: "run",
        runId,
        source,
        mode: execution.mode ?? "script",
        documentation: this.options.replDocumentation,
        namespace,
        actions: this.options.actions,
        extra: this.options.extra ?? {},
        artifacts,
      })
    })
  }

  /** Serialized with both interfaces. Target ownership stays in the session. */
  reset(signal: AbortSignal): Promise<void> {
    if (this.cells.size)
      return Promise.reject(new ControlFault("cell-pending", "Collect the pending CLI program before resetting bindings.", "not-dispatched"))
    const result = this.tail.then(async () => {
      signal.throwIfAborted()
      this.stopping.signal.throwIfAborted()
      await this.worker?.terminate()
      this.worker = undefined
    })
    this.tail = result.catch(() => {})
    return result
  }

  async close(): Promise<void> {
    this.stopping.abort()
    await this.tail
    await this.worker?.terminate()
    this.worker = undefined
    this.cells.clear()
  }
}
