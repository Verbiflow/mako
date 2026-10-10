import assert from "node:assert/strict"
import { processGroupsForTerminal } from "@mako/host/terminals/process-groups"
import { isUsKeyboardLayout } from "../src/lib/mac-option-meta.ts"
import { parseTerminalFileLink } from "../src/lib/terminal-links.ts"

const processTable = `
  100 100 ttys004
  101 101 ttys004
  102 101 ttys004
  200 200 ttys005
`
assert.deepEqual(processGroupsForTerminal(processTable, 100, 999), [101, 100])
assert.equal(processGroupsForTerminal(processTable, 100, 102), null)
assert.equal(processGroupsForTerminal("100 100 ??", 100, 999), null)

const us = new Map([
  ["KeyQ", "q"],
  ["KeyW", "w"],
  ["KeyA", "a"],
  ["KeyZ", "z"],
  ["Semicolon", ";"],
  ["Quote", "'"],
  ["Backquote", "`"],
  ["BracketLeft", "["],
  ["BracketRight", "]"],
])
assert.equal(isUsKeyboardLayout(us), true)
us.set("KeyZ", "y")
assert.equal(isUsKeyboardLayout(us), false)
assert.equal(isUsKeyboardLayout(new Map()), false)
assert.deepEqual(parseTerminalFileLink("src/app.ts:42:7"), {
  path: "src/app.ts",
  line: 42,
})
assert.deepEqual(parseTerminalFileLink("/Users/example/project/README.md"), {
  path: "/Users/example/project/README.md",
})

console.log("macOS terminal checks passed")
