import assert from "node:assert/strict"
import {
  actionLine,
  programProperties,
  renderReference,
  returnsOf,
  signatureOf,
  summaryOf,
} from "../dist/computer/index.js"

const click = {
  name: "click",
  description:
    "Click at window-local coordinates or on an element token. Longer prose follows here.",
  inputSchema: {
    type: "object",
    properties: {
      session: { type: "string" },
      pid: { type: "integer", format: "int32" },
      x: { type: "number", format: "double" },
      element_token: { type: "string" },
    },
    required: ["session", "pid"],
  },
  outputSchema: {
    type: "object",
    properties: {
      route: {},
      delivery: {},
      effect: {},
      a: {},
      b: {},
      c: {},
      d: {},
      e: {},
      f: {},
    },
  },
}
const state = {
  name: "get_window_state",
  description: "Native capture.",
  inputSchema: {
    type: "object",
    properties: { session: { type: "string" }, pid: { type: "integer" } },
    required: ["session", "pid"],
  },
}

// session is never a program's to pass; Mako's flags join the driver's; Rust formats become ranges.
const props = programProperties(click)
assert.deepEqual(Object.keys(props.properties), [
  "pid",
  "x",
  "element_token",
  "foreground",
])
assert.deepEqual(props.required, ["pid"])
assert.equal(props.properties.pid.format, undefined)
assert.equal(props.properties.pid.maximum, 2_147_483_647)
assert.deepEqual(Object.keys(programProperties(state).properties), [
  "pid",
  "include_markdown",
  "include_menu_bar",
])

assert.equal(
  signatureOf(click),
  "computer.click({pid, x?, element_token?, foreground?})"
)
assert.equal(returnsOf(click), "{route, delivery, effect, a, b, c, d, e, …}")
assert.equal(returnsOf(state), undefined)
assert.equal(
  summaryOf(click),
  "Click at window-local coordinates or on an element token."
)
assert.equal(
  actionLine(click),
  "computer.click({pid, x?, element_token?, foreground?}) → {route, delivery, effect, a, b, c, d, e, …}  Click at window-local coordinates or on an element token."
)
assert.equal(
  actionLine({ name: "bare", inputSchema: { type: "object" } }),
  "computer.bare({})"
)

const text = renderReference([click, state])
assert.match(text, /^Helpers \(async, available in every program\):\n  view\(/)
assert.match(
  text,
  /\n  act\(action, args, \{settle\?, wait\?, target\?, postcondition\?\}\)/
)
assert.match(text, /\n  until\(/)
assert.match(text, /\n  expect\(/)
assert.match(text, /\n  windows\(pid\)/)
assert.match(
  text,
  /Driver actions \(computer\.<action>\(args\) resolves to the driver's data; a refused action throws/
)
assert.match(
  text,
  /\n  computer\.click\(\{pid, x\?, element_token\?, foreground\?\}\)/
)
// Helpers and Mako's own actions are in the reference beside the driver's.
assert.match(text, /\n  fill\(element_token, text/)
assert.match(text, /\n  submit\(element_token, target\?\)/)
assert.match(text, /\n  routes\(target\?\)/)
assert.match(
  text,
  /Mako actions \(computer\.<action>\(args\), run by Mako, not the driver\):\n  computer\.script\(\{language\?, source, timeout_ms\?\}\) → \{stdout, stderr, exit_code, ms\}/
)
assert.match(text, /\n  computer\.shell\(\{command, cwd\?, timeout_ms\?\}\)/)
assert.match(text, /\n  computer\.page_routes\(\{\}\)/)
// The flags that declare a fronting call or force a chord are on the actions that can front.
assert.deepEqual(
  Object.keys(
    programProperties({
      name: "hotkey",
      inputSchema: { type: "object", properties: { keys: {} } },
    }).properties
  ),
  ["keys", "foreground", "force"]
)
assert.deepEqual(
  Object.keys(
    programProperties({
      name: "launch_app",
      inputSchema: { type: "object", properties: { bundle_id: {} } },
    }).properties
  ),
  ["bundle_id", "page_route"]
)
assert.match(
  text,
  /\n  computer\.get_window_state\(\{pid, include_markdown\?, include_menu_bar\?\}\)/
)
assert.match(renderReference([]), /none — the native driver is not attached/)
console.log("reference ok")
