import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { decodePortHead, problemType, type MediaSender, type Problem } from "@mako/protocol"
import { PortRelay } from "@mako/host/transport/port-relay"

/** A stream's sender as the link would be: what was sent, and how it ended. */
function sender() {
  const sent: Uint8Array[] = []
  let ended: { problem: Problem | undefined } | undefined
  let done: () => void = () => undefined
  const finished = new Promise<void>((resolve) => (done = resolve))
  const made: MediaSender = {
    send: (data) => {
      if (ended) return false
      sent.push(data)
      return true
    },
    end: (problem) => {
      ended = { problem }
      done()
    },
  }
  return { made, sent, finished, ended: () => ended }
}

/** An app on the loopback, as a Thread's app serves: its page, a large asset, and what it was asked. */
async function app() {
  const asked: Array<{ method: string; url: string; host: string | undefined; body: string }> = []
  const server = createServer((request, response) => {
    let body = ""
    request.on("data", (chunk: Buffer) => (body += chunk.toString()))
    request.on("end", () => {
      asked.push({ method: request.method ?? "", url: request.url ?? "", host: request.headers.host, body })
      if (request.url === "/big") {
        response.writeHead(200, { "content-type": "application/octet-stream" })
        response.end(Buffer.alloc(3 * 1024 * 1024, 7))
        return
      }
      response.writeHead(201, { "content-type": "text/html", "x-app": "yes" })
      response.end("<h1>Payments</h1>")
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  // SAFETY: a server listening on a TCP port is addressed by an AddressInfo.
  return { port: (server.address() as AddressInfo).port, asked, close: () => server.close() }
}

test("a request to a Thread's app's port is made on the loopback and answered head first, then its body", async () => {
  const served = await app()
  const relay = new PortRelay({ allowed: async () => new Set([served.port]), files: undefined })
  const stream = sender()
  relay.open("port-req-1", { to: { kind: "port", port: served.port }, method: "POST", path: "/save?x=1", headers: [["content-type", "application/json"], ["host", "p-x.example"], ["connection", "close"]], body: Buffer.from('{"a":1}').toString("base64") }, stream.made)
  await stream.finished
  assert.equal(stream.ended()?.problem, undefined)
  const head = decodePortHead(stream.sent[0]!)
  assert.equal(head.status, 201)
  assert.ok(head.headers.some(([name, value]) => name === "x-app" && value === "yes"))
  assert.ok(!head.headers.some(([name]) => name === "content-length" || name === "connection"), "one hop's headers stay on it")
  assert.equal(Buffer.concat(stream.sent.slice(1)).toString(), "<h1>Payments</h1>")
  assert.deepEqual(served.asked[0], { method: "POST", url: "/save?x=1", host: `127.0.0.1:${served.port}`, body: '{"a":1}' })
  served.close()
})

test("a port no Thread's app serves is refused before anything is asked of it", async () => {
  const served = await app()
  const relay = new PortRelay({ allowed: async () => new Set([1]), files: undefined })
  const stream = sender()
  relay.open("port-req-2", { to: { kind: "port", port: served.port }, method: "GET", path: "/", headers: [] }, stream.made)
  await stream.finished
  assert.equal(problemType(stream.ended()!.problem!), "not-found")
  assert.equal(served.asked.length, 0)
  served.close()
})

test("a large answer waits for the gateway to take it, and stops when the phone goes away", async () => {
  const served = await app()
  const relay = new PortRelay({ allowed: async () => new Set([served.port]), files: undefined })
  const stream = sender()
  relay.open("port-req-3", { to: { kind: "port", port: served.port }, method: "GET", path: "/big", headers: [] }, stream.made)
  const bytes = () => stream.sent.slice(1).reduce((sum, piece) => sum + piece.byteLength, 0)
  while (bytes() < 2 * 1024 * 1024) await new Promise((resolve) => setImmediate(resolve))
  // Unacknowledged, it holds at its window: a slow phone slows the Mac's reading.
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve))
  const held = bytes()
  assert.ok(held < 3 * 1024 * 1024, `held at ${held}`)
  relay.acked("port-req-3", held)
  await stream.finished
  assert.equal(bytes(), 3 * 1024 * 1024)
  const stopped = sender()
  relay.open("port-req-4", { to: { kind: "port", port: served.port }, method: "GET", path: "/big", headers: [] }, stopped.made)
  while (stopped.sent.length < 2) await new Promise((resolve) => setImmediate(resolve))
  relay.closed("port-req-4")
  const after = stopped.sent.length
  for (let tick = 0; tick < 20; tick++) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(stopped.sent.length, after, "nothing more once the phone went away")
  served.close()
})

test("a signed file is answered from the host's own files, and nothing else is asked of them", async () => {
  const asked: string[] = []
  const relay = new PortRelay({
    allowed: async () => new Set(),
    files: async (request) => {
      asked.push(request.url)
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } })
    },
  })
  const stream = sender()
  relay.open("port-req-5", { to: { kind: "files" }, method: "GET", path: "/file/asset/payload/0123/shot.png", headers: [] }, stream.made)
  await stream.finished
  assert.equal(decodePortHead(stream.sent[0]!).status, 200)
  assert.deepEqual(Buffer.concat(stream.sent.slice(1)), Buffer.from([137, 80, 78, 71]))
  assert.deepEqual(asked, ["mako-file://asset/payload/0123/shot.png"])
  const refused = sender()
  relay.open("port-req-6", { to: { kind: "files" }, method: "GET", path: "/etc/passwd", headers: [] }, refused.made)
  await refused.finished
  assert.equal(problemType(refused.ended()!.problem!), "not-found")
  assert.equal(asked.length, 1, "only the files route is a file")
})
