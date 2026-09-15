import assert from "node:assert/strict"
import { computerHelpers } from "../dist/computer/index.js"

// A driver stand-in: one window whose elements change after a click, a
// window list with Finder-style helpers, and a refused action.
const calls = []
let phase = "home"
const screens = {
  home: [{ element_token: "s0000000a:1", role: "AXButton", label: "Settings" }, { element_token: "s0000000a:2", role: "AXStaticText", label: "Dashboard", value: "Dashboard" }, { element_token: "s0000000a:3", role: "AXMenuItem", label: "About" }],
  settings: [{ element_token: "s0000000b:1", role: "AXButton", label: "Back" }, { element_token: "s0000000b:2", role: "AXLink", label: "General" }, { element_token: "s0000000b:3", role: "AXLink", label: "Git" }],
}
const api = {
  get_window_state: async (args) => { calls.push(["get_window_state", args]); return { elements: screens[phase], window_id: args.window_id } },
  click: async (args) => { calls.push(["click", args]); phase = "settings"; return { route: "accessibility", delivery: { mode: "background" }, effect: "unverifiable", frame: { x: 1 } } },
  list_windows: async (args) => { calls.push(["list_windows", args]); return { windows: [{ window_id: 89, title: "", bounds: { x: 0, y: 0, width: 1352, height: 30 }, is_on_screen: false }, { window_id: 5, title: "Downloads", bounds: { x: 0, y: 0, width: 900, height: 600 }, is_on_screen: true }, { window_id: 7, title: "", bounds: { x: 0, y: 378, width: 500, height: 500 } }] } },
  refuse: async () => { throw new Error("driver refused: window unresolved") },
}
const state = {}
const h = computerHelpers(api, state)

// view needs a target, remembers it, drops the menu bar, caches the lines.
await assert.rejects(() => h.view(), /No window is selected/)
const home = await h.view({ pid: 42, window_id: 7 })
assert.deepEqual(home, ['s0000000a:1 Button "Settings"', 's0000000a:2 StaticText "Dashboard"'])
assert.deepEqual(state.target, { pid: 42, window_id: 7 })
assert.deepEqual(state.last, home)
assert.deepEqual(calls.at(-1)[1], { pid: 42, window_id: 7, include_screenshot: false, max_elements: 400 })
assert.deepEqual(await h.view(undefined, { query: "dash", max: 50 }), ['s0000000a:2 StaticText "Dashboard"'])
assert.equal(calls.at(-1)[1].max_elements, 50)
assert.equal(calls.at(-1)[1].query, "dash")
await h.view()

// act: the action, then only what changed, with the delivery facts kept.
const t0 = Date.now()
const step = await h.act("click", { element_token: "s0000000a:1" }, { settle: 20 })
assert.ok(Date.now() - t0 < 500)
assert.equal(step.action, "click")
assert.deepEqual(step.result, { route: "accessibility", delivery: { mode: "background" }, effect: "unverifiable" })
assert.deepEqual(step.added, ['s0000000b:1 Button "Back"', 's0000000b:2 Link "General"', 's0000000b:3 Link "Git"'])
assert.deepEqual(step.removed, ['Button "Settings"', 'StaticText "Dashboard"'])
assert.equal(step.unchanged, 0)
assert.deepEqual(calls.filter((c) => c[0] === "click")[0][1], { element_token: "s0000000a:1" })
await assert.rejects(() => h.act("nope", {}), /Unknown computer action "nope"/)
await assert.rejects(() => h.act("refuse", {}, { settle: 0 }), /driver refused/)

// until polls to a condition or reports the time it gave up at.
const found = await h.until((lines) => lines.some((l) => /Git/.test(l)), { every: 5 })
assert.equal(found.satisfied, true)
const gaveUp = await h.until((lines) => lines.some((l) => /Nowhere/.test(l)), { timeout: 30, every: 5 })
assert.equal(gaveUp.satisfied, false)
assert.ok(gaveUp.ms >= 30)
assert.equal(gaveUp.view.length, 3)

// expect stops the program with the screen in the message.
await h.expect((lines) => lines.length === 3)
await assert.rejects(() => h.expect((lines) => lines.length === 99, "Expected the home screen"), /Expected the home screen\. The window shows:\ns0000000b:1 Button "Back"/)

// windows: helper strips are gone, kinds are named, other fields kept.
const windows = await h.windows(1374)
assert.deepEqual(windows.map((w) => [w.window_id, w.kind]), [[5, "document"], [7, "unknown"]])
assert.equal(windows[0].is_on_screen, true)
assert.equal(calls.at(-1)[1].pid, 1374)
console.log("steps ok")
