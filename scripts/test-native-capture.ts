import assert from "node:assert/strict"
import sharp from "sharp"
import type { JsonObject } from "@mako/host/contracts/json"
import {
  nativeCapture,
  nativeCapturePoint,
} from "../packages/control-runtime/src/native-capture.js"

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
    await import("../packages/control-runtime/src/control-session.js")
  const { z } = await import("zod")
  const calls: { name: string; args: JsonObject }[] = []
  let supersede: ((event: { pid: number; window_id: number; by: string }) => void) | undefined
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
              max_depth: { type: "integer" },
            },
          },
        }))
      },
      async callTool(name, args) {
        calls.push({ name, args })
        // An Appshot reads the tree on its own, beside the picture.
        const tree: JsonObject = {
          snapshot_id: "s00000001",
          elements: [
            { role: "AXWindow", depth: 0, label: "Fixture", frame: { x: 0, y: 0, w: 500.5, h: 350.5 } },
            { role: "AXButton", depth: 1, label: "Save", element_index: 1, element_token: "s00000001:1", enabled: true, frame: { x: 10, y: 10, w: 50, h: 20 } },
          ],
        }
        const picture: JsonObject = {
          screenshot_scale: 2,
          app_name: "Fixture App",
          window_title: "Fixture",
          window_bounds: { x: 0, y: 0, width: 500.5, height: 350.5 },
          screenshot_width: 1001,
          screenshot_height: 701,
        }
        if (name === "get_window_state" && args.include_screenshot === false)
          return { content: [], structuredContent: tree }
        if (name === "get_window_state")
          return { content: [{ type: "image", ...image }], structuredContent: picture }
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
      onSuperseded(listener) {
        supersede = listener
      },
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
    // An Appshot is the person's capture through the same engine: its
    // outline, and a picture that is the window's latest screenshot.
    const appshot = z
      .object({ kind: z.literal("appshot"), view: z.string(), text: z.string(), elements: z.number(), window: z.object({ app: z.string(), title: z.string() }) })
      .parse(await session.call({ action: "appshot", target }, signal))
    assert.match(appshot.text, /\n\nWindow "Fixture" \[0,0,1001,701\]\n {2}Button "Save" \[20,20,100,40\]$/)
    assert.deepEqual([appshot.window.app, appshot.window.title, appshot.elements], ["Fixture App", "Fixture", 2])
    assert.equal(calls.filter((call) => call.name === "list_windows" && call.args.on_screen_only).length, 0, "a known window costs no window list")
    await session.call({ action: "dispatch", target, operation: { kind: "pointer", at: { x: 40, y: 30, view: appshot.view } } }, signal)
    assert.deepEqual([calls.at(-1)!.name, calls.at(-1)!.args.x, calls.at(-1)!.args.y], ["click", 40, 30], "its picture's pixels are click coordinates")
    await assert.rejects(
      session.call({ action: "appshot", target: { kind: "page", browser: "b", tab: "t", generation: "g", lease: "l" } }, signal),
      { code: "unsupported-operation", outcome: "not-dispatched" }
    )
    // Another consumer's tree read of this window (the broker says whose)
    // retires this session's refs and views there before anything is sent.
    const view = z
      .object({ nodes: z.array(z.object({ ref: z.string().optional(), name: z.string() })) })
      .parse(await session.call({ action: "observe", target }, signal))
    const ref = view.nodes.find((node) => node.name === "Save")?.ref
    assert.ok(ref, "the window's Save button has a ref")
    const shot2 = z.object({ view: z.string() }).parse(await session.call({ action: "capture", target, options: {} }, signal))
    const before = calls.length
    assert.ok(supersede, "the session listens for supersession")
    supersede({ pid: 42, window_id: 7, by: "appshots" })
    supersede({ pid: 42, window_id: 8, by: "agent" })
    await assert.rejects(
      session.call({ action: "dispatch", target, operation: { kind: "activate", ref } }, signal),
      (error: Error & { code?: string; outcome?: string }) =>
        error.code === "stale-reference" && error.outcome === "not-dispatched" && /an Appshot read this window since/.test(error.message)
    )
    await assert.rejects(
      session.call({ action: "dispatch", target, operation: { kind: "pointer", at: { x: 5, y: 5, view: shot2.view } } }, signal),
      { code: "stale-view", outcome: "not-dispatched" }
    )
    assert.equal(calls.length, before, "nothing reached the driver")
    console.log(
      "Native shared engine: resized view maps once to driver pixels; stale view refuses without replay; an Appshot's outline and picture come through the same engine; another consumer's read retires refs and views before dispatch, naming whose read it was"
    )
  } finally {
    await session.close()
  }

  // A driver that keeps each lease's snapshots apart (`snapshots: "lease"`,
  // driver 0003) sends no supersession notice: another consumer's read of the
  // window never reaches this session, and its ref acts on the token it read.
  const leaseCalls: { name: string; args: JsonObject }[] = []
  const perLease = createControlSession(
    { command: "fixture", args: [] },
    "native-capture-per-lease",
    async () => ({
      async listTools() {
        return ["get_window_state", "list_windows", "click"].map((name) => ({
          name,
          inputSchema: { type: "object" as const, properties: { pid: { type: "integer" }, window_id: { type: "integer" } } },
        }))
      },
      async callTool(name, args) {
        leaseCalls.push({ name, args })
        const value: JsonObject =
          name === "get_window_state"
            ? {
                snapshot_id: "s0000002a",
                elements: [
                  { role: "AXWindow", depth: 0, label: "Fixture", frame: { x: 0, y: 0, w: 500, h: 350 } },
                  { role: "AXButton", depth: 1, label: "Save", element_index: 1, element_token: "s0000002a:1", enabled: true, frame: { x: 10, y: 10, w: 50, h: 20 } },
                ],
              }
            : name === "list_windows"
              ? { windows: [{ pid: 42, window_id: 7, title: "Fixture", kind: "document", is_on_screen: true }] }
              : { status: "dispatched" }
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value }
      },
      onClose() {},
      onSuperseded() {},
      describe: () => ({ via: "broker", consumer: "agent per-lease", generation: 1, snapshots: "lease", open: true, calls: leaseCalls.length }),
      async close() {},
    })
  )
  try {
    const view = z
      .object({ nodes: z.array(z.object({ ref: z.string().optional(), name: z.string() })) })
      .parse(await perLease.call({ action: "observe", target }, signal))
    const ref = view.nodes.find((node) => node.name === "Save")?.ref
    assert.ok(ref, "the per-lease window's Save button has a ref")
    // (Here the person's Appshot and another task read the same window, each on its own lease.)
    await perLease.call({ action: "dispatch", target, operation: { kind: "activate", ref } }, signal)
    const click = leaseCalls.find((call) => call.name === "click")
    assert.equal(click?.args.element_token, "s0000002a:1", "the ref acts with the exact token this session read")
    assert.equal(
      z.object({ driver: z.object({ snapshots: z.string() }) }).parse(perLease.diagnostics()).driver.snapshots,
      "lease",
      "the session's diagnostics say whose snapshots its driver keeps"
    )
    console.log("Native per-lease snapshots: with no supersession notice a ref acts with the token its own read issued, and diagnostics name the snapshot scope")
  } finally {
    await perLease.close()
  }
}
