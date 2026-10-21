import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, request, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import { gzipSync } from "node:zlib"
import { WebSocket, WebSocketServer } from "ws"
import { CloudPreviews } from "@mako/host/conversations/cloud-previews"

/**
 * A cloud Thread's app as this Mac serves it (`CloudPreviews`), against a stand-in for the gateway's preview route: each
 * request reaches `/v1/threads/<id>/ports/<port>/…` as this Mac's device, its method, path, query, body and headers as
 * sent; the answer comes back as the port gave it (its status, its cookies, its compressed body untouched); a
 * WebSocket (a dev server's reload) passes both ways; one port is served at one address however often it's asked;
 * and a Mac that isn't signed in says so rather than sending anything.
 */
type Seen = { method: string; url: string; authorization: string | undefined; body: string; host: string | undefined }
const seen: Seen[] = []
const gateway = createServer((incoming: IncomingMessage, outgoing) => {
  let body = ""
  incoming.on("data", (chunk) => (body += chunk))
  incoming.on("end", () => {
    seen.push({ method: incoming.method ?? "", url: incoming.url ?? "", authorization: incoming.headers.authorization, body, host: incoming.headers.host })
    if (incoming.url?.endsWith("/gzipped")) {
      outgoing.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" })
      return void outgoing.end(gzipSync("compressed as the app sent it"))
    }
    outgoing.writeHead(incoming.url?.includes("/missing") ? 404 : 200, { "content-type": "text/plain", "set-cookie": ["a=1; Path=/", "b=2; Path=/"] })
    outgoing.end(`app ${incoming.method} ${incoming.url}`)
  })
})
const sockets = new WebSocketServer({ server: gateway })
const upgrades: Array<{ url: string; authorization: string | undefined; protocol: string }> = []
sockets.on("connection", (socket, incoming) => {
  upgrades.push({ url: incoming.url ?? "", authorization: incoming.headers.authorization, protocol: socket.protocol })
  socket.on("message", (data) => socket.send(`echo ${data.toString()}`))
})
gateway.listen(0, "127.0.0.1")
await once(gateway, "listening")
// SAFETY: a server listening on a TCP port answers `address()` with its AddressInfo.
const at = new URL(`http://127.0.0.1:${(gateway.address() as AddressInfo).port}`)

let token: string | undefined = "connection-token"
const previews = new CloudPreviews({ gateway: () => at, token: async () => token })
try {
  const address = await previews.address("t-0123456789abcdef", 20_000)
  assert.equal(address.host, "t-0123456789abcdef.cloud.localhost")
  assert.deepEqual(await previews.address("t-0123456789abcdef", 20_000), address, "one port, one address")
  assert.notEqual((await previews.address("t-0123456789abcdef", 20_001)).port, address.port, "each port its own")
  const local = (path: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) =>
    new Promise<{ status: number; headers: IncomingMessage["headers"]; body: Buffer }>((resolve, reject) => {
      const sent = request({ host: "127.0.0.1", port: address.port, path, method: init.method ?? "GET", headers: { host: `${address.host}:${address.port}`, ...init.headers } }, (answer) => {
        const chunks: Buffer[] = []
        answer.on("data", (chunk: Buffer) => chunks.push(chunk))
        answer.on("end", () => resolve({ status: answer.statusCode ?? 0, headers: answer.headers, body: Buffer.concat(chunks) }))
      })
      sent.on("error", reject)
      sent.end(init.body)
    })

  const page = await local("/about?x=1")
  assert.equal(page.status, 200)
  assert.equal(page.body.toString(), "app GET /v1/threads/t-0123456789abcdef/ports/20000/about?x=1")
  assert.deepEqual(page.headers["set-cookie"], ["a=1; Path=/", "b=2; Path=/"], "the app's cookies, every one")
  assert.equal(seen.at(-1)?.authorization, "Bearer connection-token", "as this Mac's device")
  assert.equal(seen.at(-1)?.host, at.host, "to the gateway, not the name the browser used")
  const posted = await local("/api/save", { method: "POST", body: "{\"saved\":true}", headers: { "content-type": "application/json", authorization: "Bearer the-apps-own" } })
  assert.equal(posted.body.toString(), "app POST /v1/threads/t-0123456789abcdef/ports/20000/api/save")
  assert.equal(seen.at(-1)?.body, "{\"saved\":true}")
  assert.equal(seen.at(-1)?.authorization, "Bearer connection-token", "the device's own, never a page's")
  assert.equal((await local("/missing")).status, 404, "the app's own answer")
  const gzipped = await local("/gzipped", { headers: { "accept-encoding": "gzip" } })
  assert.equal(gzipped.headers["content-encoding"], "gzip", "compressed as sent, never decoded on the way")
  assert.equal(gzipped.body.subarray(0, 2).toString("hex"), "1f8b")

  // A dev server's reload: a WebSocket both ways, its subprotocol kept.
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/_reload?t=1`, ["vite-hmr"], { headers: { host: `${address.host}:${address.port}` } })
  await once(socket, "open")
  assert.equal(socket.protocol, "vite-hmr")
  socket.send("ping")
  const [echo] = await once(socket, "message")
  assert.equal(String(echo), "echo ping")
  assert.deepEqual(upgrades.at(-1), { url: "/v1/threads/t-0123456789abcdef/ports/20000/_reload?t=1", authorization: "Bearer connection-token", protocol: "vite-hmr" })
  socket.close()
  await once(socket, "close")

  token = undefined
  const before = seen.length
  const signedOut = await local("/")
  assert.equal(signedOut.status, 503)
  assert.match(signedOut.body.toString(), /isn't signed in/)
  assert.equal(seen.length, before, "nothing sent")
  console.log("PASS: a cloud Thread's app served on this Mac: each port one address; path, query, body and method through as this Mac's device; the app's status, cookies and compressed body back untouched; a WebSocket both ways; signed out, nothing sent")
} finally {
  await previews.close()
  sockets.close()
  gateway.close()
}
