import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeRequests } from "../electron/native-requests.ts"
import type { NativeRequestInput } from "@mako/host/contracts/native-requests"

const root = mkdtempSync(join(tmpdir(), "mako-native-requests-"))
const calls: string[] = []
let finish: () => void = () => {}
let busy = true
const dependencies = {
  read: async (path: string) => ({ path, harness: "test", nativeId: "native", cwd: root }),
  running: () => busy,
  execute: async (_ref: { path: string }, text: string) => {
    calls.push(text)
    await new Promise<void>((resolve) => { finish = resolve })
  },
  changed: () => {},
  failed: (message: string) => { throw new Error(message) },
}
let owner = new NativeRequests(root, dependencies)
async function tick() { await new Promise((resolve) => setTimeout(resolve, 5)) }
try {
  const input: NativeRequestInput = { id: randomUUID(), path: "/native", text: "Inspect attached image", attachments: [{ name: "image.png", mimeType: "image/png", size: 3, data: "YWJj" }] }
  const first = await owner.submit(input)
  await owner.submit(input)
  assert.equal(calls.length, 0)
  assert.equal(owner.list().length, 1)
  const retained = first.input.attachments[0]?.path
  assert.ok(retained)
  assert.equal(readFileSync(retained, "utf8"), "abc")
  assert.equal(first.input.attachments[0]?.data, undefined)
  await assert.rejects(owner.submit({ ...input, text: "different" }), /different content/)
  busy = false
  owner.ready(input.path)
  owner.ready(input.path)
  await tick()
  assert.equal(calls.length, 1)
  assert.match(calls[0] ?? "", /image.png/)
  assert.ok(calls[0]?.includes(retained))
  const next = { ...input, id: randomUUID(), text: "Second request" }
  await owner.submit(next)
  assert.equal(calls.length, 1)
  finish()
  await tick()
  assert.equal(calls.length, 2)
  owner.stop()
  finish()
  await tick()
  owner = new NativeRequests(root, dependencies)
  assert.equal(owner.list().find((request) => request.input.id === next.id)?.status, "uncertain")
  await owner.submit(next)
  await tick()
  assert.equal(calls.length, 2, "a restart or repeated receipt must not replay an uncertain native command")
  console.log("Native queue verified: durable attachments, ordered dispatch, repeated receipt deduplication, mismatched payload rejection, and uncertain recovery")
} finally { owner.stop(); rmSync(root, { recursive: true, force: true }) }
