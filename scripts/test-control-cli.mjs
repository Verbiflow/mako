import assert from "node:assert/strict"
import sharp from "sharp"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createControlSession, serveControlSession } from "../packages/control-runtime/dist/session.js"
import { BrowserService } from "../packages/control-runtime/dist/browser-service.js"
import { browserFixture } from "./browser-control-fixture.ts"

const cli = resolve("packages/control-runtime/dist/control-cli.js")
const directory = await mkdtemp(join(tmpdir(), "mako-cli-proof-"))
const fixture = await browserFixture()
const browsers = new BrowserService([fixture.definition])
const browserCall = (command, signal) =>
  browsers.execute("cli-proof", command, signal)
browserCall.close = () =>
  browsers.releaseOwner("cli-proof", { finalizeRecordings: true })
const session = createControlSession(undefined, "cli-proof", undefined, {
  surface: "control",
  browserCall,
})
const server = await serveControlSession(session)
const started = performance.now()
const timings = []
let sessionFile = server.file
async function command(args, { stdin, code = 0, partial = false } = {}) {
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
  if (partial) {
    assert.ok(stdout, `A failed exec prints what its earlier steps emitted: ${stderr}`)
    return { output: JSON.parse(stdout), fault: JSON.parse(stderr) }
  }
  assert.equal(stdout, "")
  return JSON.parse(stderr)
}
try {
  assert.ok(sessionFile)
  assert.ok(await command(["api"]))
  assert.equal((await stat(sessionFile)).mode & 0o777, 0o600)
  await command(["connect", "--browser", "fixture"])
  const opened = await command(["open", "--browser", "fixture"])
  const { target } = opened
  assert.deepEqual(opened, { target, url: "about:blank", title: target.tab },
    "open reports where the new tab is")
  const targetFile = join(directory, "exact target.json")
  await writeFile(targetFile, JSON.stringify(opened))
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
  const invalidRead = await command(
    ["observe", "--target-file", targetFile, "--input", "-"],
    {
      stdin: JSON.stringify({ max: "ten" }),
      code: 2,
    }
  )
  assert.equal(invalidRead.code, "invalid-request")
  assert.equal(invalidRead.outcome, "not-dispatched")
  const invalidScript = await command(["exec", "--source-file", "-"], {
    stdin: `return await control.tab(${JSON.stringify(target)}).observe({max:'ten'})`,
    code: 2,
  })
  assert.equal(invalidScript.code, "invalid-request")
  assert.equal(invalidScript.outcome, "not-dispatched")
  assert.match(invalidScript.message, /observe/)
  const unparsed = await command(["exec", "--source-file", "-"], {
    stdin: `await control.tab(${JSON.stringify(target)}).observe()\nreturn (1`,
    code: 2,
  })
  assert.deepEqual([unparsed.code, unparsed.outcome], ["syntax-error", "not-dispatched"])
  assert.match(unparsed.message, /did not run/)
  const imageFile = join(directory, "capture with spaces.png")
  const image = await command([
    "shot",
    "--format",
    "png",
    "--target-file",
    targetFile,
    "--output",
    imageFile,
  ])
  assert.equal(image.path, imageFile)
  assert.ok(image.width > 0 && image.height > 0)
  assert.equal("data" in image, false)
  assert.equal(image.bytes, (await stat(imageFile)).size)
  assert.equal(
    fixture.calls.findLast((call) => call.method === "Page.captureScreenshot")
      .params.format,
    "png"
  )
  const invalidFormat = await command(
    [
      "shot",
      "--target-file",
      targetFile,
      "--format",
      "gif",
      "--output",
      join(directory, "invalid.gif"),
    ],
    { code: 2 }
  )
  assert.equal(invalidFormat.outcome, "not-dispatched")
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
  await command(["exec", "--source-file", "-"], {stdin: 'state.shared = "東京 🧪"; return state.shared'})
  const shared = await command(["exec", "--source-file", "-"], {
    stdin:
      "state.count = (state.count ?? 0) + 1; return {shared:state.shared,count:state.count}",
  })
  assert.deepEqual(shared.at(-1).value, { shared: "東京 🧪", count: 1 })
  assert.equal(
    (await command(["exec", "--source-file", "-"], {stdin: "return state.count"})).at(-1).value,
    1
  )
  const imageResult = await command(["exec", "--source-file", "-"], {
    stdin: `emitImage(await control.tab(${JSON.stringify(opened)}).screenshot())`,
  })
  assert.ok(!JSON.stringify(imageResult).includes("base64"))
  const artifact = imageResult.find((block) => block.value?.path)?.value
  assert.ok(artifact, JSON.stringify(imageResult))
  assert.ok((await stat(artifact.path)).size > 0)
  const failedLate = await command(["exec", "--source-file", "-"], {
    stdin: `const tab = control.tab(${JSON.stringify(target)}); console.log("before"); emitImage(await tab.screenshot()); await tab.observe({max:'ten'})`,
    code: 2,
    partial: true,
  })
  assert.equal(failedLate.fault.code, "invalid-request")
  assert.equal(failedLate.fault.outcome, "not-dispatched")
  assert.match(failedLate.fault.message, /observe[\s\S]*Output emitted before the failure is on stdout/)
  assert.deepEqual(failedLate.output[0], { type: "result", value: "before" },
    "A later failure keeps earlier console output")
  const lateImage = failedLate.output.find((block) => block.value?.path)?.value
  assert.ok(lateImage && (await stat(lateImage.path)).size > 0, "and saves its earlier image")
  assert.ok(!JSON.stringify(failedLate.output).includes("base64"))
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
    (await command(["exec", "--source-file", "-"], {stdin: "return state.pipeWrites"})).at(-1).value,
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
  const inputs = () =>
    fixture.calls.filter((call) => call.method.startsWith("Input.")).length
  const typed = await command(
    ["act", "--target-file", targetFile, "--role", "textbox", "--name", "Proof", "--input", "-"],
    { stdin: '{"kind":"set-text","text":"Ada"}' }
  )
  assert.equal(typed.status, "dispatched", JSON.stringify(typed))
  const quiet = inputs()
  const css = 'section button:has-text("Generate")'
  const cssRefusal = await command(["act", "--target-file", targetFile, "--input", "-"], {
    stdin: JSON.stringify({ kind: "activate", selector: css }),
    code: 2,
  })
  assert.equal(cssRefusal.outcome, "not-dispatched")
  assert.ok(cssRefusal.message.startsWith(`${JSON.stringify(css)} is a CSS or text selector`), cssRefusal.message)
  assert.match(cssRefusal.message, /\{query:"Generate",interactive:true\}/,
    "A quoted label becomes the query to observe with")
  const bare = await command(["act", "--target-file", targetFile, "--input", "-"], {
    stdin: JSON.stringify({ kind: "activate", selector: { css: "section button" } }),
    code: 2,
  })
  assert.match(bare.message, /^"section button" is a CSS[^]*Observe with \{interactive:true\}/)
  const scrollBySelector = await command(["act", "--target-file", targetFile, "--input", "-"], {
    stdin: JSON.stringify({ kind: "scroll", deltaY: 10, selector: { role: "textbox", name: "Proof" } }),
    code: 2,
  })
  assert.match(scrollBySelector.message, /scroll takes a ref or coordinates/)
  assert.match(
    (await command(["act", "--target-file", targetFile, "--role", "textbox", "--input", "-"], {
      stdin: '{"kind":"activate"}',
      code: 2,
    })).message,
    /Pass both --role and --name/
  )
  assert.equal(inputs(), quiet, "Refused selectors dispatch nothing")
  fixture.axNodes[0].value = { value: "Ada" }
  const met = await command(["expect", "--target-file", targetFile, "--input", "-"], {
    stdin: JSON.stringify({ role: "textbox", name: "Proof", value: "Ada", timeoutMs: 0 }),
  })
  assert.equal(met.status, "matched", JSON.stringify(met))
  const unmet = await command(
    ["expect", "--target-file", targetFile, "--role", "textbox", "--name", "Proof", "--input", "-"],
    { stdin: '{"value":"Grace","timeoutMs":0}', code: 5 }
  )
  assert.deepEqual([unmet.code, unmet.outcome], ["assertion-failed", "not-dispatched"])
  delete fixture.axNodes[0].value
  assert.equal(inputs(), quiet, "Assertions never dispatch input")
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
  // Opened before the held stop: capture stop times out after 2 s.
  const peer = await command(["open", "--browser", "fixture"])
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
  await command(["close", "--target-file", "-"], { stdin: JSON.stringify(peer) })
  assert.equal(fixture.targets.has(peer.target.tab), false, "close closes the exact tab")
  assert.equal(
    (await command(["observe", "--target-file", "-"], { stdin: JSON.stringify(peer), code: 3 })).code,
    "target-closed"
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
  await server.close()
  browsers.close()
  await fixture.close()
  await rm(directory, { recursive: true, force: true })
}
