import assert from "node:assert/strict"
import {
  actionReceipt,
  selectRoute,
  windowCapabilities,
} from "../dist/computer/index.js"

const target = { pid: 42, window_id: 7 }
const page = windowCapabilities({
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
