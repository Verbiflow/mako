import assert from "node:assert/strict"
import {
  pageNodeLines,
  pageOutlineLine,
  pageOutlineLines,
  selectPageNodes,
} from "../dist/browser/index.js"

const observation = {
  target: { browser: "fixture", tab: "settings" },
  nodes: [
    { depth: 0, role: "RootWebArea", name: "Settings" },
    { depth: 1, role: "region", name: "Privacy" },
    { depth: 2, role: "heading", name: "Permissions", level: 2 },
    {
      ref: "a1:3",
      depth: 2,
      role: "button",
      name: "Open permissions",
      expanded: "true",
    },
    {
      ref: "a1:4",
      depth: 2,
      role: "checkbox",
      name: "Allow diagnostics",
      checked: "true",
    },
  ],
}

const selected = selectPageNodes(observation, {
  text: "permissions",
  roles: ["button"],
})
assert.equal(selected.matched, 1)
assert.equal(selected.context, 2)
assert.deepEqual(
  selected.nodes.map((node) => node.name),
  ["Settings", "Privacy", "Open permissions"]
)

const checked = selectPageNodes(observation, {
  roles: ["checkbox"],
  states: { checked: "true" },
  refsOnly: true,
  includeAncestors: false,
})
assert.deepEqual(checked.nodes.map((node) => node.ref), ["a1:4"])
assert.deepEqual(pageNodeLines(checked.nodes), [
  'a1:4 checkbox "Allow diagnostics" checked=true',
])
assert.deepEqual(pageOutlineLines(observation.nodes), [
  'RootWebArea "Settings"',
  '  region "Privacy"',
  '    heading "Permissions" level=2',
  '    a1:3 button "Open permissions" expanded',
  '    a1:4 checkbox "Allow diagnostics" checked',
])
assert.deepEqual(pageOutlineLines(observation.nodes.slice(3), { flat: true }), [
  'a1:3 button "Open permissions" expanded',
  'a1:4 checkbox "Allow diagnostics" checked',
])
assert.equal(
  pageOutlineLine({ ref: "e7", depth: 0, role: "textbox", name: "Email", value: "ada@example.com", required: true, focused: true, expanded: "false" }),
  'e7 textbox "Email" value="ada@example.com" expanded=false focused required'
)

const prose = [
  { ref: "e1", depth: 0, role: "navigation", name: "Site" },
  { ref: "e2", depth: 1, role: "link", name: "microsoft" },
  { ref: "e3", depth: 1, role: "StaticText", name: "/" },
  { ref: "e4", depth: 1, role: "link", name: "playwright" },
  { ref: "e5", depth: 1, role: "StaticText", name: "Public" },
  { ref: "e6", depth: 1, role: "link", name: "8 hours ago" },
  { ref: "e7", depth: 1, role: "StaticText", name: "| " },
  { ref: "e8", depth: 1, role: "link", name: "hide" },
  { ref: "e9", depth: 1, role: "StaticText", name: " (" },
  { ref: "e10", depth: 1, role: "link", name: "Docs", focused: true },
  { ref: "e11", depth: 1, role: "StaticText", name: ")." },
  { ref: "e12", depth: 0, role: "list" },
  { ref: "e13", depth: 1, role: "link", name: "Home" },
  { ref: "e14", depth: 1, role: "link", name: "About" },
]
assert.deepEqual(pageOutlineLines(prose), [
  'e1 navigation "Site"',
  "  text: [microsoft](e2)/[playwright](e4) Public [8 hours ago](e6) | [hide](e8) (",
  '  e10 link "Docs" focused',
  "  text: ).",
  "list",
  '  e13 link "Home"',
  '  e14 link "About"',
], "text and plain links read as one line; a link with states keeps its own row; links without text stay rows")
assert.deepEqual(pageOutlineLines(prose.slice(1, 4), { flat: true }), [
  'e2 link "microsoft"',
  "text: /",
  'e4 link "playwright"',
], "filtered rows are not siblings, so they never join")

const bounded = selectPageNodes(observation, {
  roles: ["heading", "button", "checkbox"],
  includeAncestors: false,
  max: 2,
})
assert.equal(bounded.matched, 3)
assert.equal(bounded.returned, 2)
assert.equal(bounded.omitted, 1)

const one = selectPageNodes(observation, {
  roles: ["button"],
  max: 1,
})
assert.deepEqual(one.nodes.map((node) => node.ref), ["a1:3"])

console.log("browser observation tests passed")
