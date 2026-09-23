import assert from "node:assert/strict"
import sharp from "sharp"
import type { JsonObject } from "../electron/codex-app-json.js"
import {
  nativeCapture,
  nativeCapturePoint,
} from "../electron/native-capture.js"

const bytes = await sharp({
  create: { width: 1001, height: 701, channels: 3, background: "#395060" },
})
  .png()
  .toBuffer()
const image = { data: bytes.toString("base64"), mimeType: "image/png" as const }
const original = await nativeCapture(image, {})
assert.equal(original.data, image.data, "Default capture does not reencode")
assert.equal(original.changed, false)
assert.equal(
  (await nativeCapture(image, { maxSide: 2048 })).data,
  image.data,
  "Never enlarge"
)
const scaled = await nativeCapture(image, { maxSide: 320 })
assert.equal(scaled.geometry.imageWidth, 320)
assert.equal(scaled.geometry.imageHeight, 224)
assert.deepEqual(nativeCapturePoint(scaled.geometry, { x: 160, y: 112 }), {
  x: 500.5,
  y: 350.5,
})
for (const point of [
  { x: -1, y: 0 },
  { x: 320, y: 0 },
  { x: 0, y: 224 },
  { x: NaN, y: 0 },
])
  assert.throws(() => nativeCapturePoint(scaled.geometry, point), {
    code: "invalid-coordinates",
    outcome: "not-dispatched",
  })
const jpeg = await nativeCapture(image, {
  format: "jpeg",
  quality: 90,
  maxSide: 320,
})
assert.equal(jpeg.mimeType, "image/jpeg")
assert.equal(Buffer.from(jpeg.data, "base64").readUInt16BE(0), 0xffd8)
assert.deepEqual(jpeg.geometry, scaled.geometry)
console.log(
  "Native capture: original bytes, no enlargement, explicit JPEG/resize, rounded geometry and coordinate bounds passed"
)

// The real shared engine must map coordinates before retiring the view; helper
// math alone cannot detect a lost/double-applied transform at that boundary.
if (process.platform === "darwin") {
  const { createControlSession } =
    await import("../electron/control-session.js")
  const { z } = await import("zod")
  const calls: { name: string; args: JsonObject }[] = []
  const session = createControlSession(
    { command: "fixture", args: [] },
    "native-capture-proof",
    async () => ({
      async listTools() {
        return ["get_window_state", "list_windows", "click"].map((name) => ({
          name,
          inputSchema: {
            type: "object" as const,
            properties: {
              pid: { type: "integer" },
              window_id: { type: "integer" },
            },
          },
        }))
      },
      async callTool(name, args) {
        calls.push({ name, args })
        if (name === "get_window_state")
          return {
            content: [{ type: "image", ...image }],
            structuredContent: { screenshot_scale: 2 },
          }
        const value: JsonObject =
          name === "list_windows"
            ? {
                windows: [
                  {
                    pid: 42,
                    window_id: 7,
                    title: "Fixture",
                    kind: "document",
                    is_on_screen: true,
                  },
                ],
              }
            : { forwarded: args }
        return {
          content: [{ type: "text", text: JSON.stringify(value) }],
          structuredContent: value,
        }
      },
      onClose() {},
      async close() {},
    })
  )
  const target = { kind: "window", pid: 42, window_id: 7 }
  const signal = new AbortController().signal
  try {
    const shot = z
      .object({ view: z.string(), screenshot_scale: z.number() })
      .parse(
        await session.call(
          { action: "capture", target, options: { maxSide: 320 } },
          signal
        )
      )
    assert.equal(shot.screenshot_scale, (2 * 320) / 1001)
    const capturesBefore = calls.filter(
      (call) => call.name === "get_window_state"
    ).length
    await assert.rejects(
      session.call(
        { action: "capture", target, options: { scale: 2 } },
        signal
      ),
      { code: "invalid-request", outcome: "not-dispatched" }
    )
    assert.equal(
      calls.filter((call) => call.name === "get_window_state").length,
      capturesBefore
    )
    assert.equal(
      calls.find((call) => call.name === "get_window_state")!.args.maxSide,
      undefined,
      "Host options do not leak to a driver that ignores them"
    )
    const operation = {
      kind: "pointer",
      at: { x: 160, y: 112, view: shot.view },
    }
    await session.call({ action: "dispatch", target, operation }, signal)
    const forwarded = calls.find((call) => call.name === "click")!.args
    assert.equal(forwarded.x, 500.5)
    assert.equal(forwarded.y, 350.5)
    await assert.rejects(
      session.call({ action: "dispatch", target, operation }, signal),
      { code: "stale-view", outcome: "not-dispatched" }
    )
    assert.equal(calls.filter((call) => call.name === "click").length, 1)
    console.log(
      "Native shared engine: resized view maps once to driver pixels; stale view refuses without replay"
    )
  } finally {
    await session.close()
  }
}
