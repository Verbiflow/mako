import assert from "node:assert/strict"
import {
  controlLineRef,
  pageElementLines,
  planControlOperation,
} from "../dist/control/index.js"
import { windowCapabilities } from "../dist/computer/index.js"

const window = { kind: "window", pid: 42, window_id: 7 }
const capabilities = windowCapabilities({
  platform: "darwin",
  target: window,
  documentWindows: 1,
  onScreen: true,
})

assert.deepEqual(
  planControlOperation(
    window,
    { kind: "set-text", ref: "s00000001:2", text: "value" },
    capabilities
  ),
  {
    status: "selected",
    route: "accessibility",
    topology: "none",
    verification: "read-back",
  }
)
assert.equal(
  planControlOperation(
    window,
    { kind: "press-key", key: "a", modifiers: ["Meta"] },
    capabilities
  ).status,
  "foreground-required",
  "native Command chords are never dispatched as background keys"
)
const ambiguousKeys = planControlOperation(
  window,
  { kind: "press-key", key: "return", modifiers: [] },
  windowCapabilities({
    platform: "darwin",
    target: window,
    documentWindows: 2,
    onScreen: true,
  })
)
assert.equal(ambiguousKeys.status, "foreground-required")
assert.match(
  ambiguousKeys.reason,
  /pid-keyboard: 2 document windows share this process/,
  "foreground fallback must retain the background route's refusal reason"
)
assert.deepEqual(
  planControlOperation(
    window,
    {
      kind: "pointer",
      at: { x: 10, y: 20 },
      button: "left",
      count: 1,
    },
    capabilities
  ),
  {
    status: "selected",
    route: "window-pointer",
    topology: "surface",
    verification: "observation",
  }
)

const page = {
  kind: "page",
  browser: "chrome",
  tab: "tab-1",
  generation: "generation-1",
  lease: "lease-1",
}
assert.deepEqual(
  planControlOperation(page, {
    kind: "press-key",
    key: "Enter",
    modifiers: [],
  }),
  {
    status: "selected",
    route: "page",
    topology: "surface",
    verification: "observation",
  }
)
assert.equal(
  planControlOperation(undefined, {
    kind: "command",
    language: "shell",
    source: "pwd",
  }).route,
  "command"
)
assert.equal(
  planControlOperation(undefined, {
    kind: "activate",
    ref: "missing",
    action: "press",
  }).status,
  "unsupported"
)

const lines = pageElementLines([
  {
    ref: "abc123:4",
    depth: 2,
    role: "textbox",
    name: "Proof",
    value: "current",
    focused: "true",
  },
  { depth: 0, role: "RootWebArea", name: "Fixture" },
])
assert.deepEqual(lines, [
  'abc123:4 textbox "Proof" ="current" focused',
  'RootWebArea "Fixture"',
])
assert.equal(controlLineRef(lines[0]), "abc123:4")
assert.equal(controlLineRef('s00000001:2 Button "Save"'), "s00000001:2")
assert.throws(() => controlLineRef('Button "Save"'), /no control ref/)

console.log("control plane ok")

const nativeWithPage = windowCapabilities({
  platform: "darwin",
  target: window,
  documentWindows: 1,
  onScreen: true,
  pageBrowser: "app:fixture",
})
assert.equal(
  planControlOperation(
    window,
    { kind: "set-text", ref: "s00000001:2", text: "00123" },
    nativeWithPage
  ).route,
  "accessibility",
  "a native ref must not claim page delivery"
)
