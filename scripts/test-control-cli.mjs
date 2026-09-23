import assert from "node:assert/strict"
import sharp from "sharp"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createComputerToolsServer } from "../dist-electron/computer-tools-main.js"
import { BrowserService } from "../dist-electron/browser-service.js"
import { browserFixture } from "./browser-control-fixture.ts"

const cli = resolve("dist-electron/control-cli.js")
const directory = await mkdtemp(join(tmpdir(), "mako-cli-proof-"))
const fixture = await browserFixture()
const browsers = new BrowserService([fixture.definition])
const browserCall = (command, signal) =>
  browsers.execute("cli-proof", command, signal)
browserCall.close = () =>
  browsers.releaseOwner("cli-proof", { finalizeRecordings: true })
const server = createComputerToolsServer(undefined, "cli-proof", undefined, {
  surface: "control",
  cli: true,
  browserCall,
})
const client = new Client({ name: "cli-proof", version: "1" })
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
await server.connect(serverTransport)
await client.connect(clientTransport)
const value = (reply) => {
  assert.ok(!reply.isError, JSON.stringify(reply))
  return JSON.parse(reply.content.find((block) => block.type === "text").text)
}
const started = performance.now()
const timings = []
let sessionFile
async function command(args, { stdin, code = 0 } = {}) {
  const before = performance.now()
  const child = spawn(
    process.execPath,
    [cli, ...args, "--session-file", sessionFile],
    { cwd: directory, stdio: ["pipe", "pipe", "pipe"] }
  )
  let stdout = "",
    stderr = ""
  child.stdout.on("data", (bytes) => {
    stdout += bytes
  })
  child.stderr.on("data", (bytes) => {
    stderr += bytes
  })
  child.stdin.end(stdin)
  const exit = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", resolve)
  })
  timings.push({ command: args[0], ms: Math.round(performance.now() - before) })
  assert.equal(exit, code, `${args.join(" ")}: ${stderr}\n${stdout}`)
  if (code === 0) {
    assert.equal(stderr, "")
    return JSON.parse(stdout)
  }
  assert.equal(stdout, "")
  return JSON.parse(stderr)
}
try {
  sessionFile = value(
    await client.callTool({ name: "mako_control_status", arguments: {} })
  ).sessionFile
  assert.ok(sessionFile)
  assert.ok(await command(["help"]))
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600)
  await command(["connect", "--browser", "fixture"])
  const target = await command(["open", "--browser", "fixture"])
  const targetFile = join(directory, "exact target.json")
  await writeFile(targetFile, JSON.stringify(target))
  assert.equal(target.kind, "page")
  assert.equal(fixture.connections(), 1)
  const observation = await command(["observe", "--target-file", "-"], {
    stdin: JSON.stringify(target),
  })
  assert.ok(observation)
  assert.equal(
    fixture.calls.filter((call) => call.method === "Page.captureScreenshot")
      .length,
    0,
    "Text commands never capture images"
  )
  const imageFile = join(directory, "capture with spaces.png")
  const image = await command([
    "shot",
    "--target-file",
    targetFile,
    "--output",
    imageFile,
  ])
  assert.equal(image.path, imageFile)
  assert.ok(image.width > 0 && image.height > 0)
  assert.equal("data" in image, false)
  assert.equal(image.bytes, (await stat(imageFile)).size)
  const captures = () =>
    fixture.calls.filter((call) => call.method === "Page.captureScreenshot")
      .length
  const captured = captures()
  assert.equal(
    (
      await command(
        ["shot", "--target-file", targetFile, "--output", imageFile],
        { code: 2 }
      )
    ).code,
    "output-exists"
  )
  assert.equal(captures(), captured, "Refuse existing output before capture")
  value(
    await client.callTool({
      name: "mako_control_exec",
      arguments: { source: 'state.shared = "東京 🧪"; return state.shared' },
    })
  )
  const shared = await command(["exec", "--source-file", "-"], {
    stdin:
      "state.count = (state.count ?? 0) + 1; return {shared:state.shared,count:state.count}",
  })
  assert.deepEqual(shared.at(-1).value, { shared: "東京 🧪", count: 1 })
  assert.equal(
    value(
      await client.callTool({
        name: "mako_control_exec",
        arguments: { source: "return state.count" },
      })
    ),
    1
  )
  const imageResult = await command(["exec", "--source-file", "-"], {
    stdin: `emitImage(await control.tab(${JSON.stringify(target)}).screenshot())`,
  })
  assert.ok(!JSON.stringify(imageResult).includes("base64"))
  const artifact = imageResult.find((block) => block.value?.path)?.value
  assert.ok(artifact, JSON.stringify(imageResult))
  assert.ok((await stat(artifact.path)).size > 0)
  const staleImage = await command(
    ["act", "--target-file", targetFile, "--input", "-"],
    {
      stdin: JSON.stringify({
        kind: "pointer",
        at: { x: 10, y: 10, view: image.view },
      }),
      code: 3,
    }
  )
  assert.equal(staleImage.code, "stale-view")
  assert.equal(staleImage.outcome, "not-dispatched")
  const broken = spawn(
    process.execPath,
    [cli, "exec", "--session-file", sessionFile, "--source-file", "-"],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
  let pipeError = ""
  broken.stderr.on("data", (bytes) => {
    pipeError += bytes
  })
  const pipeExit = new Promise((resolve) => broken.once("exit", resolve))
  broken.stdout.destroy()
  broken.stdin.end(
    "state.pipeWrites = (state.pipeWrites ?? 0) + 1; return state.pipeWrites"
  )
  assert.equal(await pipeExit, 4, pipeError)
  assert.equal(JSON.parse(pipeError).outcome, "unknown")
  assert.equal(
    value(
      await client.callTool({
        name: "mako_control_exec",
        arguments: { source: "return state.pipeWrites" },
      })
    ),
    1
  )
  assert.equal(
    (
      await command(["act", "--target-file", targetFile, "--input", "-"], {
        stdin: '{"kind":"made-up"}',
        code: 2,
      })
    ).outcome,
    "not-dispatched"
  )
  const diagnostics = await command(["diagnostics"])
  assert.ok(diagnostics.requests.some((request) => request.method === "exec"))
  assert.ok(
    diagnostics.commands.some((command) => command.action === "capture")
  )
  assert.ok(!JSON.stringify(diagnostics).includes("東京"))
  const original = sessionFile
  const descriptor = JSON.parse(await readFile(original, "utf8"))
  sessionFile = join(directory, "mismatched.json")
  await writeFile(
    sessionFile,
    JSON.stringify({ ...descriptor, build: "0".repeat(64) }),
    { mode: 0o600 }
  )
  assert.equal(
    (await command(["status"], { code: 3 })).code,
    "incompatible-session"
  )
  await writeFile(
    sessionFile,
    JSON.stringify({
      ...descriptor,
      session: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
    })
  )
  assert.equal(
    (await command(["status"], { code: 3 })).code,
    "incompatible-session"
  )
  sessionFile = original
  // Closing a client in the middle of a dispatched operation preserves recovery.
  const delayed = spawn(
    process.execPath,
    [cli, "exec", "--session-file", sessionFile, "--source-file", "-"],
    { stdio: ["pipe", "pipe", "pipe"] }
  )
  let cancellation = ""
  delayed.stderr.on("data", (bytes) => {
    cancellation += bytes
  })
  delayed.stdout.resume()
  const exited = new Promise((resolve) => delayed.once("exit", resolve))
  delayed.stdin.end(
    `await control.tab(${JSON.stringify(target)}).cdp('Input.insertText',{text:'delay'});`
  )
  const deadline = Date.now() + 10000
  while (
    !fixture.calls.some(
      (call) =>
        call.method === "Input.insertText" && call.params.text === "delay"
    )
  ) {
    assert.ok(Date.now() < deadline, "Delayed action reached fixture")
    await delay(10)
  }
  delayed.kill("SIGINT")
  assert.equal(await exited, 130, cancellation)
  assert.equal(JSON.parse(cancellation).outcome, "unknown")
  fixture.completeDelayed()
  const uncertain = await command(["exec", "--source-file", "-"], {
    stdin: `await control.tab(${JSON.stringify(target)}).cdp('Input.insertText',{text:'must-not-run'});`,
    code: 3,
  })
  assert.equal(uncertain.outcome, "not-dispatched")
  assert.equal(uncertain.code, "observation-required")
  assert.ok(!fixture.calls.some((call) => call.params.text === "must-not-run"))
  await command(["observe", "--target-file", targetFile])
  await command(["exec", "--source-file", "-"], {
    stdin: `await control.tab(${JSON.stringify(target)}).cdp('Input.insertText',{text:'reconciled'});`,
  })
  assert.equal(
    fixture.calls.filter((call) => call.params.text === "reconciled").length,
    1
  )
  // Finalization belongs to the session, not the shell waiting for its result.
  fixture.setRecordingFrame(
    (
      await sharp({
        create: { width: 640, height: 480, channels: 3, background: "#395060" },
      })
        .jpeg()
        .toBuffer()
    ).toString("base64")
  )
  const recording = await command([
    "record",
    "start",
    "--target-file",
    targetFile,
    "--directory",
    join(directory, "recordings"),
  ])
  const receiptFile = join(directory, "recording.json")
  await writeFile(receiptFile, JSON.stringify(recording))
  fixture.holdNextRecordingStop()
  const waiter = spawn(
    process.execPath,
    [
      cli,
      "record",
      "stop",
      "--input",
      receiptFile,
      "--wait",
      "--session-file",
      sessionFile,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  let waiterError = ""
  waiter.stdout.resume()
  waiter.stderr.on("data", (bytes) => {
    waiterError += bytes
  })
  const waiterExit = new Promise((resolve) => waiter.once("exit", resolve))
  const stoppingDeadline = Date.now() + 10000
  while (!fixture.calls.some((call) => call.method === "Page.stopScreencast")) {
    assert.ok(
      Date.now() < stoppingDeadline,
      "Stop reached capture before cancellation"
    )
    await delay(10)
  }
  waiter.kill("SIGINT")
  assert.equal(await waiterExit, 130, waiterError)
  const pending = await command(["record", "status", "--input", receiptFile])
  assert.equal(pending.status, "finalizing")
  // Stop is idempotent and unrelated reads/programs remain usable while the
  // capture transport is still stopping, without waiting for video encoding.
  assert.equal(
    (await command(["record", "stop", "--input", receiptFile])).id,
    recording.id
  )
  const peer = await command(["open", "--browser", "fixture"])
  await command(["observe", "--target-file", "-"], {
    stdin: JSON.stringify(peer),
  })
  const concurrent = await Promise.all(
    Array.from({ length: 4 }, () =>
      command(["exec", "--source-file", "-"], {
        stdin:
          "state.concurrent=(state.concurrent??0)+1;return state.concurrent",
      })
    )
  )
  assert.deepEqual(
    concurrent.map((result) => result.at(-1).value).sort(),
    [1, 2, 3, 4]
  )
  fixture.completeRecordingStop()
  const finished = await command([
    "record",
    "stop",
    "--input",
    receiptFile,
    "--wait",
  ])
  assert.equal(finished.status, "finished", JSON.stringify(finished))
  assert.ok((await stat(finished.video)).size > 0)
  assert.equal(
    fixture.calls.filter((call) => call.method === "Page.stopScreencast")
      .length,
    1,
    "Waiter cancellation and repeated stop never repeat capture shutdown"
  )
  await command(["session", "stop"])
  assert.equal(
    fixture.targets.size,
    0,
    "Stopping shared engine releases owned task tabs"
  )
  assert.equal((await command(["status"], { code: 3 })).code, "invalid-session")
  console.log(
    JSON.stringify({
      passed: true,
      ms: Math.round(performance.now() - started),
      timings,
    })
  )
} finally {
  await client.close()
  await server.close()
  browsers.close()
  await fixture.close()
  await rm(directory, { recursive: true, force: true })
}
