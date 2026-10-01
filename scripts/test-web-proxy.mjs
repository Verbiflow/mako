import assert from "node:assert/strict"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "vite"
import { isTrustedOrigin, trustedLocalOrigins, webHostProxy } from "../electron/web-dev-proxy.mjs"

// A loopback URL admits every loopback spelling of itself, nothing else.
assert.deepEqual(
  [...trustedLocalOrigins(["http://127.0.0.1:5173/"])].sort(),
  ["http://127.0.0.1:5173", "http://[::1]:5173", "http://localhost:5173"]
)
assert.deepEqual([...trustedLocalOrigins(["http://[::1]:5174/"])].sort(), [
  "http://127.0.0.1:5174",
  "http://[::1]:5174",
  "http://localhost:5174",
])
assert.deepEqual([...trustedLocalOrigins(["http://192.168.1.20:5173/"])], [
  "http://192.168.1.20:5173",
])
// A name under .localhost is the loopback page on the same port, and only that.
const local = trustedLocalOrigins(["http://127.0.0.1:5173/"])
assert.equal(isTrustedOrigin(local, "http://fix-login.thread.localhost:5173"), true)
for (const other of ["http://fix-login.thread.localhost:5174", "https://fix-login.thread.localhost:5173", "http://localhost.example:5173", "http://thread-localhost:5173", "null", undefined])
  assert.equal(isTrustedOrigin(local, other), false, `${other} is another page`)
assert.equal(isTrustedOrigin(trustedLocalOrigins(["http://192.168.1.20:5173/"]), "http://fix-login.thread.localhost:5173"), false)
import { startWebHost } from "../dist-electron/web-host.js"

const directory = await mkdtemp(join(tmpdir(), "mako-web-test-"))
const socket = join(directory, "host.sock")
const calls = []
const host = await startWebHost(
  socket,
  async (channel, args) => {
    calls.push({ channel, args })
    return JSON.stringify({ ok: true, value: args })
  },
  async (request) => {
    assert.equal(request.url, "mako-file://asset/fixture/signature")
    assert.equal(request.headers.get("range"), "bytes=0-3")
    return new Response("file", {
      status: 206,
      headers: { "content-type": "text/plain", "content-range": "bytes 0-3/4" },
    })
  }
)
const vite = await createServer({
  configFile: false,
  cacheDir: join(directory, "vite-cache"),
  plugins: [webHostProxy(socket)],
  server: { host: "127.0.0.1", port: 0 },
  logLevel: "silent",
})
const streamAbort = new AbortController()
try {
  await vite.listen()
  const origin = new URL(vite.resolvedUrls.local[0]).origin
  const headers = {
    origin,
    "sec-fetch-site": "same-origin",
    "x-mako-client": "web",
    "content-type": "application/json",
  }
  const body = JSON.stringify({
    channel: "mako:thread-page",
    args: [
      { kind: "value", value: "/thread" },
      { kind: "absent" },
      { kind: "value", value: 100 },
    ],
  })
  for (const invalid of [
    { ...headers, origin: "https://outside.example" },
    { ...headers, origin: origin.replace("127.0.0.1", "localhost").replace(/:\d+$/, ":1") },
    { ...headers, "sec-fetch-site": "cross-site" },
    { ...headers, "x-mako-client": "" },
  ]) {
    assert.equal(
      (
        await fetch(origin + "/__mako/rpc", {
          method: "POST",
          headers: invalid,
          body,
        })
      ).status,
      403
    )
  }
  const media = await fetch(origin + "/__mako/file/asset/fixture/signature", {
    headers: {
      referer: origin + "/",
      "sec-fetch-site": "same-origin",
      range: "bytes=0-3",
    },
  })
  assert.equal(media.status, 206)
  assert.equal(media.headers.get("content-range"), "bytes 0-3/4")
  assert.match(media.headers.get("content-security-policy"), /sandbox/)
  assert.equal(await media.text(), "file")
  assert.equal(calls.length, 0)
  assert.equal((await fetch(origin + "/__mako/rpc", { headers })).status, 403)
  const valid = await fetch(origin + "/__mako/rpc", {
    method: "POST",
    headers,
    body,
  })
  assert.equal(valid.status, 200)
  assert.deepEqual((await valid.json()).value, ["/thread", null, 100])
  // The tab a user types is `localhost:<port>`; it is the same page.
  const aliased = await fetch(origin + "/__mako/rpc", {
    method: "POST",
    headers: { ...headers, origin: origin.replace("127.0.0.1", "localhost") },
    body,
  })
  assert.equal(aliased.status, 200)
  const threadHost = await fetch(origin + "/__mako/rpc", {
    method: "POST",
    headers: { ...headers, origin: origin.replace("127.0.0.1", "fix-login.thread.localhost") },
    body,
  })
  assert.equal(threadHost.status, 200, "a Thread's own .localhost name reaches the host")
  assert.deepEqual(calls, [
    { channel: "mako:thread-page", args: ["/thread", undefined, 100] },
    { channel: "mako:thread-page", args: ["/thread", undefined, 100] },
    { channel: "mako:thread-page", args: ["/thread", undefined, 100] },
  ])
  assert.equal((await stat(socket)).mode & 0o777, 0o600)
  const response = await fetch(origin + "/__mako/events", {
    method: "POST",
    headers,
    signal: streamAbort.signal,
  })
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  assert.match((await reader.read()).value, /"ready"/)
  host.event({ type: "notice", level: "info", message: "Real event transport" })
  assert.match((await reader.read()).value, /Real event transport/)
  host.terminal({ type: "wake" })
  assert.match((await reader.read()).value, /"terminal"/)
  await reader.cancel()
  console.log(
    "Web gateway: same-origin-only requests, private socket permissions, optional argument fidelity, host and terminal streaming verified"
  )
} finally {
  streamAbort.abort()
  host.close()
  await vite.close()
  await rm(directory, { recursive: true, force: true })
}
