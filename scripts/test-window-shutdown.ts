import assert from "node:assert/strict"
import { WindowShutdown } from "@mako/host/application/window-shutdown"

const shutdown = new WindowShutdown(200)
let id = ""
let finished = false
const first = shutdown.request(["window-one", "window-two"], (value) => {
  id = value
})
assert.equal(
  shutdown.request(["window-one"], () => {
    throw new Error("Must reuse the active request")
  }),
  first
)
void first.then(() => {
  finished = true
})
assert.equal(shutdown.acknowledge("stale", "window-one"), false)
assert.equal(shutdown.acknowledge(id, "another-window"), false)
assert.equal(shutdown.acknowledge(id, "window-one"), true)
await Promise.resolve()
assert.equal(finished, false)
assert.equal(shutdown.acknowledge(id, "window-two"), true)
await first
assert.equal(finished, true)
assert.equal(shutdown.acknowledge(id, "window-two"), true)
assert.equal(shutdown.acknowledge(id, "late-window"), false)
const blocked = new WindowShutdown(10)
await assert.rejects(
  blocked.request(["unsaved-window"], () => {}),
  /could not save/
)
await blocked.request([], () => {
  throw new Error("No windows need a save request")
})
console.log(
  "Window shutdown: all-window acknowledgements, stale/wrong-window refusal, shared requests, retries, timeout and empty-client handling passed"
)
