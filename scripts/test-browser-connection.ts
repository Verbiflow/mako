import assert from "node:assert/strict"
import { z } from "zod"
import { WebSocketServer } from "ws"
import { BrowserConnection } from "../packages/control-runtime/src/browser-connection.js"
import { BrowserFault } from "../packages/control-runtime/src/contracts/browser-control.js"
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
await new Promise<void>((resolve) => server.once("listening", resolve))
let calls = 0
server.on("connection", (socket) => socket.on("message", (data) => {
  const { id, method } = JSON.parse(data.toString())
  calls++
  socket.send(JSON.stringify({ id, error: { code: -32000,
    message: method === "Input.insertText" ? "Detached while handling command." : "Invalid parameters" } }))
}))
const address = z.object({ port: z.number() }).parse(server.address())
const connection = await BrowserConnection.connect(`ws://127.0.0.1:${address.port}`, AbortSignal.timeout(1000))
try {
  for (const [method, outcome] of [["Input.insertText", "unknown"], ["DOM.resolveNode", "rejected"]]) {
    await assert.rejects(connection.send(method!, {}, AbortSignal.timeout(1000)),
      (error: Error) => error instanceof BrowserFault && error.detail.outcome === outcome)
  }
  assert.equal(calls, 2, "uncertain input is never replayed")
  console.log("Browser connection: in-flight detach is uncertain, explicit rejection remains rejected, no replay")
} finally {
  connection.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
