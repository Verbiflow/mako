import assert from "node:assert/strict"
import { createControlPreviewPainter, createControlPreviewRate, type ControlPreviewRate } from "../src/lib/control-preview-painter.js"
import { controlPreviewEighths, controlPreviewSize, fitControlPreview } from "../src/lib/control-preview-decoder.js"

const requests: FakeImage[] = []
class FakeImage {
  private source = ""
  readonly urls: string[] = []
  get src() {
    return this.source
  }
  set src(value: string) {
    this.source = value
    if (value.startsWith("blob:")) this.urls.push(value)
  }
  naturalWidth = 1920
  naturalHeight = 1080
  ready = () => {}
  fail = () => {}
  decode() {
    requests.push(this)
    return new Promise<void>((resolve, reject) => {
      this.ready = resolve
      this.fail = () => reject(new Error("bad pixels"))
    })
  }
}
const callbacks = new Map<number, FrameRequestCallback>()
let next = 0
const originals = new Map(
  ["Image", "ImageDecoder", "requestAnimationFrame", "cancelAnimationFrame"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
)
Object.defineProperties(globalThis, {
  Image: { configurable: true, value: FakeImage },
  requestAnimationFrame: {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      const id = ++next
      callbacks.set(id, callback)
      return id
    },
  },
  cancelAnimationFrame: {
    configurable: true,
    value: (id: number) => callbacks.delete(id),
  },
})
const painted: FakeImage[] = []
const canvas = {
  width: 300,
  height: 150,
  getContext: () => ({
    drawImage: (image: CanvasImageSource) => {
      assert.ok(image instanceof FakeImage)
      painted.push(image)
    },
  }),
}
const frame = (id: number) => ({
  id: String(id),
  image: {
    bytes: new TextEncoder().encode(String(id)),
    mimeType: "image/jpeg" as const,
  },
  capturedAt: id,
})
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const paint = async () => {
  for (const [id, callback] of callbacks) {
    callbacks.delete(id)
    callback(0)
  }
  await flush()
}
const painter = createControlPreviewPainter(canvas)
try {
  painter.update(frame(1))
  for (let id = 2; id <= 100; id++) painter.update(frame(id))
  assert.equal(
    requests.length,
    1,
    "One decode in flight despite a burst of 100 frames"
  )
  assert.deepEqual(painted, [], "Unfinished decoding cannot replace pixels")
  requests[0]!.ready()
  await flush()
  await paint()
  assert.equal(requests[0]!.src, "", "Painted images release their source")
  assert.equal(
    painted.length,
    1,
    "A completed frame is displayed even under continuous arrivals"
  )
  assert.equal(canvas.width, 1920)
  assert.equal(canvas.height, 1080)
  assert.equal(requests.length, 2)
  assert.ok(
    (await (await fetch(requests[1]!.src)).text()) === "100",
    "Only the newest waiting frame survives"
  )
  requests[1]!.naturalWidth = 1200
  requests[1]!.naturalHeight = 900
  requests[1]!.ready()
  await flush()
  await paint()
  assert.equal(canvas.width, 1200)
  assert.equal(canvas.height, 900)
  painter.update(frame(100))
  await flush()
  assert.equal(
    requests.length,
    2,
    "Repeating a retained frame does no decode work"
  )
  painter.update(frame(101))
  requests[2]!.fail()
  await flush()
  assert.equal(
    painted.length,
    2,
    "Corrupt pixels retain the last complete image"
  )
  painter.update(frame(102))
  requests[3]!.naturalWidth = 100_000
  requests[3]!.ready()
  await flush()
  assert.equal(painted.length, 2, "Oversized allocation is refused")
  painter.update(frame(103))
  requests[4]!.ready()
  await flush()
  assert.equal(callbacks.size, 1)
  painter.close()
  painter.close()
  await paint()
  assert.equal(callbacks.size, 0)
  assert.equal(
    painted.length,
    2,
    "Target disposal cancels a scheduled old frame"
  )
  painter.update(frame(104))
  assert.equal(requests.length, 5)
  const nextTarget = createControlPreviewPainter(canvas)
  nextTarget.update(frame(105))
  nextTarget.close()

  requests[5]!.ready()
  await flush()
  await paint()
  assert.equal(
    painted.length,
    2,
    "Late decode completion cannot paint after disposal"
  )
  assert.ok(
    requests.every((image) => image.src === ""),
    "Every decoded image is released, including failed, late and oversized output"
  )
  const beforeShared = requests.length
  const left = createControlPreviewPainter(canvas),
    right = createControlPreviewPainter(canvas)
  const shared = frame(200)
  left.update(shared)
  right.update(shared)
  assert.equal(
    requests.length,
    beforeShared + 1,
    "Two consumers of one frame share one decode"
  )
  const sharedImage = requests.at(-1)!
  left.close()
  assert.notEqual(
    sharedImage.src,
    "",
    "Closing one viewer cannot release another viewer's image"
  )
  sharedImage.ready()
  await flush()
  await paint()
  assert.equal(sharedImage.src, "", "The last paint releases the shared image")
  right.close()
  const fast = createControlPreviewPainter(canvas)
  fast.update(frame(201))
  requests.at(-1)!.ready()
  await flush()
  const superseded = requests.at(-1)!
  fast.update(frame(202))
  requests.at(-1)!.ready()
  await flush()
  assert.equal(
    superseded.src,
    "",
    "New completed pixels replace and release a waiting paint"
  )
  assert.equal(callbacks.size, 1, "Only one paint callback can wait")
  await paint()
  fast.close()
  for (const image of requests)
    for (const url of image.urls)
      await assert.rejects(
        fetch(url),
        /fetch failed/,
        "All image URLs are revoked after completion or disposal"
      )
  const codecs: FakeDecoder[] = []
  class FakeVideoFrame {
    displayWidth = 1920
    displayHeight = 1080
    closed = false
    close() { this.closed = true }
  }
  class FakeDecoder {
    static supportChecks = 0
    static async isTypeSupported(type: string) {
      assert.equal(type, "image/jpeg")
      this.supportChecks++
      return true
    }
    closed = false
    image = new FakeVideoFrame()
    ready = () => {}
    fail = () => {}
    constructor(readonly init: { data?: unknown; type?: string; desiredWidth?: number; desiredHeight?: number } = {}) {
      codecs.push(this)
      if (init.desiredWidth && init.desiredHeight) {
        this.image.displayWidth = init.desiredWidth
        this.image.displayHeight = init.desiredHeight
      }
    }
    decode() {
      return new Promise<{ image: FakeVideoFrame }>((resolve, reject) => {
        this.ready = () => resolve({ image: this.image })
        this.fail = () => reject(new Error("Invalid JPEG"))
      })
    }
    close() { this.closed = true }
  }
  Object.defineProperty(globalThis, "ImageDecoder", { configurable: true, value: FakeDecoder })
  const videoPaints: FakeVideoFrame[] = []
  const videoCanvas = { width: 0, height: 0, getContext: () => ({ drawImage: (value: CanvasImageSource) => {
    assert.ok(value instanceof FakeVideoFrame)
    assert.equal(value.closed, false, "Draw before closing the frame")
    videoPaints.push(value)
  } }) }
  const first = createControlPreviewPainter(videoCanvas), second = createControlPreviewPainter(videoCanvas)
  const same = frame(300)
  first.update(same); second.update(same)
  await flush()
  assert.equal(codecs.length, 1, "One JPEG decoder shared by both viewers")
  first.close()
  assert.equal(codecs[0]!.closed, false, "One viewer cannot cancel another's decode")
  codecs[0]!.ready()
  await flush()
  assert.equal(codecs[0]!.closed, true, "Decoder closes while its output waits to paint")
  assert.equal(codecs[0]!.image.closed, false)
  await paint()
  assert.equal(videoPaints.length, 1)
  assert.equal(codecs[0]!.image.closed, true, "Last paint closes the VideoFrame")
  assert.equal(videoCanvas.width, 1920)
  assert.equal(videoCanvas.height, 1080)
  second.update(frame(301))
  await flush()
  codecs[1]!.fail()
  await flush()
  assert.equal(codecs[1]!.closed, true, "Failed decoding closes its decoder")
  second.update(frame(302))
  await flush()
  second.close()
  assert.equal(codecs[2]!.closed, true, "Disposal cancels active decoding")
  codecs[2]!.ready()
  await flush()
  await paint()
  assert.equal(codecs[2]!.image.closed, true, "Late output is closed without drawing")
  assert.equal(videoPaints.length, 1)
  assert.equal(FakeDecoder.supportChecks, 1, "Codec capability is queried once")
  const beforeStart = createControlPreviewPainter(videoCanvas)
  beforeStart.update(frame(303)); beforeStart.close()
  await flush()
  assert.equal(codecs.length, 3, "Disposal before capability resolution allocates no decoder")

  // Displayed-size decoding. Real headers: an APP0 segment before SOF0.
  const jpeg = (id: number, width = 1920, height = 1080) => ({
    ...frame(id),
    image: {
      mimeType: "image/jpeg" as const,
      bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x11, 0x08,
        height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, 0xff, 0xd9]),
    },
  })
  assert.deepEqual(controlPreviewSize(jpeg(400)), { width: 1920, height: 1080 }, "JPEG size is read from its header")
  const png = new Uint8Array(24)
  png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0xe8, 0, 0, 3, 0xd6])
  assert.deepEqual(controlPreviewSize({ ...frame(401), image: { mimeType: "image/png", bytes: png } }), { width: 1512, height: 982 })
  assert.equal(controlPreviewSize(frame(402)), null, "Unreadable headers fall back to decoded size")
  assert.deepEqual(
    [[852, 480], [455, 256], [240, 135], [1600, 900], [1920, 1080]].map(([width, height]) =>
      controlPreviewEighths({ width: 1920, height: 1080 }, { width: width!, height: height! })),
    [4, 2, 1, 7, 8],
    "Smallest JPEG eighth that still covers the displayed pixels"
  )
  assert.equal(controlPreviewEighths({ width: 1512, height: 982 }, { width: 756, height: 491 }), 4)
  assert.deepEqual(fitControlPreview({ width: 1920, height: 1080 }, { width: 1280, height: 512 }), { width: 910, height: 512 })
  assert.deepEqual(fitControlPreview({ width: 800, height: 600 }, { width: 1600, height: 1200 }), { width: 800, height: 600 },
    "Small sources are never enlarged")

  const sized = () => {
    const draws: { image: CanvasImageSource; width?: number; height?: number; quality: ImageSmoothingQuality }[] = []
    const context = {
      imageSmoothingQuality: "low" as ImageSmoothingQuality,
      drawImage: (image: CanvasImageSource, _x: number, _y: number, width?: number, height?: number) => {
        draws.push({ image, width, height, quality: context.imageSmoothingQuality })
      },
    }
    return { width: 300, height: 150, style: { aspectRatio: "" }, draws, getContext: () => context }
  }
  const settle = async (codec: FakeDecoder) => { codec.ready(); await flush(); await paint() }
  const panel = sized(), overlay = createControlPreviewPainter(panel)
  overlay.resize(852, 480)
  overlay.update(jpeg(500))
  assert.equal(panel.style.aspectRatio, "1920 / 1080", "Layout takes the source shape before the first paint")
  await flush()
  assert.deepEqual(codecs.at(-1)!.init, { data: codecs.at(-1)!.init.data, type: "image/jpeg", desiredWidth: 960, desiredHeight: 540 },
    "A 852×480 viewer decodes the 1920×1080 source at 4/8")
  await settle(codecs.at(-1)!)
  assert.deepEqual([panel.width, panel.height], [852, 479], "The canvas holds exactly the displayed device pixels")
  assert.deepEqual([panel.draws.at(-1)!.width, panel.draws.at(-1)!.height, panel.draws.at(-1)!.quality], [852, 479, "low"],
    "A scaled decode within 2× of the canvas draws bilinearly")
  let before = codecs.length
  overlay.resize(852, 480)
  await flush()
  assert.equal(codecs.length, before, "An unchanged box does no work")
  overlay.resize(1600, 900)
  await flush()
  assert.equal(codecs.length, before + 1, "Enlarging repaints the held frame without waiting for a new one")
  assert.equal(codecs.at(-1)!.init.desiredWidth, 1680)
  await settle(codecs.at(-1)!)
  assert.deepEqual([panel.width, panel.height], [1600, 900])
  overlay.resize(0, 0)
  before = codecs.length
  overlay.update(jpeg(501))
  await flush()
  assert.equal(codecs.length, before, "A zero-sized viewer decodes nothing")
  overlay.resize(852, 480)
  await flush()
  assert.equal(codecs.length, before + 1, "Showing it again decodes the newest frame")
  await settle(codecs.at(-1)!)
  assert.equal(panel.draws.at(-1)!.image, codecs.at(-1)!.image)

  const large = sized(), inspector = createControlPreviewPainter(large)
  inspector.resize(1600, 900)
  before = codecs.length
  const common = jpeg(502)
  overlay.update(common)
  inspector.update(common)
  await flush()
  assert.equal(codecs.length, before + 1, "Viewers of different sizes share one decode at the larger scale")
  assert.equal(codecs.at(-1)!.init.desiredWidth, 1680)
  await settle(codecs.at(-1)!)
  assert.deepEqual([panel.width, panel.height, large.width, large.height], [852, 479, 1600, 900])
  inspector.close()

  const unmeasured = createControlPreviewPainter(sized())
  before = codecs.length
  overlay.update(jpeg(503))
  await flush()
  assert.equal(codecs.at(-1)!.init.desiredWidth, undefined, "A viewer not yet laid out keeps full pixels for everyone")
  await settle(codecs.at(-1)!)
  unmeasured.close()

  overlay.update(jpeg(504))
  await flush()
  codecs.at(-1)!.ready()
  await flush()
  overlay.update(jpeg(505))
  await flush()
  const newest = codecs.at(-1)!, from = codecs.length - 1
  overlay.resize(700, 394)
  newest.ready()
  await flush()
  await paint()
  for (let i = 0; i < 3; i++) { await flush(); codecs.at(-1)!.ready(); await flush(); await paint() }
  assert.ok(codecs.slice(from).every((codec) => codec.init.data === newest.init.data) &&
    codecs.some((codec) => codec.image === panel.draws.at(-1)!.image && codec.init.data === newest.init.data),
    "A resize during decoding never repaints an older frame")
  assert.deepEqual([panel.width, panel.height], [700, 394])
  overlay.close()

  const thumbnail = sized(), fallback = createControlPreviewPainter(thumbnail)
  fallback.resize(480, 270)
  const ihdr = new Uint8Array(24)
  ihdr.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 7, 0x80, 0, 0, 4, 0x38])
  before = requests.length
  fallback.update({ ...frame(600), image: { mimeType: "image/png", bytes: ihdr } })
  await flush()
  assert.equal(requests.length, before + 1, "Formats without scaled decoding use the full-size image")
  requests.at(-1)!.ready()
  await flush()
  await paint()
  assert.deepEqual([thumbnail.width, thumbnail.height, thumbnail.draws.at(-1)!.quality], [480, 270, "high"],
    "A full-size fallback shrinking past 2× is filtered rather than aliased")
  fallback.close()

  // Shown rate: painted frames against the host's source sequence.
  const meter = () => {
    const reports: (ControlPreviewRate | null)[] = []
    return { reports, rate: createControlPreviewRate((value) => reports.push(value)) }
  }
  const at = (sequence: number, capturedAt: number) => ({ ...frame(sequence), sequence, capturedAt })
  const play = (rate: ReturnType<typeof createControlPreviewRate>, from: number, to: number, fps: number, keep: (n: number) => boolean, start = 0) => {
    for (let n = from; n <= to; n++) if (keep(n)) rate.painted(at(n, start + ((n - from) * 1000) / fps))
  }
  let run = meter()
  play(run.rate, 1, 240, 60, () => true)
  assert.deepEqual(run.reports, [], "A viewer painting every frame reports nothing")
  run = meter()
  play(run.rate, 1, 240, 60, (n) => n % 3 !== 0)
  assert.deepEqual(run.reports, [{ shown: 40, full: 60 }], "Painting two of every three frames reports 40 of 60 fps")
  play(run.rate, 241, 480, 60, () => true, 4000)
  assert.deepEqual(run.reports.at(-1), null, "Recovering to the full rate clears the report")
  run = meter()
  play(run.rate, 1, 240, 60, (n) => n % 12 !== 0)
  assert.deepEqual(run.reports, [], "A 92% rate stays below the 90% threshold for showing")
  run = meter()
  play(run.rate, 1, 120, 60, (n) => n % 2 !== 0)
  play(run.rate, 121, 360, 60, (n) => n % 12 !== 0, 2000)
  assert.deepEqual(run.reports.at(-1), { shown: 55, full: 60 }, "Once shown, a 92% rate stays shown until it passes 95%")
  run = meter()
  play(run.rate, 1, 480, 120, (n) => n % 2 === 0)
  assert.deepEqual(run.reports, [], "The host's 60 fps pace caps the full rate")
  run = meter()
  for (let n = 1; n <= 10; n++) run.rate.painted(at(n, n * 1500))
  assert.deepEqual(run.reports, [], "An idle source that sends a frame per change reports nothing")
  run = meter()
  play(run.rate, 1, 60, 60, () => true)
  play(run.rate, 141, 200, 60, () => true, 140_000 / 60)
  assert.ok(run.reports.at(-1) && run.reports.at(-1)!.shown < 40 && run.reports.at(-1)!.full === 60,
    `A 1.35 s viewer stall while the source runs is reported, not treated as idle: ${JSON.stringify(run.reports)}`)
  run = meter()
  play(run.rate, 1, 120, 60, (n) => n % 2 !== 0)
  assert.deepEqual(run.reports, [{ shown: 30, full: 60 }])
  run.rate.painted(at(1, 2100))
  assert.deepEqual(run.reports.at(-1), null, "A restarted stream starts a fresh window")
  run = meter()
  for (let n = 1; n <= 120; n += 2) for (let repeat = 0; repeat < 3; repeat++) run.rate.painted(at(n, (n * 1000) / 60))
  assert.deepEqual(run.reports, [{ shown: 30, full: 60 }], "Repainting a held frame is not a new frame")
  const paired = meter()
  for (let n = 1; n <= 120; n += 2)
    for (const half of [0, 1]) paired.rate.painted({ ...frame(1000 + n * 2 + half), sequence: n, capturedAt: ((n + half) * 1000) / 60 })
  assert.deepEqual(paired.reports, [], "Distinct frames that share a source slot all count as painted")
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(run.reports, [{ shown: 30, full: 60 }], "The label holds between frames")
  await new Promise((resolve) => setTimeout(resolve, 600))
  assert.deepEqual(run.reports.at(-1), null, "A second without a new frame clears the label: a still page drops nothing")

  const rated: (ControlPreviewRate | null)[] = []
  const busy = sized(), loaded = createControlPreviewPainter(busy, (value) => rated.push(value))
  loaded.resize(852, 480)
  for (let n = 1; n <= 90; n += 2) {
    loaded.update({ ...jpeg(700 + n), sequence: n, capturedAt: (n * 1000) / 60 })
    await flush()
    await settle(codecs.at(-1)!)
  }
  assert.deepEqual(rated, [{ shown: 30, full: 60 }], "The painter reports the rate it actually painted")
  loaded.resize(0, 0)
  assert.deepEqual(rated.at(-1), null, "A hidden viewer drops its rate")
  loaded.close()
  console.log(
    "Preview painter: bounded decoding/latest-frame queue, retained pixels, displayed-size decoding and repaint, shared scaled decode, corruption/size refusal, late completion cleanup and shown-rate reporting passed"
  )
} finally {
  painter.close()
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value)
    else Reflect.deleteProperty(globalThis, key)
  }
}
