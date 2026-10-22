#!/usr/bin/env node
// A stand-in for Chromium that `MachineBrowser` launches in tests: it records its arguments and pid, then announces a
// DevTools endpoint that answers every command, as Chromium does on stderr. FAKE_CHROMIUM_MODE=fail exits first.
import { appendFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { WebSocketServer } from "ws"

appendFileSync(process.env.FAKE_CHROMIUM_LOG, `${JSON.stringify({ pid: process.pid, args: process.argv.slice(2) })}\n`)
if (process.env.FAKE_CHROMIUM_MODE === "fail") {
  process.stderr.write("[0101/000000.000000:FATAL:zygote_host_impl_linux.cc(127)] No usable sandbox!\n")
  process.exit(1)
}
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 })
server.on("listening", () => {
  process.stderr.write(`\nDevTools listening on ws://127.0.0.1:${server.address().port}/devtools/browser/${randomUUID()}\n`)
})
server.on("connection", (socket) => {
  socket.on("message", (data) => {
    const { id } = JSON.parse(String(data))
    socket.send(JSON.stringify({ id, result: {} }))
  })
})
process.on("SIGTERM", () => process.exit(0))
