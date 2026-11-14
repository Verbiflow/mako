import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { request, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { followHostLog, type HostLogLine } from "@mako/host/base/host-log"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { splitRuntimeEventLine } from "@mako/host/contracts/runtime-value"
import { subscribeRuntime, type RuntimeStreamEnd } from "@mako/host/transport/connection"
import { startWebHost } from "@mako/host/transport/server"

/**
 * What a host does with an event stream that holds more than it should (`transport/server.ts`). On 2026-11-07 one Fin's
 * rosters reached a window at 10 MB/s and the host reset its stream at 8 MB, up to 12 times in 30 s, saying nothing:
 * a reader that reads as fast as it can is still behind in a burst. A stream that's behind hears the conversations it
 * missed as a notice to read them again, and every stream that ends says why, with the bytes it held.
 */
const root = await mkdtemp(join(tmpdir(), "mako-stream-limits-"))
const socket = join(root, "host.sock")
const info = { protocol: 1 as const, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [] }
const host = await startWebHost(socket, async () => "null", async () => new Response("fixture"), undefined, info)
const lines: HostLogLine[] = []
const stopFollowing = followHostLog((line) => { if (line.scope === "stream") lines.push(line) })

const HeardSchema = z.object({ batch: z.object({ id: z.string(), revision: z.number(), historyChanged: z.boolean().optional(), nativeAgents: z.unknown().optional() }).optional() })

/** A window's stream that takes nothing until `resume`, so everything sent waits in the host. */
async function stalled(history = true) {
  const client = randomUUID()
  let text = ""
  const opened = new Promise<IncomingMessage>((resolve, reject) => {
    const req = request({ agent: false, socketPath: socket, path: "/events", method: "POST", headers: { "x-mako-window": client, ...history && { "x-mako-history": "1" } } }, resolve)
    req.on("error", reject)
    req.end()
  })
  const response = await opened
  response.setEncoding("utf8")
  response.on("data", (chunk: string) => { text += chunk })
  response.on("error", () => {})
  while (!text.includes("\"ready\"")) await delay(5)
  response.pause()
  return {
    client,
    resume: () => { response.resume() },
    leave: () => { response.destroy() },
    text: () => text,
    /** Each whole event heard, decoded. */
    events: () => text.split("\n").flatMap((line) => {
      const event = splitRuntimeEventLine(line)
      return event ? [HeardSchema.parse(JSON.parse(event.payload))] : []
    }),
  }
}

/** A live batch of nothing but a roster, `bytes` long, as a Fin's Apex hears one. */
function batch(id: string, revision: number, bytes: number): HostEvent {
  const agent = { nativeId: "a", title: "x".repeat(bytes), work: "agent" as const, background: true, stoppable: false, state: { kind: "working" as const }, bindingId: "b", provider: "codex", observedAt: 0 }
  return { type: "live-batch", batch: { id, revision, epoch: "e", updates: [], nativeAgents: { agents: [agent], limited: false } } }
}
/** An event that isn't a live batch, carrying `word`. */
function marker(word: string): HostEvent {
  return { type: "host-disconnected", message: word }
}

// A stream past its limit stays open, however much more comes.
{
  const one = randomUUID()
  const two = randomUUID()
  const stream = await stalled()
  // Each under the 512 KB a history reader takes whole, as a roster is.
  for (let revision = 1; revision <= 30; revision += 1) {
    host.event(batch(one, revision, 400 * 1024))
    host.event(batch(two, revision, 400 * 1024))
    await delay(1)
  }
  host.event(marker("still-in-order"))
  await delay(50)
  assert.ok(!lines.some((line) => /stream ended/.test(line.message)), "the host keeps a stream that's behind")
  assert.ok(lines.some((line) => /fell behind/.test(line.message) && Number(line.fields?.queuedBytes) > 8 * 1024 * 1024), "and says so with the bytes it holds")

  // Read on: what it held arrives, then one notice per conversation it missed, at the latest revision.
  stream.resume()
  for (let waited = 0; waited < 400 && !lines.some((line) => /caught up/.test(line.message)); waited += 1) await delay(10)
  await delay(50)
  const notices = stream.events().flatMap(({ batch: heard }) => heard?.historyChanged ? [heard] : [])
  assert.deepEqual(notices.map(({ id, revision }) => [id, revision]).sort(), [[one, 30], [two, 30]].sort(), "each missed conversation hears once, at its latest revision")
  assert.ok(stream.text().includes("still-in-order"), "what isn't a live batch still arrives")
  assert.ok(lines.some((line) => /caught up/.test(line.message)), "and the stream says it caught up")

  // Caught up: batches go whole again.
  host.event(batch(one, 31, 64))
  await delay(50)
  assert.ok(stream.events().some(({ batch: heard }) => heard?.revision === 31 && heard.nativeAgents), "a stream that caught up hears batches whole")
  stream.leave()
}

// Many conversations cost a stream their notices, never their batches: 180 of 900 KB each, as a reader with no limit of its own takes.
{
  const stream = await stalled(false)
  lines.length = 0
  const conversations = Array.from({ length: 180 }, () => randomUUID())
  for (const conversation of conversations) {
    host.event(batch(conversation, 1, 900 * 1024))
    await delay(1)
  }
  assert.ok(!lines.some((line) => /stream ended/.test(line.message)), "the stream stays, its batches let go as they're missed")
  stream.resume()
  const caughtUp = () => lines.find((line) => /caught up/.test(line.message))
  for (let waited = 0; waited < 400 && !caughtUp(); waited += 1) await delay(10)
  await delay(50)
  const missed = Number(caughtUp()?.fields?.conversations)
  assert.ok(missed > 160, `most of them missed (${missed})`)
  assert.ok(Number(caughtUp()?.fields?.missedBytes) <= missed * 256, `what it kept is a short notice each (${caughtUp()?.fields?.missedBytes} bytes)`)
  const notices = stream.events().flatMap(({ batch: heard }) => heard?.historyChanged ? [heard.id] : [])
  assert.equal(new Set(notices).size, missed, "and each hears its notice")
  stream.leave()
}

// The client leaving is a stream end too.
{
  const stream = await stalled()
  stream.resume()
  await delay(50)
  lines.length = 0
  stream.leave()
  for (let waited = 0; waited < 200 && !lines.length; waited += 1) await delay(5)
  const ended = lines.find((line) => /stream ended/.test(line.message))
  assert.ok(ended, "every stream end is a line")
  assert.equal(ended.fields?.client, `web:${stream.client}`)
  assert.equal(ended.fields?.why, "the client left")
  assert.equal(ended.fields?.queuedBytes, 0, "with what it held")
  assert.ok(Number(ended.fields?.livedMs) >= 50, "and how long it lived")
}

// A stream that has stopped reading is let go only past what no burst reaches, and says so.
{
  const stream = await stalled()
  lines.length = 0
  const big = marker("y".repeat(4 * 1024 * 1024))
  const ended = () => lines.find((line) => /stream ended/.test(line.message))
  for (let sent = 0; sent < 40 && !ended(); sent += 1) {
    host.event(big)
    await delay(1)
  }
  assert.ok(ended(), "a stream past what can be held goes")
  assert.equal(ended()?.fields?.why, "it stopped reading")
  const held = Number(ended()?.fields?.queuedBytes)
  assert.ok(held > 8 * 1024 * 1024, "with the bytes it held")
  assert.ok(held <= 64 * 1024 * 1024, `and never past the limit, not by one write (${held})`)
  stream.leave()
}

// A reader says how its stream ended, with what it heard.
{
  const end = new Promise<RuntimeStreamEnd>((resolve) => { subscribeRuntime(socket, randomUUID(), () => {}, resolve) })
  await delay(50)
  host.close()
  const said = await end
  assert.equal(said.why, "the host ended it")
  assert.ok(said.heardBytes > 0, "and what it had heard")
  assert.ok(said.livedMs >= 50, "and how long it lived")
}

stopFollowing()
await rm(root, { recursive: true, force: true })
console.log("event stream limits: ok")
