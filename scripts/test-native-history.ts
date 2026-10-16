import assert from "node:assert/strict"
import { captureNativeHistory } from "@mako/host/conversations/native-history"
import type { ThreadPage } from "@mako/sessions"

const entries = Array.from({ length: 503 }, (_, index) => ({
  type: "user" as const,
  id: `u${index}`,
  text: `turn ${index}`,
}))
const ref = {
  path: "fixture",
  nativeId: "fixture",
  harness: "fixture",
  bytes: 503,
}
async function read(
  _path: string,
  before = entries.length
): Promise<ThreadPage> {
  const start = Math.max(0, before - 100)
  return {
    ref,
    entries: entries.slice(start, before),
    start,
    total: entries.length,
    hasEarlier: start > 0,
    checkpoint: 503,
  }
}
const captured = await captureNativeHistory(ref.path, read)
assert.deepEqual(captured?.entries, entries)
assert.equal(captured?.hasEarlier, false)
assert.equal(captured?.start, 0)
await assert.rejects(
  captureNativeHistory(ref.path, async (path, before) => ({
    ...(await read(path, before)),
    checkpoint: before === undefined ? 503 : 504,
  })),
  /changed/
)
await assert.rejects(
  captureNativeHistory(ref.path, async (path, before) =>
    before === undefined ? read(path) : null
  ),
  /missing/
)
await assert.rejects(
  captureNativeHistory(ref.path, async (path) => read(path)),
  /changed/
)
console.log(
  "Native history capture: all 503 entries in order; mutation, missing pages and non-progress rejected"
)
