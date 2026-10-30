import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { test } from "node:test"
import { decodePortHead, problemType, type MediaSender, type Problem } from "@mako/protocol"
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PortRelay } from "@mako/host/transport/port-relay"
import { FILE_PREVIEW_TTL_MS, fileIdentity, filePreviewUrl } from "@mako/host/workspaces/file-previews"
import { readSignedFile, readWindowFile } from "@mako/host/workspaces/file-readers"
import { MediaRenditions } from "@mako/host/workspaces/media-renditions"

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
      if (request.url === "/cookie") {
        // An answer the link can't carry: one header past the protocol's 8 KB.
        response.writeHead(200, { "set-cookie": `session=${"x".repeat(9_000)}`, "content-type": "text/plain" })
        response.end("hello")
        return
      }
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
  const relay = new PortRelay({ allowed: async () => new Set([served.port]), signedFiles: undefined })
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
  const relay = new PortRelay({ allowed: async () => new Set([1]), signedFiles: undefined })
  const stream = sender()
  relay.open("port-req-2", { to: { kind: "port", port: served.port }, method: "GET", path: "/", headers: [] }, stream.made)
  await stream.finished
  assert.equal(problemType(stream.ended()!.problem!), "not-found")
  assert.equal(served.asked.length, 0)
  served.close()
})

test("a large answer waits for the gateway to take it, and stops when the phone goes away", async () => {
  const served = await app()
  const relay = new PortRelay({ allowed: async () => new Set([served.port]), signedFiles: undefined })
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

/** The host's files as the gateway's link reads them: the relay and `readSignedFile`, as `createHost` composes them. */
async function signedFilesRelay() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "mako-port-relay-")))
  const renditions = new MediaRenditions({
    folder: join(root, "renditions"),
    ffmpeg: () => {
      throw new Error("no ffmpeg here")
    },
  })
  const relay = new PortRelay({ allowed: async () => new Set(), signedFiles: (request) => readSignedFile(request, renditions) })
  const shot = join(root, "shot.png")
  await writeFile(shot, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  const signed = (options: { now?: number } = {}) => stat(shot).then((info) => filePreviewUrl(shot, fileIdentity(info), options))
  let streams = 0
  /** Asks for `mako-file://…` as the gateway does: `/file/…` on the files route. */
  const ask = async (path: string) => {
    const stream = sender()
    relay.open(`file-req-${++streams}`, { to: { kind: "files" }, method: "GET", path, headers: [] }, stream.made)
    await stream.finished
    const problem = stream.ended()?.problem
    if (problem) return { status: problemType(problem), body: "" }
    return { status: decodePortHead(stream.sent[0]!).status, body: Buffer.concat(stream.sent.slice(1)).toString("latin1") }
  }
  return { root, renditions, shot, signed, ask, close: () => rm(root, { recursive: true, force: true }) }
}

const asPath = (url: string) => `/file/${url.slice("mako-file://".length)}`

test("a file whose URL this host signed is served to the account's other devices", async () => {
  const files = await signedFilesRelay()
  const served = await files.ask(asPath(await files.signed()))
  assert.equal(served.status, 200)
  assert.equal(served.body, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("latin1"))
  await files.close()
})

test("a signed URL that expired or was tampered with is refused", async () => {
  const files = await signedFilesRelay()
  const expired = await files.signed({ now: Date.now() - FILE_PREVIEW_TTL_MS - 1_000 })
  assert.equal((await files.ask(asPath(expired))).status, 403)
  const url = await files.signed()
  const tampered = url.replace(/\/([a-f0-9]{64})\//, (_, signature: string) => `/${signature.startsWith("0") ? "1" : "0"}${signature.slice(1)}/`)
  assert.notEqual(tampered, url)
  assert.notEqual((await files.ask(asPath(tampered))).status, 200)
  // The payload names the path: one edited to another file no longer matches its signature.
  const [, payload] = /^mako-file:\/\/asset\/([^/]+)\//.exec(url)!
  const fields: unknown = JSON.parse(Buffer.from(payload!, "base64url").toString())
  assert.ok(Array.isArray(fields))
  fields[0] = "/etc/hosts"
  const forged = url.replace(payload!, Buffer.from(JSON.stringify(fields)).toString("base64url"))
  assert.notEqual((await files.ask(asPath(forged))).status, 200)
  await files.close()
})

test("no path on the computer is read through the link: a workspace URL, encoded or walked up to, is refused", async () => {
  const files = await signedFilesRelay()
  const url = await files.signed()
  const [, payload, signature] = /^mako-file:\/\/asset\/([^/]+)\/([a-f0-9]{64})\//.exec(url)!
  const secret = join(files.root, "id_ed25519")
  await writeFile(secret, "PRIVATE KEY")
  const attempts = [
    "/file/workspace//etc/hosts",
    `/file/workspace/${secret}`,
    `/file/workspace/${secret.slice(1)}`,
    "/file/workspace/%2Fetc%2Fhosts",
    "/file/workspace//%65tc/hosts",
    "/file/workspace///etc/hosts",
    "/file//workspace//etc/hosts",
    "/file/WORKSPACE//etc/hosts",
    "/file/%61sset/../workspace//etc/hosts",
    "/file/asset/../workspace//etc/hosts",
    "/file/asset/..%2Fworkspace//etc/hosts",
    "/file/asset/%2E%2E/workspace//etc/hosts",
    "/file/asset//..//workspace//etc/hosts",
    `/file/asset/${payload}/${signature}/../../../../etc/hosts`,
    `/file/asset/${payload}/${signature}/..%2F..%2F..%2Fetc%2Fhosts`,
    `/file/asset/${payload}/${signature}/%2Fetc%2Fhosts`,
    "/file/../etc/hosts",
    "/file/etc/hosts",
  ]
  for (const path of attempts) {
    const answer = await files.ask(path)
    assert.ok(answer.status !== 200 && !answer.body.includes("localhost") && !answer.body.includes("PRIVATE"), `${path} was served: ${answer.status}`)
  }
  // The reader itself serves only signed URLs, whatever reaches it: the window's reader is the one that opens a path.
  for (const target of ["mako-file://workspace//etc/hosts", `mako-file://workspace/${secret}`, "mako-file://workspace/etc/hosts"])
    assert.equal((await readSignedFile(new Request(target), files.renditions)).status, 404, target)
  // A host that resolves an absolute path as it is, as the window's open workspace does.
  const host = { resolvePath: async (path: string) => path }
  const window = await readWindowFile(new Request(`mako-file://workspace/${secret}`), async (run) => run(host), files.renditions)
  assert.equal(window.status, 200, "the window's reader does open a workspace path: never the link's")
  await window.body?.cancel()
  await files.close()
})

test("an answer the link can't carry ends the phone's request with a problem, and the host keeps serving", async () => {
  const served = await app()
  const relay = new PortRelay({ allowed: async () => new Set([served.port]), signedFiles: undefined })
  let rejections = 0
  const rejected = () => void rejections++
  process.on("unhandledRejection", rejected)
  const oversized = sender()
  relay.open("port-req-7", { to: { kind: "port", port: served.port }, method: "GET", path: "/cookie", headers: [] }, oversized.made)
  await oversized.finished
  assert.equal(problemType(oversized.ended()!.problem!), "unavailable")
  assert.equal(oversized.ended()!.problem!.status, 502)
  assert.equal(oversized.sent.length, 0, "no head went before the problem")
  // A request header no fetch takes is the same: the request ends, nothing reaches the app.
  const malformed = sender()
  relay.open("port-req-8", { to: { kind: "port", port: served.port }, method: "GET", path: "/", headers: [["bad header", "x"]] }, malformed.made)
  await malformed.finished
  assert.equal(malformed.ended()!.problem!.status, 502)
  const fine = sender()
  relay.open("port-req-9", { to: { kind: "port", port: served.port }, method: "GET", path: "/", headers: [] }, fine.made)
  await fine.finished
  assert.equal(decodePortHead(fine.sent[0]!).status, 201)
  await new Promise((resolve) => setImmediate(resolve))
  process.off("unhandledRejection", rejected)
  assert.equal(rejections, 0, "nothing escaped into the host")
  assert.deepEqual(served.asked.map((asked) => asked.url), ["/cookie", "/"])
  served.close()
})
