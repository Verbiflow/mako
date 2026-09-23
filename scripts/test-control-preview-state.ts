import assert from "node:assert/strict"
import { mock } from "node:test"
import type { ControlPreview } from "../electron/shared.js"

const visibility = Object.assign(new EventTarget(), { hidden: false })
const calls: { id: string; watching: boolean }[] = []
const previews = new Map<string, ControlPreview>()
let requestGate: Promise<void> | undefined
let streamStarts = 0, streamStops = 0
const priorNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator")
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { mediaDevices: { getUserMedia: async () => { streamStarts++; return { getTracks: () => [{ stop: () => { streamStops++ } }] } } } } })
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
const priorDocument = Object.getOwnPropertyDescriptor(globalThis, "document")
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: visibility,
})
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    mako: {
      nativeWindowVideo: true,
      controlPreviewSource: async () => "window:42",
      controlPreview: async (id: string, watching: boolean) => {
        calls.push({ id, watching })
        if (watching) await requestGate
        const preview = previews.get(id)
        return preview
          ? {
              ...preview,
              window:
                Date.now() - preview.activity.updatedAt >= 5_000
                  ? undefined
                  : preview.window,
            }
          : null
      },
    },
  },
})
const { controlPreviewStore, receiveControlActivity, watchControlPreview, controlPreviewStream } =
  await import("../src/state/control-preview.js")
mock.timers.enable({ apis: ["setTimeout", "Date"], now: 10_000 })
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))
const cleanups: (() => void)[] = []
try {
  for (const id of ["one", "two"]) {
    const activity = {
      conversationId: id,
      kind: "computer",
      operation: "observe",
      target: id,
      status: "observed",
      updatedAt: Date.now(),
    } satisfies ControlPreview["activity"]
    previews.set(id, {
      activity,
      window: { pid: 1, windowId: id === "one" ? 1 : 2 },
      frame: null,
    })
    receiveControlActivity(activity)
    cleanups.push(watchControlPreview(id))
  }
  await flush()
  assert.equal(
    controlPreviewStore.get().previews.one?.activity.conversationId,
    "one"
  )
  assert.equal(
    controlPreviewStore.get().previews.two?.activity.conversationId,
    "two"
  )
  const beforeInspector = calls.length
  const closeInspector = watchControlPreview("one")
  await flush()
  assert.equal(
    calls.length,
    beforeInspector,
    "The inspector and overlay share one polling subscription"
  )
  closeInspector()
  assert.ok(controlPreviewStore.get().previews.one)
  for (let tick = 0; tick < 12; tick++) {
    mock.timers.tick(500)
    await flush()
  }
  const idleCalls = calls.length
  assert.equal(controlPreviewStore.get().previews.one?.window, undefined)
  mock.timers.tick(60_000)
  await flush()
  assert.equal(calls.length, idleCalls, "Idle previews make zero polling calls")
  const preview = previews.get("one")!
  preview.activity = { ...preview.activity, updatedAt: Date.now() }
  receiveControlActivity(preview.activity)
  await flush()
  assert.ok(calls.length > idleCalls, "A new action wakes its preview")
  let complete = () => {}
  requestGate = new Promise<void>(resolve => { complete = resolve })
  const pendingCalls = calls.length
  receiveControlActivity({ ...preview.activity })
  await flush()
  receiveControlActivity({ ...preview.activity })
  receiveControlActivity({ ...preview.activity })
  await flush()
  assert.equal(calls.length, pendingCalls + 1, "Concurrent notifications never overlap preview reads")
  complete()
  requestGate = undefined
  await flush()
  assert.equal(calls.length, pendingCalls + 2, "The last notification during a read is delivered without waiting for polling")
  const [streamA, streamB] = await Promise.all([controlPreviewStream("one"), controlPreviewStream("one")])
  assert.equal(streamStarts, 1, "Inspector and overlay share one native stream")
  streamA!.release()
  await flush()
  assert.equal(streamStops, 0)
  streamB!.release()
  streamB!.release()
  await flush()
  assert.equal(streamStops, 1, "Last consumer stops capture exactly once")
  visibility.hidden = true
  visibility.dispatchEvent(new Event("visibilitychange"))
  await flush()
  const hiddenCalls = calls.length
  mock.timers.tick(10_000)
  await flush()
  assert.equal(
    calls.length,
    hiddenCalls,
    "Hidden documents make zero polling calls"
  )
  console.log(
    "Preview state: independent tasks, consumer cleanup, idle shutdown, event wakeup and zero hidden polling passed"
  )
} finally {
  for (const cleanup of cleanups) cleanup()
  mock.timers.reset()
  for (const [key, descriptor] of [
    ["window", priorWindow],
    ["document", priorDocument],
    ["navigator", priorNavigator],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor)
    else Reflect.deleteProperty(globalThis, key)
  }
}
