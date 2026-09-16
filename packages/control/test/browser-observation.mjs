import assert from "node:assert/strict"
import {
  pageNodeLines,
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
  'a1:4     checkbox "Allow diagnostics" checked=true',
])

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
