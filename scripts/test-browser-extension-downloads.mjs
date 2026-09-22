import assert from "node:assert/strict"
import { build } from "esbuild"
const built = await build({
  entryPoints: ["browser-extension/downloads.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
})
const { ExtensionDownloads } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].contents).toString("base64")}`
)
const listeners = new Set()
let nextId = 0
const items = new Map()
let starts = 0
const api = {
  downloads: {
    download: async (options) => {
      starts++
      const id = ++nextId
      items.set(id, {
        id,
        url: options.url,
        state: "in_progress",
        exists: false,
        filename: "/Downloads/proof.txt",
        bytesReceived: 0,
      })
      return id
    },
    search: async ({ id }) => [structuredClone(items.get(id))],
    onChanged: {
      addListener: (f) => listeners.add(f),
      removeListener: (f) => listeners.delete(f),
    },
  },
}
const downloads = new ExtensionDownloads(api)
const owner = { client: "a", targetId: "page" }
const pending = await downloads.start(owner, {
  url: "https://example.test/file",
  timeoutMs: 0,
})
assert.equal(pending.state, "inProgress")
assert.equal(pending.path, null)
assert.equal(listeners.size, 0)
await assert.rejects(
  downloads.status({ client: "b", targetId: "page" }, pending.id, 0),
  /exact task tab/
)
await assert.rejects(
  downloads.status({ client: "a", targetId: "other" }, pending.id, 0),
  /exact task tab/
)
const waiting = downloads.status(owner, pending.id, 1000)
items.set(pending.id, {
  ...items.get(pending.id),
  state: "complete",
  exists: true,
  bytesReceived: 26,
})
for (const listener of listeners)
  listener({ id: pending.id, state: { current: "complete" } })
const complete = await waiting
assert.equal(complete.state, "completed")
assert.equal(complete.bytes, 26)
assert.equal(starts, 1, "Checking completion never starts another download")
assert.equal(listeners.size, 0)
const canceled = await downloads.start(owner, {
  url: "https://example.test/second",
  timeoutMs: 0,
})
items.set(canceled.id, {
  ...items.get(canceled.id),
  state: "interrupted",
  error: "USER_CANCELED",
})
assert.equal((await downloads.status(owner, canceled.id, 0)).state, "canceled")
downloads.release("a")
await assert.rejects(downloads.status(owner, pending.id, 0), /exact task tab/)
await assert.rejects(
  downloads.start(owner, { url: "file:///private/file", timeoutMs: 0 })
)
assert.equal(starts, 2)
console.log(
  "Extension downloads: exact ownership, completion, interruption, timeout continuation, listener cleanup and no repeated starts passed"
)
