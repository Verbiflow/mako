import assert from "node:assert/strict"
import { build } from "esbuild"
async function module(path) {
  const result = await build({
    entryPoints: [path],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`
  )
}
const { ExtensionCursor } = await module("browser-extension/cursor.ts")
const { ExtensionTasks } = await module("browser-extension/tasks.ts")
const calls = []
let records = {}
let localRecords = {}
let tab = {
  id: 1,
  windowId: 1,
  groupId: -1,
  active: false,
  mutedInfo: { muted: false },
}
const api = {
  runtime: { id: "mako" },
  debugger: {
    getTargets: async () => [{ id: "target", tabId: 1 }],
    detach: async (t) => calls.push(["detach", t]),
    sendCommand: async (target, method, params) => {
      calls.push([method, params])
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "frame" } } }
      if (method === "Page.createIsolatedWorld")
        return { executionContextId: 8 }
      return {}
    },
  },
  tabs: {
    query: async (options) =>
      options.groupId !== undefined ? [tab] : tab.active ? [tab] : [],
    get: async () => structuredClone(tab),
    update: async (id, options) => {
      calls.push(["update", options])
      if ("muted" in options)
        tab.mutedInfo = { muted: options.muted, extensionId: "mako" }
      return tab
    },
    group: async (options) => {
      calls.push(["group", options])
      tab.groupId = 3
      return 3
    },
  },
  windows: {
    get: async () => ({ focused: true }),
    getAll: async () => [{ id: 1, state: "normal", focused: true }],
  },
  tabGroups: {
    get: async (id) => ({ id, windowId: 1, title: "Invoice" }),
    update: async (id, options) => {
      calls.push(["group-title", options])
      return { id, ...options }
    },
  },
  storage: {
    local: {
      get: async () => localRecords,
      set: async value => { Object.assign(localRecords, structuredClone(value)) },
      remove: async key => { delete localRecords[key] },
    },
    session: {
      get: async () => records,
      set: async (value) => {
        Object.assign(records, structuredClone(value))
      },
      remove: async key => {
        delete records[key]
      },
    },
  },
}
const tasks = new ExtensionTasks(api)
await tasks.recover()
await tasks.track({
  targetId: "target",
  tabId: 1,
  owner: "one",
  name: "Invoice",
  lifetime: "task",
})
await tasks.presented()
assert.equal(tab.mutedInfo.muted, true)
assert.equal(
  calls.find((c) => c[0] === "group")[1].createProperties.windowId,
  1,
  "Grouping cannot move the tab to a different window"
)
assert.equal(calls.find((c) => c[0] === "group-title")[1].title, "Invoice")
tab.active = true
await tasks.activated(1)
tab.active = false
assert.equal(tab.mutedInfo.muted, false)
// User mute wins; cleanup cannot undo it.
tab.mutedInfo = { muted: true, reason: "user" }
await tasks.release(1)
assert.equal(tab.mutedInfo.muted, true)
// Retention is durable before presentation and never leaves a saved tab muted.
tab.mutedInfo = { muted: false }
await tasks.track({
  targetId: "target",
  tabId: 1,
  owner: "one",
  name: "Invoice",
  lifetime: "task",
})
await tasks.retained(1, "Invoice PDF")
await tasks.presented()
assert.equal(tab.mutedInfo.muted, false)
assert.equal(localRecords.makoTaskJournal.tabs[0].lifetime, "persistent")
assert.equal(
  calls.filter((c) => c[0] === "group-title").at(-1)[1].title,
  "Invoice PDF · Saved"
)
// Worker recovery detaches exact old sessions, preserves pages and clears ownership.
const recovered = new ExtensionTasks(api)
assert.equal(await recovered.recover(), 1)
assert.equal(recovered.size, 0)
assert.ok(records.makoTaskEpoch)
assert.equal(localRecords.lastRecovery.reconciled, 1)
assert.ok(calls.some((c) => c[0] === "detach"))

// Reload clears session storage, while durable ownership must remain diagnostic.
await recovered.track({targetId:"target",tabId:1,owner:"reload-task",name:"Task",lifetime:"task"})
await recovered.presented()
records = {}
calls.length = 0
const reload = new ExtensionTasks(api)
assert.equal(await reload.recover(), 1)
assert.equal(calls.length, 0, "No detach/unmute after session identity is lost")
assert.equal(localRecords.lastRecovery.needsInspection, 1)
assert.equal(localRecords.lastRecovery.outcome, "unknown")
assert.equal(localRecords.lastRecovery.targets[0].owner, "reload-task")
assert.equal(reload.size, 0, "Old ownership never resumes")

const cursor = new ExtensionCursor(api)
await cursor.refresh()
calls.length = 0
const start = performance.now()
for (let i = 0; i < 10000; i++)
  cursor.action("target", 1, "Input.dispatchMouseEvent", { x: i, y: i })
assert.equal(calls.length, 0, "Hidden jobs issue zero feedback commands")
const hiddenMs = performance.now() - start
tab.active = true
await cursor.refresh()
for (let i = 0; i < 10000; i++)
  cursor.action("target", 1, "Input.dispatchMouseEvent", { x: i, y: i })
await new Promise((resolve) => setImmediate(resolve))
await cursor.clear("target")
assert.ok(
  calls.length <= 8,
  `Feedback must coalesce, got ${calls.length} commands`
)
assert.equal(calls.at(-1)[1].expression, "window.makoCursor?.({clear:true})")
const visibleCalls = calls.length
calls.length = 0
cursor.action("target", 1, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20 })
await new Promise((resolve) => setImmediate(resolve))
cursor.action("target", 1, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20 })
await new Promise((resolve) => setImmediate(resolve))
const pointerFeedback = calls
  .filter(([method, params]) => method === "Runtime.evaluate" && params.expression.startsWith("window.makoCursor?.("))
  .map(([, params]) => JSON.parse(params.expression.slice("window.makoCursor?.(".length, -1)))
assert.deepEqual(pointerFeedback.map((action) => action.pressed), [true, false], "Release clears pressed cursor feedback")
calls.length = 0
tab.active = false
await cursor.refresh()
calls.length = 0
cursor.action("target", 1, "Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20 })
cursor.action("target", 1, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 10, y: 20 })
cursor.action("target", 1, "Input.insertText", { text: "secret" })
assert.equal(calls.length, 0, "Hidden pointer press/release and typing issue no feedback commands")
await cursor.clear("target")
assert.ok(
  calls.every((c) => !JSON.stringify(c).includes("secret")),
  "Cursor never receives typed text"
)
console.log(
  JSON.stringify({
    passed:
      "task groups, owned mute, retained results, exact worker recovery, screenshot cleanup, hidden feedback and visible coalescing",
    hiddenActions: 10000,
    hiddenFeedbackCommands: 0,
    hiddenMs,
    visibleBurstCommands: visibleCalls,
  })
)

// A paused renderer cannot hold up lease cleanup or paint after a screenshot clear.
let resume
const paused = new ExtensionCursor({
  ...api,
  debugger: {
    ...api.debugger,
    sendCommand: async () =>
      new Promise((resolve) => {
        resume = resolve
      }),
  },
})
tab.active = true
await paused.refresh()
paused.action("paused", 1, "Input.insertText", { text: "private" })
await paused.clear("paused")
assert.ok(resume, "Visual work was in flight")
resume({ frameTree: { frame: { id: "paused-frame" } } })
paused.forget("paused")
console.log("Pending cursor feedback does not block clear or lease cleanup")
