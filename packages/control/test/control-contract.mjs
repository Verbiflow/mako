import assert from "node:assert/strict"
import {
  actionReceipt,
  selectRoute,
  windowCapabilities,
} from "../dist/computer/index.js"

const target = { pid: 42, window_id: 7 }
const page = windowCapabilities({
  platform: "darwin",
  target,
  documentWindows: 1,
  onScreen: true,
  pageBrowser: "app:dev.mako.fixture:42:abcd1234",
})
assert.equal(selectRoute("page", page).capability.route, "page")
assert.equal(selectRoute("text", page).capability.route, "accessibility")
assert.equal(
  page.routes.find((route) => route.route === "page").verification,
  "event"
)

const ambiguous = windowCapabilities({
  platform: "darwin",
  target,
  documentWindows: 2,
  onScreen: true,
})
const keyboard = ambiguous.routes.find(
  (route) => route.route === "pid-keyboard"
)
assert.equal(keyboard.status, "unavailable")
assert.match(keyboard.reason, /2 document windows/)
assert.equal(selectRoute("page", ambiguous).capability.route, "accessibility")

const hidden = windowCapabilities({
  platform: "darwin",
  target,
  documentWindows: 1,
  onScreen: false,
})
assert.equal(
  hidden.routes.find((route) => route.route === "window-pointer").status,
  "unavailable"
)
assert.equal(
  hidden.routes.find((route) => route.route === "foreground").status,
  "foreground-required"
)

assert.deepEqual(
  actionReceipt(
    "set_value",
    { element_token: "s00000001:4", value: "done" },
    target,
    {
      route: "accessibility",
      effect: "confirmed",
      delivery: { mode: "background" },
      verified: true,
    }
  ),
  {
    action: "set_value",
    target,
    route: "accessibility",
    delivery: "background",
    outcome: "confirmed",
  }
)
assert.deepEqual(
  actionReceipt(
    "click",
    { x: 10, y: 20, delivery_mode: "foreground" },
    target,
    {
      route: "private-driver-route",
      effect: "unverifiable",
      actual_delivery: "foreground",
      fronted: { pid: 42, ms: 18 },
    }
  ),
  {
    action: "click",
    target,
    route: "foreground",
    backend_route: "private-driver-route",
    delivery: "foreground",
    outcome: "unverifiable",
    fronted: { pid: 42, ms: 18 },
  }
)
assert.deepEqual(
  actionReceipt(
    "hotkey",
    { keys: ["shift", "left"] },
    target,
    { route: "synthetic_events", effect: "suspected_noop" }
  ),
  {
    action: "hotkey",
    target,
    route: "pid-keyboard",
    backend_route: "synthetic_events",
    delivery: "background",
    outcome: "suspected-noop",
  }
)

console.log("control contract ok")

for (const platform of ["linux", "win32", undefined]) {
  const capabilities = windowCapabilities({ target: { pid: 7, window_id: 70 }, platform, documentWindows: 1, onScreen: true })
  for (const route of ["window-pointer", "pid-keyboard", "menu"])
    assert.equal(capabilities.routes.find((entry) => entry.route === route).status, "unavailable")
}

// Native traversal limits cannot silently become browser options or invalid depths.
const { ControlObserveRequestSchema } = await import("../dist/control/index.js")
const nativeRead = { target: { kind: "window", pid: 42, window_id: 7 } }
for (const maxDepth of [1, 5, 25]) assert.equal(ControlObserveRequestSchema.parse({ ...nativeRead, maxDepth }).maxDepth, maxDepth)
for (const maxDepth of [0, 26, 1.5, "5"]) assert.equal(ControlObserveRequestSchema.safeParse({ ...nativeRead, maxDepth }).success, false)
const pageRead = { target: { kind: "page", browser: "fixture", tab: "1", lease: "fixture", generation: "fixture" } }
assert.equal(ControlObserveRequestSchema.safeParse(pageRead).success, true)
assert.equal(ControlObserveRequestSchema.safeParse({ ...pageRead, maxDepth: 5 }).success, false)
