#!/usr/bin/env node
// A stand-in for Chromium that `MachineBrowser` launches in tests: it records its arguments and pid, then announces a
// DevTools endpoint that answers every command, as Chromium does on stderr. FAKE_CHROMIUM_MODE=fail exits first.
import { appendFileSync } from "node:fs"
import { Socket } from "node:net"
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
// SIGUSR1: DevTools goes away while the process lives on, as a killed Chromium's socket closes before its exit is heard.
process.on("SIGUSR1", () => {
  for (const socket of server.clients) socket.terminate()
  server.close()
})
// --remote-debugging-pipe: commands on fd 3, answers on fd 4, each NUL-terminated. Extensions.loadUnpacked answers with
// the allowlisted extension's id, as Chromium answers with the id its key gives.
if (process.argv.includes("--remote-debugging-pipe")) {
  const id = process.argv.find((arg) => arg.startsWith("--allowlisted-extension-id="))?.slice("--allowlisted-extension-id=".length)
  // Sockets, not file streams: a file stream's blocking read would hold the process at exit.
  const output = new Socket({ fd: 4, writable: true })
  let text = ""
  new Socket({ fd: 3, readable: true }).on("data", (chunk) => {
    text += chunk
    for (let end = text.indexOf("\0"); end >= 0; end = text.indexOf("\0")) {
      const message = JSON.parse(text.slice(0, end))
      text = text.slice(end + 1)
      if (process.env.FAKE_CHROMIUM_PIPE_LOG) appendFileSync(process.env.FAKE_CHROMIUM_PIPE_LOG, `${JSON.stringify(message)}\n`)
      output.write(`${JSON.stringify({ id: message.id, result: { id } })}\0`)
    }
  })
}
