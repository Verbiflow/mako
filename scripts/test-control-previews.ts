import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { mock } from "node:test"
import { BrowserService } from "../packages/control-runtime/src/browser-service.js"
import { ControlPreviews } from "../electron/control-previews.js"
import {
  BrowserCommandSchema,
  BrowserTargetSchema,
} from "../packages/control-runtime/src/contracts/browser-control.js"
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
  const emit = () =>
    fixture.emit(session, "Page.screencastFrame", {
      sessionId: 1,
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOioAAAAASUVORK5CYII=",
      metadata: {
        deviceWidth: 1600,
        deviceHeight: 1000,
        pageScaleFactor: 1,
        offsetTop: 0,
        timestamp: sourceAt / 1000,
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
  previews.read("task", false, "overlay")
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
  console.log(
    "Control previews: hidden capture suppression, one shared stream, task isolation, event coalescing, target invalidation and bounded retention passed"
  )
} finally {
  previews.close()
  browser.close()
  await fixture.close()
}
