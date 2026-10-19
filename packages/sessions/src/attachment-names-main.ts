/**
 * The attachments' sweep's reading child (`attachment-sweep.ts`,
 * `NamesAside`): reads each source its parent sends, answers with what it
 * names, and exits when the parent lets it go. It runs with `--expose-gc`
 * and collects once its reads have brought in `COLLECT_EVERY` bytes: each
 * value SQLite hands over is a buffer or string the collector would
 * otherwise let pile up past a hundred megabytes before it looked (measured
 * on this Mac's archive: 4 MiB pieces and a collection every 8 MiB peaked
 * 100 MiB over the child's 63, in 4.7 s; every 32 MiB, 137 MiB).
 */
import { NamesJobSchema, readJob, type NamesReply } from "./attachment-sweep.js"

const COLLECT_EVERY = 8 * 1024 * 1024
const counter = { bytes: 0 }
const pressure = (bytes: number) => {
  counter.bytes += bytes
  if (counter.bytes < COLLECT_EVERY) return
  counter.bytes = 0
  // `--expose-gc` sets it; a child started without it reads all the same.
  globalThis.gc?.()
}

process.on("message", (message) => {
  const job = NamesJobSchema.safeParse(message)
  const read: Promise<NamesReply> = job.success ? readJob(job.data, pressure) : Promise.resolve({ ok: false, error: "the job doesn't parse" })
  void read.then((reply) => process.send?.(reply))
})
process.once("disconnect", () => process.exit(0))
