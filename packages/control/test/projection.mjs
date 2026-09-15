import assert from "node:assert/strict"
import {
  indexSnapshot,
  diffLines,
  elementLine,
  elementLines,
  lineIdentity,
  toolResultData,
  toolResultError,
  windowKind,
  withWindowKinds,
  withoutMenuBar,
} from "../dist/computer/index.js"

const element = (index, role, label, value, extra = {}) => ({
  element_token: `s00000001:${index}`,
  element_index: index,
  role,
  label,
  value,
  actions: ["AXPress"],
  depth: 2,
  enabled: true,
  frame: { x: 6, y: 68, w: 243, h: 32 },
  in_web_content: true,
  parent_index: 1,
  selected: false,
  ...extra,
})
const elements = [
  element(0, "AXWindow", "Conductor", null),
  element(1, "AXButton", "Settings", null),
  element(2, "AXStaticText", "Dashboard", "Dashboard"),
  element(3, "AXTextField", "Search settings", "gpt"),
  element(4, "AXMenuBar", null, null),
  element(5, "AXMenuItem", "About This Mac", null),
  element(6, "AXCheckBox", null, 1, { enabled: false, selected: true }),
]

// One line per element: token, role without AX, label, a value that adds
// something, state, frame on request.
assert.equal(elementLine(elements[1]), 's00000001:1 Button "Settings"')
assert.equal(
  elementLine(elements[2]),
  's00000001:2 StaticText "Dashboard"',
  "a value equal to the label is not repeated"
)
assert.equal(
  elementLine(elements[3]),
  's00000001:3 TextField "Search settings" ="gpt"'
)
assert.equal(
  elementLine(elements[6]),
  's00000001:6 CheckBox ="1" disabled selected'
)
assert.equal(
  elementLine(elements[1], { frames: true }),
  's00000001:1 Button "Settings" @6,68 243x32'
)
const long = element(7, "AXStaticText", "Long", "x".repeat(200))
assert.match(elementLine(long), /="x{80}…"$/)

// The menu bar is never a line; interactive drops what only shows; query filters.
const lines = elementLines(elements)
assert.equal(lines.length, 5)
assert.ok(lines.every((line) => !/Menu/.test(line)))
assert.deepEqual(
  elementLines(elements, { interactive: true }).map((l) => l.split(" ")[1]),
  ["Button", "TextField", "CheckBox"]
)
assert.deepEqual(elementLines(elements, { query: "settings" }).length, 2)
assert.deepEqual(
  elementLines([{ nonsense: true }, null, 4]),
  [],
  "records that are not elements are skipped"
)

// Identity ignores the token so the same element compares equal across snapshots.
assert.equal(lineIdentity('s00000001:1 Button "Settings"'), 'Button "Settings"')
const delta = diffLines(
  ['s00000001:1 Button "Settings"', 's00000001:2 StaticText "Dashboard"'],
  ['s00000002:1 Button "Settings"', 's00000002:9 Link "General"']
)
assert.deepEqual(delta, {
  added: ['s00000002:9 Link "General"'],
  removed: ['StaticText "Dashboard"'],
  unchanged: 1,
})

// Menu bar removal keeps tokens valid and says what it dropped.
const state = withoutMenuBar({
  elements,
  returned_element_count: 7,
  total_element_count: 7,
  window_id: 1,
})
assert.equal(state.elements.length, 5)
assert.equal(state.returned_element_count, 5)
assert.equal(state.menu_bar_elements_omitted, 2)
assert.equal(state.elements[1].element_token, "s00000001:1")
const untouched = { elements: elements.slice(0, 2) }
assert.equal(
  withoutMenuBar(untouched),
  untouched,
  "nothing to drop returns the same object"
)
assert.deepEqual(withoutMenuBar({ other: 1 }), { other: 1 })

// Window kinds: Finder's untitled 30px strips are helpers, titled windows documents,
// an untitled window of real size is unknown.
assert.equal(
  windowKind({
    window_id: 89,
    title: "",
    bounds: { x: 0, y: 0, width: 1352, height: 30 },
  }),
  "helper"
)
assert.equal(
  windowKind({
    window_id: 1,
    title: "Downloads",
    bounds: { x: 0, y: 0, width: 900, height: 600 },
  }),
  "document"
)
assert.equal(
  windowKind({
    window_id: 2,
    title: "",
    bounds: { x: 0, y: 378, width: 500, height: 500 },
  }),
  "unknown"
)
assert.equal(windowKind({ window_id: 3, title: null }), "unknown")
const listed = withWindowKinds({
  current_space_id: 1,
  windows: [
    {
      window_id: 89,
      title: "",
      bounds: { x: 0, y: 0, width: 1352, height: 30 },
      pid: 1374,
    },
    { window_id: 5, title: "Downloads", pid: 1374 },
    "junk",
  ],
})
assert.deepEqual(
  listed.windows.map((w) => w.kind ?? w),
  ["helper", "document", "junk"]
)
assert.equal(listed.windows[0].pid, 1374, "other fields survive")

// A program's result is the driver's data, not the MCP envelope.
const structured = { apps: [{ name: "Finder", pid: 1374 }] }
assert.deepEqual(
  toolResultData({
    content: [{ type: "text", text: JSON.stringify(structured) }],
    structuredContent: structured,
  }),
  structured
)
const withImage = toolResultData({
  content: [
    { type: "image", data: "aW1n", mimeType: "image/png" },
    { type: "text", text: JSON.stringify(structured) },
  ],
  structuredContent: structured,
})
assert.deepEqual(withImage, {
  ...structured,
  content: [{ type: "image", data: "aW1n", mimeType: "image/png" }],
})
assert.deepEqual(
  toolResultData({ content: [{ type: "text", text: "plain words" }] }),
  { text: "plain words" }
)
assert.deepEqual(
  toolResultData({
    content: [{ type: "text", text: "extra" }],
    structuredContent: { ok: true },
  }),
  { ok: true, content: [{ type: "text", text: "extra" }] }
)
assert.deepEqual(toolResultData({}), {})
assert.equal(
  toolResultError({
    isError: true,
    content: [{ type: "text", text: "refused: no window" }],
  }),
  "refused: no window"
)
assert.equal(
  toolResultError({ isError: true }),
  "The driver refused the action"
)
assert.equal(
  toolResultError({ content: [{ type: "text", text: "fine" }] }),
  undefined
)

// Snapshot memory retains only the exact window identity. Tokens are opaque
// and are never remapped by role or label.
const first = indexSnapshot({
  snapshot_id: "s00000001",
  pid: 4,
  window_id: 9,
  elements: [
    {
      element_token: "s00000001:0",
      role: "AXTextField",
      label: "Proof",
      value: "",
    },
    { element_token: "s00000001:1", role: "AXButton", label: "Verify proof" },
    { element_token: "s00000001:2", role: "AXButton", label: "Verify proof" },
    { role: "AXGroup" },
  ],
})
assert.deepEqual(first, {
  snapshot_id: "s00000001",
  pid: 4,
  window_id: 9,
})
assert.equal(
  indexSnapshot({ elements: [] }),
  undefined,
  "a snapshot needs its identity"
)
console.log("projection ok")
