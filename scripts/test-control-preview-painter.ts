import assert from "node:assert/strict"
import { createControlPreviewPainter } from "../src/lib/control-preview-painter.js"

const requests: FakeImage[] = []
class FakeImage {
  src = ""
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
  ["Image", "requestAnimationFrame", "cancelAnimationFrame"].map((key) => [
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
const painted: string[] = []
const canvas = {
  width: 300,
  height: 150,
  getContext: () => ({
    drawImage: (image: CanvasImageSource) => {
      assert.ok(image instanceof FakeImage)
      painted.push(image.src)
    },
  }),
}
const frame = (id: number) => ({
  id: String(id),
  image: { data: String(id), mimeType: "image/jpeg" as const },
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
  assert.equal(
    painted.length,
    1,
    "A completed frame is displayed even under continuous arrivals"
  )
  assert.equal(canvas.width, 1920)
  assert.equal(canvas.height, 1080)
  assert.equal(requests.length, 2)
  assert.ok(
    requests[1]!.src.endsWith(",100"),
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
