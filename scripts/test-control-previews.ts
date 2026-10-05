import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { mock } from "node:test"
import sharp from "sharp"
import { BrowserService } from "@mako/control-runtime/browser"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
  type ControlPreview,
} from "@mako/control-runtime/contracts"
import { ControlPreviews } from "../electron/control-previews.js"
import { browserFixture } from "./browser-control-fixture.js"

const fixture = await browserFixture()
const browser = new BrowserService([fixture.definition])
let events = 0
const previews = new ControlPreviews(
  browser,
  (image) => image,
  () => {
    events++
  }
)
const run = (input: Parameters<typeof BrowserCommandSchema.parse>[0]) =>
  browser.execute(
    "task",
    BrowserCommandSchema.parse(input),
    AbortSignal.timeout(1000)
  )
try {
  await run({ action: "connect", browser: "fixture" })
  const target = BrowserTargetSchema.parse(
    await run({ action: "open", browser: "fixture" })
  )
  const activity = {
    conversationId: "task",
    kind: "browser",
    operation: "observe",
    target: "fixture:tab",
    status: "observed",
  } satisfies Parameters<typeof previews.observe>[0]
  for (let index = 0; index < 100; index++) previews.observe(activity)
  previews.browserTarget("task", target, () => {})
  assert.equal(
    fixture.calls.filter((call) => call.method === "Page.captureScreenshot")
      .length,
    0,
    "Hidden previews do not capture"
  )
  assert.equal(previews.read("other", true), null)
  previews.read("task", true)
  for (
    let i = 0;
    i < 100 && !fixture.calls.some((c) => c.method === "Page.startScreencast");
    i++
  )
    await delay(5)
  const session = fixture.sessionFor(target.tab)!
  const sourceAt = Date.now() - 1500
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII="
  const emit = (data = png, at = sourceAt) =>
    fixture.emit(session, "Page.screencastFrame", {
      sessionId: 1,
      data,
      metadata: {
        deviceWidth: 1600,
        deviceHeight: 1000,
        pageScaleFactor: 1,
        offsetTop: 0,
        timestamp: at / 1000,
      },
    })
  emit()
  for (let i = 0; i < 100 && !previews.read("task", true)?.frame; i++)
    await delay(5)
  assert.ok(previews.read("task", true)?.frame)
  assert.ok(Math.abs(previews.read("task", true)!.frame!.capturedAt - sourceAt) < 1)
  assert.ok(previews.read("task", true)!.frame!.publishedAt! > sourceAt,
    "Delayed source frames must not receive fresh capture timestamps")
  assert.equal(
    fixture.calls.filter((c) => c.method === "Page.captureScreenshot").length,
    0,
    "Preview never takes still screenshots"
  )
  assert.equal(
    fixture.calls.filter((c) => c.method === "Page.startScreencast").length,
    1,
    "Polling shares one stream"
  )
  await delay(260)
  assert.equal(
    events,
    2,
    "One frame notification plus one coalesced activity burst"
  )
  const before = previews.read("task", true)?.frame?.id
  previews.browserTarget("task", { ...target }, () => {})
  previews.read("task", true, "overlay")
  previews.read("task", false, "panel")
  emit()
  await delay(50)
  assert.notEqual(
    previews.read("task", true, "overlay")?.frame?.id,
    before,
    "Repeated target binding must keep delivering frames"
  )
  assert.equal(
    fixture.calls.filter((c) => c.method === "Page.stopScreencast").length,
    0,
    "Closing one consumer preserves the other"
  )
  previews.read("task", true, "desktop", "renderer:7")
  assert.deepEqual(previews.viewers("task", "local"), { own: 1, others: 1, capturing: true },
    "Another client's viewer of the same task is reported as someone else's")
  assert.deepEqual(previews.viewers("task", "renderer:7"), { own: 1, others: 1, capturing: true })
  previews.read("task", false, "desktop", "renderer:7")
  assert.deepEqual(previews.viewers("task", "local"), { own: 1, others: 0, capturing: true })
  assert.deepEqual(previews.viewers("other", "local"), { own: 0, others: 0, capturing: false })
  emit(Buffer.concat([Buffer.from(png, "base64"), Buffer.alloc(2 * 1024 * 1024)]).toString("base64"))
  await delay(50)
  assert.throws(() => previews.read("task", true, "overlay"), /size limit/,
    "Oversized frames report unavailable instead of silently resizing or pretending to stay live")
  assert.doesNotThrow(() => previews.read("task", false, "panel"), "A refused read cannot prevent watcher release")
  emit()
  await delay(50)
  assert.ok(previews.read("task", true, "overlay")?.frame, "Valid source frames resume delivery")
  const counted = previews.read("task", true, "overlay")!.frame!.sequence!
  const slot = 1000 / 60, base = (Math.floor(sourceAt / slot) + 10) * slot
  for (let i = 1; i <= 5; i++) emit(png, base + i * 20)
  await delay(50)
  assert.equal(previews.read("task", true, "overlay")?.frame?.sequence, counted + 5,
    "The host numbers every source frame, including those its 60 fps pace coalesces")
  for (const offset of [205, 208, 212]) emit(png, base + offset)
  await delay(50)
  assert.equal(previews.read("task", true, "overlay")?.frame?.sequence, counted + 6,
    "Frames within one 60 fps slot count once, so a faster source is not a shortfall")
  previews.read("task", false, "overlay")
  assert.deepEqual(previews.viewers("task", "local"), { own: 0, others: 0, capturing: false },
    "The last viewer leaving stops the stream")
  previews.observe({
    ...activity,
    kind: "computer",
    target: "different-window",
  })
  assert.equal(
    previews.read("task", false)?.frame,
    null,
    "Target change clears the old image"
  )
  let authorized = true
  previews.computerTarget("task", { pid: 42, windowId: 70 }, () => {
    if (!authorized) throw new Error("Binding closed")
  })
  assert.deepEqual(previews.nativeWindow("task"), { pid: 42, windowId: 70 })
  assert.equal(
    previews.nativeWindow("other"),
    null,
    "Native sources are task scoped"
  )
  const now = Date.now()
  const clock = mock.method(Date, "now", () => now + 6_000)
  assert.equal(
    previews.read("task", true)?.window,
    undefined,
    "Idle native previews release the video source"
  )
  clock.mock.restore()
  authorized = false
  assert.throws(() => previews.nativeWindow("task"), /Binding closed/)
  assert.equal(
    previews.read("task", true),
    null,
    "Revoked tasks remove retained previews and stop live video"
  )
  for (let index = 0; index < 65; index++)
    previews.observe({ ...activity, conversationId: `task-${index}` })
  assert.equal(previews.read("task", false), null, "Retention is bounded")

  const noise = Buffer.alloc(1920 * 1080 * 3)
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24
  const jpeg = await sharp(noise, { raw: { width: 1920, height: 1080, channels: 3 } }).jpeg({ quality: 90 }).toBuffer()
  const full = {
    activity: { ...activity, updatedAt: Date.now() },
    frame: { id: "frame", image: { mimeType: "image/jpeg" as const, bytes: new Uint8Array(jpeg) }, capturedAt: 1, publishedAt: 2, sequence: 3 },
  }
  const dimensions = async (preview: ControlPreview) => {
    assert.ok(preview.frame)
    const { width, height } = await sharp(preview.frame.image.bytes).metadata()
    return [preview.frame.id, width, height]
  }
  const card = await previews.sized(full, { width: 576, height: 324 })
  assert.deepEqual(await dimensions(card), ["frame:576x324", 576, 324],
    "A 576-pixel viewer gets exactly the pixels it displays")
  assert.ok(card.frame)
  assert.ok(card.frame.image.bytes.byteLength < jpeg.byteLength / 3, "The scaled frame is a fraction of the capture's bytes")
  assert.deepEqual([card.frame.capturedAt, card.frame.publishedAt, card.frame.sequence, card.activity], [1, 2, 3, full.activity],
    "Scaling keeps the frame's timing, sequence and activity")
  assert.equal((await previews.sized(full, { width: 576, height: 324 })).frame?.image.bytes, card.frame.image.bytes,
    "Viewers of one frame share one scaling")
  assert.deepEqual(await dimensions(await previews.sized(full, { width: 576, height: 100 })), ["frame:178x100", 178, 100],
    "A wide, short viewer is fitted by height, as the viewer fits it")
  assert.deepEqual(await dimensions(await previews.sized(full, { width: 1200, height: 700 })), ["frame:1200x675", 1200, 675],
    "A larger viewer gets a larger frame under a new id")
  for (const box of [undefined, { width: 1700, height: 960 }, { width: 1920, height: 1080 }, { width: 4000, height: 3000 }, { width: 0, height: 324 }, { width: -1, height: -1 }])
    assert.equal(await previews.sized(full, box), full, `No box, one saving under an eighth, a covering box or an unmeasured one keeps full pixels: ${JSON.stringify(box)}`)
  const pngFrame = { ...full, frame: { ...full.frame, image: { mimeType: "image/png" as const, bytes: full.frame.image.bytes } } }
  assert.equal(await previews.sized(pngFrame, { width: 100, height: 100 }), pngFrame, "Only JPEG frames are rescaled")
  const corrupt = { ...full, frame: { ...full.frame, id: "corrupt", image: { mimeType: "image/jpeg" as const, bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 4, 56, 7, 128, 3, 1, 0x11, 0]) } } }
  assert.equal(await previews.sized(corrupt, { width: 100, height: 100 }), corrupt, "A frame that cannot be scaled is sent as captured")
  assert.equal(full.frame.image.bytes.byteLength, jpeg.byteLength, "The retained capture stays full size")
  console.log(
    "Control previews: hidden capture suppression, one shared stream, task isolation, viewer ownership, event coalescing, target invalidation, bounded retention and viewer-sized frames passed"
  )
} finally {
  previews.close()
  browser.close()
  await fixture.close()
}
