import assert from "node:assert/strict"
import { BrowserFocus } from "../packages/control-runtime/src/browser-focus.js"
import {
  BrowserCapture,
  type CaptureConnection,
} from "../packages/control-runtime/src/browser-capture.js"

function fixture() {
  const calls: { method: string; enabled?: unknown; session?: string }[] = []
  const events = new Set<Parameters<CaptureConnection["onEvent"]>[0]>()
  let failEnable = false,
    failDisable = false,
    failStart = false,
    hold: Promise<void> | undefined
  const connection: CaptureConnection = {
    async send(method, params, _signal, session) {
      calls.push({ method, enabled: params.enabled, session })
      if (method === "Emulation.setFocusEmulationEnabled") {
        if (params.enabled) {
          await hold
          if (failEnable) throw new Error("Enable response lost")
        } else if (failDisable) throw new Error("Reset response lost")
      }
      if (method === "Page.startScreencast" && failStart)
        throw new Error("Start response lost")
      return {}
    },
    onEvent(listener) {
      events.add(listener)
      return () => {
        events.delete(listener)
      }
    },
    onClose() {
      return () => {}
    },
  }
  return {
    connection,
    calls,
    events,
    failStart: () => {
      failStart = true
    },
    failEnable: () => {
      failEnable = true
    },
    failDisable: () => {
      failDisable = true
    },
    hold: (value: Promise<void>) => {
      hold = value
    },
    toggles: () =>
      calls
        .filter((c) => c.method === "Emulation.setFocusEmulationEnabled")
        .map((c) => c.enabled),
  }
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "one")
  const capture = new BrowserCapture(f.connection, "one", focus)
  const preview = await capture.subscribe({ frame() {}, ended() {} })
  const recording = await capture.subscribe({ frame() {}, ended() {} })
  const input = await focus.acquire()
  await input()
  assert.deepEqual(
    f.toggles(),
    [true],
    "Input cannot turn off focus held by live capture"
  )
  await capture.screenshot(async () => "pixels")
  assert.deepEqual(
    f.toggles(),
    [true],
    "A temporary screenshot pause retains the capture's focus"
  )
  await preview()
  assert.deepEqual(f.toggles(), [true], "Recording survives preview closure")
  await recording()
  await recording()
  assert.deepEqual(f.toggles(), [true, false], "Last consumer restores once")
  assert.ok(
    f.calls
      .filter((c) => c.method === "Emulation.setFocusEmulationEnabled")
      .every((c) => c.session === "one")
  )
  await focus.close()
  capture.end("finished")
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "two")
  const action = await focus.acquire()
  const capture = new BrowserCapture(f.connection, "two", focus)
  const preview = await capture.subscribe({ frame() {}, ended() {} })
  await preview()
  assert.deepEqual(
    f.toggles(),
    [true],
    "Closing capture cannot interrupt an input action"
  )
  await action()
  assert.deepEqual(f.toggles(), [true, false])
  capture.end("finished")
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "three")
  f.failEnable()
  await assert.rejects(focus.acquire(), /Enable response lost/)
  assert.deepEqual(
    f.toggles(),
    [true, false],
    "Unconfirmed enable is reset without input replay"
  )
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "four")
  const release = await focus.acquire()
  f.failDisable()
  await assert.rejects(release(), /Reset response lost/)
  assert.equal(
    f.calls.filter((c) => c.method === "Target.detachFromTarget").length,
    1
  )
  await assert.rejects(
    focus.acquire(),
    /attachment ended/,
    "An uncertain reset cannot retain a usable attachment"
  )
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "five")
  let unblock!: () => void
  f.hold(
    new Promise((resolve) => {
      unblock = resolve
    })
  )
  const acquiring = focus.acquire()
  await new Promise((resolve) => setImmediate(resolve))
  const closing = focus.close()
  const rejected = assert.rejects(acquiring, /attachment ended/)
  unblock()
  await Promise.all([closing, rejected])
  assert.deepEqual(
    f.toggles(),
    [true, false],
    "Closing during acquisition never leaves focus enabled"
  )
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "six")
  const capture = new BrowserCapture(f.connection, "six", focus)
  let ended = 0
  await capture.subscribe({
    frame() {},
    ended() {
      ended++
    },
  })
  capture.end("detached")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(ended, 1)
  assert.deepEqual(
    f.toggles(),
    [true, false],
    "Interrupted capture releases its focus hold"
  )
  await assert.rejects(capture.subscribe({ frame() {}, ended() {} }), /ended/)
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "startup")
  f.failStart()
  const capture = new BrowserCapture(f.connection, "startup", focus)
  await assert.rejects(
    capture.subscribe({ frame() {}, ended() {} }),
    /Start response lost/
  )
  assert.deepEqual(
    f.toggles(),
    [true, false],
    "Failed startup releases emulated focus"
  )
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "screenshot")
  const capture = new BrowserCapture(f.connection, "screenshot", focus)
  const release = await capture.subscribe({ frame() {}, ended() {} })
  let released!: Promise<void>
  await capture.screenshot(async () => {
    released = release()
  })
  await released
  assert.deepEqual(
    f.toggles(),
    [true, false],
    "Last consumer leaving during a screenshot restores focus"
  )
  capture.end("finished")
}
{
  const f = fixture(),
    capture = new BrowserCapture(f.connection, "off")
  const release = await capture.subscribe({ frame() {}, ended() {} })
  await release()
  assert.deepEqual(f.toggles(), [], "Off policy never changes page focus")
  capture.end("finished")
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "capture-dialog")
  const capture = new BrowserCapture(f.connection, "capture-dialog", focus)
  const preview = await capture.subscribe({ frame() {}, ended() {} })
  const action = await focus.acquire()
  await focus.setDialogOpen(true)
  await action()
  await focus.setDialogOpen(false)
  assert.deepEqual(f.toggles(), [true], "Closing a dialog cannot reset focus still owned by capture")
  await preview()
  assert.deepEqual(f.toggles(), [true, false], "The last capture consumer resets focus after the dialog closes")
  capture.end("finished")
  await focus.close()
}
{
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "dialog-outlives-capture")
  const capture = new BrowserCapture(f.connection, "dialog-outlives-capture", focus)
  const preview = await capture.subscribe({ frame() {}, ended() {} })
  await focus.setDialogOpen(true)
  await preview()
  assert.deepEqual(f.toggles(), [true], "A pending dialog defers reset even after the last capture consumer leaves")
  await focus.setDialogOpen(false)
  await focus.setDialogOpen(false)
  assert.deepEqual(f.toggles(), [true, false], "Duplicate closure notifications reset the abandoned hold only once")
  capture.end("finished")
  await focus.close()
}
for (const resetFails of [false, true]) {
  const f = fixture(),
    focus = new BrowserFocus(f.connection, "close-with-dialog")
  const release = await focus.acquire()
  await focus.setDialogOpen(true)
  await release()
  assert.deepEqual(f.toggles(), [true])
  if (resetFails) f.failDisable()
  const closing = focus.close()
  if (resetFails) await assert.rejects(closing, /Reset response lost/)
  else await closing
  assert.deepEqual(f.toggles(), [true, false], "Session closure must reset focus even while a dialog is pending")
  assert.equal(f.calls.filter((call) => call.method === "Target.detachFromTarget").length, resetFails ? 1 : 0,
    "A failed teardown reset detaches the exact session")
  await focus.setDialogOpen(false)
  await assert.rejects(focus.acquire(), /attachment ended/)
}
console.log(
  "Browser focus: capture/input/dialog ownership, modal teardown, screenshot continuity, idempotent release, uncertain reset detachment and interrupted acquisition passed"
)
