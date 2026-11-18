/**
 * What the host sends a window that said nobody can see it (`windowShown`): nothing that exists only to be painted
 * (`live-ahead`), and everything else exactly as before. A window that says it shows again hears text ahead again, a
 * window that never says anything (one from before the call) hears everything, and so does a stream opened after a
 * hidden one, until its window says otherwise.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/test-window-shown-host.ts
 */
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { subscribeRuntime } from "@mako/host/transport/connection"
import { startWebHost } from "@mako/host/transport/server"
import { COMPACT_LIVE_FORM, WINDOW_LIVE_FORM } from "@mako/protocol/live-form"

const root = mkdtempSync(join(tmpdir(), "mako-window-shown-"))
const socket = join(root, "host.sock")
const host = await startWebHost(socket, async () => "null", async () => new Response("fixture"), undefined, { protocol: 1, instanceId: randomUUID(), pid: process.pid, version: "fixture", methods: [] })

/** A reader of the host's stream, and the client the host knows it by. */
async function reading(live: typeof WINDOW_LIVE_FORM | typeof COMPACT_LIVE_FORM, client: string = randomUUID()) {
  const before = new Set(host.clients())
  const heard: string[] = []
  let ready = false
  const stop = subscribeRuntime(socket, client, (packet) => {
    if (packet.channel === "ready") ready = true
    else if (packet.channel === "event" && packet.type !== undefined) heard.push(packet.type)
  }, () => undefined, { history: true, live })
  while (!ready) await delay(5)
  const known = host.clients().find((each) => !before.has(each)) ?? host.clients().find((each) => each.endsWith(client))
  assert.ok(known, "the host lists the window")
  return { heard, stop, client: known, ahead: () => heard.filter((type) => type === "live-ahead").length, batches: () => heard.filter((type) => type === "live-batch").length }
}

const id = randomUUID()
let revision = 1
/** A stretch of a turn as the host says it: `frames` of text ahead, then the batch that carries it. */
async function say(frames: number): Promise<void> {
  for (let index = 0; index < frames; index += 1) host.windowEvent({ type: "live-ahead", ahead: { id, revision, epoch: "e", more: "word ".repeat(index + 1) } })
  revision += 1
  host.event({ type: "live-batch", batch: { id, revision, epoch: "e", updates: [{ kind: "text", id: "a1", text: "the batch" }] } })
  await delay(150)
}

try {
  const hides = await reading(WINDOW_LIVE_FORM)
  const older = await reading(WINDOW_LIVE_FORM)
  const device = await reading(COMPACT_LIVE_FORM)

  await say(20)
  assert.deepEqual([hides.ahead(), hides.batches()], [20, 1], "a window that has said nothing hears everything")
  assert.deepEqual([older.ahead(), older.batches()], [20, 1])

  assert.equal(host.windowShown(hides.client, false), true, "the window's stream is marked")
  await say(20)
  assert.deepEqual([hides.ahead(), hides.batches()], [20, 2], "hidden: no frame of text ahead, and the batch as ever")
  assert.deepEqual([older.ahead(), older.batches()], [40, 2], "a window that never says anything, as one from before this, still hears everything")
  assert.deepEqual(device.heard, ["live-batch", "live-batch"], "and another device hears what it always did")

  assert.equal(host.windowShown(hides.client, false), true, "saying it twice changes nothing")
  assert.equal(host.windowShown(hides.client, true), true)
  await say(20)
  assert.deepEqual([hides.ahead(), hides.batches()], [40, 3], "shown again: text ahead resumes")

  // A stream opened after the hidden one is a new page of the same window: shown until it says otherwise.
  assert.equal(host.windowShown(hides.client, false), true)
  hides.stop()
  await delay(50)
  const again = await reading(WINDOW_LIVE_FORM, hides.client.split(":").at(-1))
  await say(10)
  assert.equal(again.ahead(), 10, "a new stream starts out shown")

  assert.equal(host.windowShown(randomUUID(), false), false, "a client with no stream here marks nothing")
  assert.equal(host.windowShown("web", false), false, "anonymous readers share a name: one of them can't hide the others")
  await say(5)
  assert.equal(older.ahead(), 75, "and nobody else's stream was touched")

  again.stop()
  older.stop()
  device.stop()
  console.log("PASS: a hidden window is sent no paint-only frames, a shown or silent one is sent everything")
} finally {
  await host.close()
  rmSync(root, { recursive: true, force: true })
}
