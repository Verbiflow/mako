import assert from "node:assert/strict"
import { createControlSession } from "@mako/control-runtime/host"

let release
let entered
const connecting = new Promise(resolve => { entered = resolve })
const delayed = new Promise(resolve => { release = resolve })
let closed = 0
let calls = 0
const driver = {
  listTools: async () => { calls++; return [] },
  callTool: async () => { calls++; return {} },
  onClose() {},
  close: async () => { closed++ },
}
const session = createControlSession({ command: "fixture", args: [] }, "close-during-start", async () => {
  entered()
  await delayed
  return driver
}, { surface: "driver", previewEnvironment: {} })
const starting = session.reference()
const reported = starting.then(value => assert.match(value, /closed during startup/))
await connecting
const closing = session.close()
release()
await Promise.all([closing, reported])
await session.close()
assert.equal(closed, 1)
assert.equal(calls, 0)
console.log("Native connection finishing after close is disposed once before any driver call")
