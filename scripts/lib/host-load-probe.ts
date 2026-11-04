import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { z } from "zod"
import { invokeRuntime, probeRuntime } from "@mako/host/transport/connection"

/*
 * The person's side of `bench:host-load`, in a process of its own: a health check every `everyMs` and a read every
 * `readEveryMs` (`channel`), each timed from send to answer, as a window and the desktop's watchdog ask. Each probe
 * waits for the last, so a held host shows as one long answer, not a queue of short ones. On SIGTERM it writes every
 * time to `out`: `[sentAt, ms]`, with `ms` null for a probe that failed or passed `timeoutMs`.
 */

const [socket, out, channel, everyMs, readEveryMs, timeoutMs] = z.tuple([z.string(), z.string(), z.string(), z.coerce.number(), z.coerce.number(), z.coerce.number()]).parse(process.argv.slice(2))
const client = randomUUID()
const health: [number, number | null][] = []
const reads: [number, number | null][] = []
let stopped = false

async function loop(times: [number, number | null][], every: number, ask: () => Promise<void>) {
  while (!stopped) {
    const sent = performance.now()
    const ms = await ask().then(() => performance.now() - sent, () => null)
    times.push([Math.round(sent), ms === null ? null : Math.round(ms * 10) / 10])
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, every - (performance.now() - sent))))
  }
}

void loop(health, everyMs, async () => {
  await probeRuntime(socket, { timeoutMs })
})
void loop(reads, readEveryMs, async () => {
  await invokeRuntime(socket, client, channel, [], 1, { timeoutMs })
})
process.on("SIGTERM", () => {
  stopped = true
  writeFileSync(out, JSON.stringify({ health, reads }))
  process.exit(0)
})
