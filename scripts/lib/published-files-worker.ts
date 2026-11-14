// One process writing through `publishFile`, for `test-published-files.ts`.
// `publish` replaces the file `count` times, each time with a whole JSON
// record of a different length. `stall` publishes bytes that stop halfway:
// it prints `stalled` once the first half is staged and waits for a SIGKILL.
import { publishFile } from "@mako/host/base/published-files"

interface Case { mode: "publish" | "stall"; file: string; tag: string; count: number }
// SAFETY: the test that spawns this worker serialises a `Case` into CASE.
const job = JSON.parse(process.env.CASE ?? "null") as Case

if (job.mode === "publish") {
  for (let index = 0; index < job.count; index++)
    await publishFile(job.file, JSON.stringify({ tag: job.tag, index, pad: "x".repeat(((index * 7919) % 50) * 1024) }))
  process.exit(0)
}

async function* halfThenNothing() {
  yield Buffer.from(`{"tag":"${job.tag}","pad":"${"y".repeat(64 * 1024)}`)
  process.stdout.write("stalled\n")
  await new Promise(() => setInterval(() => undefined, 60_000))
}
await publishFile(job.file, halfThenNothing())
