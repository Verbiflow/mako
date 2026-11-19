// The grace is a wall-clock bound on a worker that may be stuck: taken from `node:timers` as this module loads, a test
// that fakes its own timers still has the grace end.
import { clearTimeout, setTimeout } from "node:timers"
import { MessageChannel, MessagePort, Worker, workerData, type WorkerOptions } from "node:worker_threads"
import { z } from "zod"

/**
 * How long a stopped worker has to end itself before it is terminated. It ends at its next turn of its loop, so only
 * a read stuck past every timeout waits this long.
 */
export const STOP_GRACE_MS = 10_000
/** Where in its worker data a `StoppableWorker` hands its worker the port it is stopped through. */
export const STOP_PORT = "makoStopPort"
/** A stoppable worker's data: an object, which its stop port joins. */
const WorkerDataSchema = z.record(z.string(), z.unknown())
/** The stop port, as a worker finds it in its data. */
const StopPortSchema = z.object({ [STOP_PORT]: z.instanceof(MessagePort) })

/**
 * A worker its host stops by asking it to end itself (`exitWhenStopped`), and terminates only if it hasn't by the
 * grace. `terminate()` stops a worker's JS wherever it is, and in Node 24 one that lands between a zlib stream's
 * handle being made and its `init` (each `zstdDecompressSync` makes one) aborts the whole process as the worker's
 * environment is freed: `CompressionStream::Close()`'s `CHECK(init_done_ && "close before init")`, then a fatal
 * "Cannot create a handle without a HandleScope" (nodejs/node#67485). A worker that ends itself does so from its own
 * JS, never inside that constructor. Every worker that can reach zlib is started as one of these.
 */
export class StoppableWorker extends Worker {
  private readonly stopPort: MessagePort
  private exited: number | undefined
  private stopping: Promise<number> | undefined

  constructor(entry: string | URL, options: WorkerOptions = {}) {
    const { port1, port2 } = new MessageChannel()
    const data = WorkerDataSchema.parse(options.workerData ?? {})
    super(entry, { ...options, workerData: { ...data, [STOP_PORT]: port2 }, transferList: [...(options.transferList ?? []), port2] })
    this.stopPort = port1
    this.once("exit", (code) => {
      this.exited = code
      port1.close()
    })
  }

  /** Asks the worker to end itself and resolves with its exit code once it has; terminated past `graceMs`. */
  stop(graceMs = STOP_GRACE_MS): Promise<number> {
    if (this.exited !== undefined) return Promise.resolve(this.exited)
    this.stopping ??= new Promise((resolve, reject) => {
      const late = setTimeout(() => { this.terminate().catch(reject) }, graceMs)
      this.once("exit", (code) => {
        clearTimeout(late)
        resolve(code)
      })
      try { this.stopPort.postMessage("stop") }
      catch { clearTimeout(late); this.terminate().catch(reject) }
    })
    return this.stopping
  }
}

/**
 * In a `StoppableWorker`: ends this worker when its host stops it, after `cleanup`. The port is unreferenced, so a
 * worker with nothing else to do still ends on its own. A worker started without one (a test's plain `Worker`) has
 * only `terminate()`.
 */
export function exitWhenStopped(cleanup?: () => void): void {
  const data = StopPortSchema.safeParse(workerData)
  if (!data.success) return
  const port = data.data[STOP_PORT]
  port.once("message", () => {
    try { cleanup?.() }
    finally { process.exit(0) }
  })
  port.unref()
}
