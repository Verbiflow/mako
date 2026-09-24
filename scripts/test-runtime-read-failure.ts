import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { invokeRuntime, RuntimeDisconnectedError } from "../electron/runtime-connection"
import { invokeWithRecovery } from "../electron/runtime-retry"

const root = await mkdtemp(join(tmpdir(), "mako-read-failure-"))
const socket = join(root, "host.sock")
let body = JSON.stringify({ ok: true, value: "x".repeat(34 * 1024 * 1024) })
let reads = 0
const host = createServer((request, response) => {
  request.resume()
  reads++
  response.writeHead(200, { "content-type": "application/json" }).end(body)
})
await new Promise<void>((resolve) => host.listen(socket, resolve))
try {
  await assert.rejects(invokeRuntime(socket, "fixture", "mako:live-snapshot", ["fixture"]), (error) =>
    error instanceof Error && !(error instanceof RuntimeDisconnectedError) && /too large to load/.test(error.message) &&
    error.cause instanceof Error && /exceeded.*limit/.test(error.cause.message))
  body = "{invalid"
  await assert.rejects(invokeRuntime(socket, "fixture", "mako:live-snapshot", ["fixture"]), /could not read the host response/)
  await assert.rejects(invokeRuntime(socket, "fixture", "mako:git-commit", []), (error) =>
    error instanceof RuntimeDisconnectedError && error.unconfirmed)
  body = JSON.stringify({ ok: true, value: { intact: true } })
  assert.deepEqual(await invokeRuntime(socket, "fixture", "mako:live-snapshot", ["fixture"]), { intact: true })
  assert.equal(reads, 4, "Invalid read responses do not implicitly retry")
  for (const peer of [undefined, "peer-id"]) {
    await assert.rejects(invokeWithRecovery("mako:live-snapshot", async () => {
      throw new RuntimeDisconnectedError(true, peer)
    }, { lost() {}, async whenConnected() { return false } }), (error) =>
      error instanceof RuntimeDisconnectedError && !error.unconfirmed && error.conversationId === peer)
  }
  console.log("PASS: oversized/malformed read diagnosis, healthy subsequent read, uncertain mutation preserved, no false read-delivery claim")
} finally {
  host.close()
  host.closeAllConnections()
  await rm(root, { recursive: true, force: true })
}
