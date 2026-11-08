import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { join } from "node:path"
import { createRequire } from "node:module"
import { downloadElectron } from "./lib/ci-electron.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

const root = testScratch("mako-ci-downloads-")
const require = createRequire(import.meta.url)
const version = require("../package-lock.json").packages["node_modules/electron"].version
const filename = `electron-v${version}-${process.platform}-${process.arch}.zip`
const bytes = Buffer.from("a release archive fixture")
const sum = createHash("sha256").update(bytes).digest("hex")
const requests = new Map()
const server = createServer((request, response) => {
  const times = requests.get(request.url) ?? []
  times.push(Date.now())
  requests.set(request.url, times)
  if (request.url === "/missing") response.writeHead(404).end()
  else if (request.url === "/electron" && times.length <= 2) response.writeHead(504).end("planted 504")
  else response.end(bytes)
})
await new Promise((done) => server.listen(Number(process.env.TEST_DOWNLOAD_PORT ?? 0), "127.0.0.1", done))
const base = `http://127.0.0.1:${server.address().port}`
const details = (path, checksum = sum) => ({
  artifactName: "electron", version, platform: process.platform, arch: process.arch,
  checksums: { [filename]: checksum }, cacheRoot: join(root, path), tempDirectory: root,
  mirrorOptions: { resolveAssetURL: () => `${base}/${path}` },
})
try {
  const file = await downloadElectron(details("electron"))
  assert.deepEqual(await readFile(file), bytes)
  const times = requests.get("/electron")
  assert.equal(times.length, 3)
  assert.ok(times[1] - times[0] >= 900, "the first retry backs off for one second")
  assert.ok(times[2] - times[1] >= 1_800, "the second retry doubles the backoff")
  console.log("PASS: Electron's real downloader retried planted 504s after 1s and 2s, then verified the checksum")

  await assert.rejects(downloadElectron(details("missing")), /HTTP 404/)
  assert.equal(requests.get("/missing").length, 1, "a permanent 404 isn't retried")
  await assert.rejects(downloadElectron(details("altered", "0".repeat(64))), /checksum/i)
  assert.equal(requests.get("/altered").length, 1, "a bad checksum isn't retried")

  await new Promise((done) => server.close(done))
  assert.equal(await downloadElectron(details("electron")), file, "a verified cached archive works with its server offline")
  console.log("PASS: a cache hit needs no network; permanent HTTP and checksum failures remain fatal")
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
}
