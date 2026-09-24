import assert from "node:assert/strict"
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmod, mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import sharp from "sharp"
import { controlSessionBuild } from "../packages/control-runtime/dist/session.js"

// Inject successful envelopes whose command result cannot be consumed. The
// private endpoint counts dispatches independently of the CLI's error label.
const root = await mkdtemp(join(tmpdir(), "mako-cli-reply-"))
const socket = join(root, "s.sock"),
  file = join(root, "session.json")
let replyValue = null,
  dispatches = 0
const server = createServer(async (req, res) => {
  let body = ""
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  dispatches++
  res.setHeader("content-type", "application/json")
  res.end(
    JSON.stringify({
      ok: true,
      requestId: request.requestId,
      value: replyValue,
    })
  )
})
await new Promise((done) => server.listen(socket, done))
await chmod(socket, 0o600)
await writeFile(
  file,
  JSON.stringify({
    protocol: 1,
    build: await controlSessionBuild(),
    session: randomUUID(),
    socket,
    pid: process.pid,
  }),
  { mode: 0o600 }
)
const target = join(root, "target.json")
await writeFile(
  target,
  JSON.stringify({ kind: "window", pid: 123, window_id: 456 })
)
async function check(name, args, value) {
  replyValue = value
  const before = dispatches
  const child = spawn(
    process.execPath,
    [
      resolve("packages/control-runtime/dist/control-cli.js"),
      ...args,
      "--session-file",
      file,
    ],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (b) => (stdout += b))
  child.stderr.on("data", (b) => (stderr += b))
  child.stdin.end("return 1")
  const code = await new Promise((done, reject) => {
    child.once("error", reject)
    child.once("close", done)
  })
  const fault = JSON.parse(stderr)
  assert.equal(
    dispatches,
    before + 1,
    `${name}: exactly one dispatch, no replay`
  )
  assert.equal(
    code,
    4,
    `${name}: post-dispatch failure must have unknown outcome: ${stderr}`
  )
  assert.equal(fault.outcome, "unknown", name)
  assert.equal(stdout, "", `${name}: do not publish an unvalidated result`)
  assert.match(fault.message, /not replay|never replay/i)
  console.log(
    JSON.stringify({
      name,
      code,
      outcome: fault.outcome,
      dispatches: dispatches - before,
    })
  )
}
try {
  await check("malformed open", ["open", "--browser", "fixture"], null)
  await check(
    "malformed claim",
    ["claim", "--browser", "fixture", "--tab", "one"],
    { browser: "fixture" }
  )
  await check("malformed exec blocks", ["exec", "--source-file", "-"], [null])
  await check(
    "malformed recording receipt",
    ["record", "start", "--target-file", target],
    {}
  )
  const png = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  })
    .png()
    .toBuffer()
  await check(
    "failed image publication",
    [
      "shot",
      "--target-file",
      target,
      "--output",
      join(root, "missing-directory", "image.png"),
    ],
    { mimeType: "image/png", data: png.toString("base64") }
  )
  await check(
    "invalid image bytes",
    ["shot", "--target-file", target, "--output", join(root, "image.png")],
    { mimeType: "image/png", data: "not-an-image" }
  )
} finally {
  await new Promise((done) => server.close(done))
  await rm(root, { recursive: true, force: true })
}
