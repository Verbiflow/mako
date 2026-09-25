import assert from "node:assert/strict"
import { createControlPreviewPainter } from "../src/lib/control-preview-painter.js"

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
    constructor() { codecs.push(this) }
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
  console.log(
    "Preview painter: bounded decoding/latest-frame queue, retained pixels, exact dimensions, corruption/size refusal and late completion cleanup passed"
  )
} finally {
  painter.close()
  for (const [key, value] of originals) {
    if (value) Object.defineProperty(globalThis, key, value)
    else Reflect.deleteProperty(globalThis, key)
  }
}
