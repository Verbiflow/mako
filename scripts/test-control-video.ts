/**
 * A cloud machine's preview as live video, end to end without a browser or FFmpeg: the machine's previews served as its
 * runtime's media through a fake gateway, and this Mac's cloud previews watching it for two windows. Checks the order
 * a viewer is sent (poster, key frame, then deltas), the box the machine captures at, that frames never become
 * activity events, a window that joins late or falls behind starting from a fresh picture without disturbing another,
 * the agent moving to another tab, a turn pausing and resuming, the preview ending, and the machine's link dropping.
 */
import assert from "node:assert/strict"
import type { BrowserFrame } from "@mako/control-runtime/browser"
import type { BrowserTarget, ControlActivity, ControlVideoPacket } from "@mako/control-runtime/contracts"
import { decodeControlVideo } from "@mako/control-runtime/contracts"
import type { CaptureSize } from "../packages/control-runtime/src/browser-capture.js"
import type { LiveEncoderFactory } from "../packages/control-runtime/src/browser-video.js"
import { createFakeGateway } from "@mako/protocol/fake-gateway"
import type { ServedRuntime } from "@mako/protocol"
import { ControlPreviews, type PreviewBrowser } from "@mako/host/control/previews"
import { controlVideoMedia } from "@mako/host/control/video-media"
import { CloudPreviews } from "@mako/host/conversations/cloud-previews"
import { serveHostThroughGateway } from "@mako/host/transport/gateway"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** A fake encoder: every frame comes back as one unit at once, the first of each encoder a key frame. */
let encoders = 0
const encoder: LiveEncoderFactory = (_size, _fps, unit, drained) => {
  encoders++
  let submitted = 0
  let closed = false
  return {
    ready: () => !closed,
    submit(frame) {
      submitted++
      const first = submitted === 1
      queueMicrotask(() => {
        if (closed) return
        const common = { width: frame.width, height: frame.height, sequence: frame.sequence, capturedAt: frame.capturedAt, data: new Uint8Array(frame.bytes.length) }
        unit(first ? { ...common, kind: "key", description: Uint8Array.from([1, 66, 0, 30]) } : { ...common, kind: "delta" })
        drained()
      })
    },
    close() { closed = true },
  }
}

/** The tab's screencast as the browser hands it out: a subscriber whose `authorize` throws is ended, as the capture does. */
interface Source { target: BrowserTarget; authorize: () => void; frame: (frame: BrowserFrame) => void; ended: (reason: string) => void; size: () => CaptureSize | undefined; stopped: boolean }
const sources: Source[] = []
let resizes = 0
const browser: PreviewBrowser = {
  async previewStream(_owner: string, target: BrowserTarget, authorize: () => void, frame: (value: BrowserFrame) => void, ended: (reason: string) => void, size?: () => CaptureSize | undefined) {
    authorize()
    const source: Source = { target, authorize, frame, ended, size: size ?? (() => undefined), stopped: false }
    sources.push(source)
    return async () => { source.stopped = true }
  },
  async previewResized() { resizes++ },
}
const live = () => sources.filter((source) => !source.stopped)
const show = (width = 1280, height = 800, bytes = 2_000) => {
  for (const source of live()) {
    const frame: BrowserFrame = { bytes: Buffer.alloc(bytes, 0xd8), width, height, viewportWidth: width, viewportHeight: height, pageScaleFactor: 1, offsetTop: 0, capturedAt: Date.now() }
    try {
      source.authorize()
    } catch (error) {
      source.stopped = true
      source.ended(error instanceof Error ? error.message : String(error))
      continue
    }
    source.frame(frame)
  }
}

const changes: ControlActivity[] = []
const previews = new ControlPreviews(browser, async () => null, (activity) => changes.push(activity), { encoder, fps: 1000 })
let paused = false
const authorize = () => { if (paused) throw new Error("No turn is running") }
const tab = (id: string): BrowserTarget => ({ browser: "chromium", tab: id, generation: "g1", lease: "l1" })
const act = (target: string, operation = "click") => {
  previews.observe({ conversationId: "c1", kind: "browser", operation, target, status: "running" })
  previews.browserTarget("c1", tab(target), authorize)
}
act("tab-1", "open")

const gateway = createFakeGateway()
const threadId = "t-0123456789abcdef"
const runtimeId = "m-0123456789abcdef.g1"
const serve = async () => {
  const served = await serveHostThroughGateway(await gateway.connectRuntime(), { runtimeId, build: "test", invoke: async () => "null", media: controlVideoMedia(previews) })
  await gateway.assign(threadId, runtimeId)
  return served
}
let served: ServedRuntime = await serve()
const session = await gateway.connectClient({ kind: "client", client: "desktop", deviceId: "d-1" })
const cloud = new CloudPreviews({ session: async () => session })
const activity = (operation = "click"): ControlActivity => ({ conversationId: "c1", kind: "browser", operation, target: "tab-1", status: "running", updatedAt: Date.now() })

/** Reads a viewer until `done` holds of everything it was sent, showing a frame between reads. */
async function readUntil(viewer: string, done: (packets: ControlVideoPacket[]) => boolean, options: { box?: CaptureSize; frames?: () => void; within?: number } = {}) {
  const packets: ControlVideoPacket[] = []
  const deadline = Date.now() + (options.within ?? 5_000)
  let live = true
  while (!done(packets)) {
    if (Date.now() > deadline) assert.fail(`${viewer} was sent ${packets.map((packet) => packet.kind).join(", ") || "nothing"}`)
    const reading = cloud.read("c1", viewer, options.box)
    ;(options.frames ?? (() => show()))()
    const batch = await reading
    live = batch.live
    packets.push(...batch.packets.map((packet) => decodeControlVideo(packet)))
    if (!live) break
  }
  return { packets, live }
}
const kinds = (packets: ControlVideoPacket[]) => packets.map((packet) => packet.kind)

// Nothing streams before the agent has shown anything here.
assert.deepEqual(await cloud.read("c1", "panel"), { live: false, packets: [] })
assert.equal(cloud.preview("c1"), null)

// A window's viewer: a poster at once, the key frame, then deltas, at the box it draws.
await wait(300)
assert.equal(changes.length, 1, "the agent's action is published once")
const opened = activity("open")
cloud.activity(threadId, opened)
assert.deepEqual(cloud.preview("c1"), { activity: opened, frame: null, video: true })
const panel = await readUntil("panel", (packets) => packets.filter((packet) => packet.kind === "delta").length >= 3, { box: { width: 800, height: 500 } })
assert.deepEqual(kinds(panel.packets.slice(0, 2)), ["poster", "key"])
assert.ok(panel.packets.slice(2).every((packet) => packet.kind === "delta"))
assert.deepEqual(live()[0]?.size(), { width: 800, height: 500 }, "the machine captures at the box the window draws")
await wait(300)
assert.deepEqual(changes.map((change) => change.operation), ["open"], "frames never become activity events")

// A second window joins: it starts from a poster and a key frame; the first never sees a poster again.
const resizesBeforeJoin = resizes
const overlay = await readUntil("overlay", (packets) => packets.some((packet) => packet.kind === "key"), { box: { width: 1600, height: 1000 } })
assert.ok(["poster", "key"].includes(overlay.packets[0]!.kind), `a late viewer starts from a picture: ${kinds(overlay.packets)}`)
assert.ok(!overlay.packets.slice(0, overlay.packets.findIndex((packet) => packet.kind === "key")).some((packet) => packet.kind === "delta"), "no delta before its key frame")
const afterJoin = await readUntil("panel", (packets) => packets.length >= 3, { box: { width: 800, height: 500 } })
assert.ok(!afterJoin.packets.some((packet) => packet.kind === "poster"), "a viewer already painting gets no poster")
await wait(300)
assert.deepEqual(live()[0]?.size(), { width: 1600, height: 1000 }, "the machine captures for the largest window")
assert.ok(resizes > resizesBeforeJoin, "a larger window tells the screencast to capture again at its size")

// A window that stops reading falls behind past its queue: it starts over from a fresh picture; the other never stalls.
for (let index = 0; index < 30; index++) {
  show(1280, 800, 200_000)
  await wait(2)
  if (index % 5 === 4) await cloud.read("c1", "panel", { width: 800, height: 500 })
}
const behind = await readUntil("overlay", (packets) => packets.some((packet) => packet.kind === "key"), { box: { width: 1600, height: 1000 } })
assert.ok(["poster", "key"].includes(behind.packets[0]!.kind), `a viewer that fell behind starts from a picture: ${kinds(behind.packets).slice(0, 4)}`)
assert.ok(behind.packets.reduce((total, packet) => total + packet.data.byteLength, 0) < 4.5 * 1024 * 1024, "what it couldn't take was dropped, not queued")

// The agent moves to another tab: the viewers move with it, the new tab's video starting with a key frame at its size.
const before = live()[0]!
act("tab-2")
cloud.activity(threadId, { ...activity(), target: "tab-2" })
await wait(20)
assert.equal(before.stopped, true, "the old tab's screencast stops")
const moved = await readUntil("panel", (packets) => packets.some((packet) => packet.kind === "key" && packet.width === 1024), { box: { width: 800, height: 500 }, frames: () => show(1024, 640) })
assert.ok(moved.live)
assert.equal(live().length, 1)
assert.equal(live()[0]!.target.tab, "tab-2")

// The turn ends: the machine says so and stops; the window shows the last view, and nothing more is read until the agent acts.
paused = true
const ended = await readUntil("panel", () => false, { box: { width: 800, height: 500 }, within: 4_000 })
assert.equal(ended.live, false)
assert.equal(cloud.preview("c1")?.paused, true)
assert.deepEqual(await cloud.read("c1", "panel"), { live: false, packets: [] })
assert.equal(live().length, 0, "the screencast stopped")

// The agent acts again: video resumes from a fresh picture.
paused = false
act("tab-2")
cloud.activity(threadId, { ...activity(), target: "tab-2" })
assert.equal(cloud.preview("c1")?.paused, undefined)
const resumed = await readUntil("panel", (packets) => packets.some((packet) => packet.kind === "key"), { box: { width: 800, height: 500 } })
assert.ok(["poster", "key"].includes(resumed.packets[0]!.kind))

// The machine's link drops: the watch is opened again once it's back, and video resumes.
const watchedBefore = encoders
served.close()
await wait(100)
served = await serve()
const relinked = await readUntil("panel", (packets) => packets.some((packet) => packet.kind === "key"), { box: { width: 800, height: 500 }, within: 8_000 })
assert.ok(relinked.live)
assert.ok(encoders > watchedBefore)

// The agent closes the tab: the preview ends, and the window's card leaves.
previews.closed("c1", { browser: "chromium", tab: "tab-2" })
const gone = await readUntil("panel", () => false, { box: { width: 800, height: 500 }, within: 3_000 })
assert.equal(gone.live, false)
assert.equal(cloud.preview("c1"), null)

// A watch for a conversation the machine shows nothing for ends at once.
cloud.activity(threadId, { ...activity(), conversationId: "c2" })
const nothing = await cloud.read("c2", "panel")
const after = nothing.live ? await cloud.read("c2", "panel") : nothing
assert.equal(after.live, false)
assert.equal(cloud.preview("c2"), null)

cloud.close()
served.close()
await gateway.close()
console.log("Control video: poster then key frame then deltas at the window's box, no activity per frame, late and lagging windows from a fresh picture, the agent changing tabs, a turn pausing and resuming, a dropped link, the preview ending passed")
