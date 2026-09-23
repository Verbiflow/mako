import { exerciseGestures } from "./wayland-gestures.mjs"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
const sharp = createRequire(import.meta.url)("sharp")
import { readFile, writeFile, stat } from "node:fs/promises"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
const exec = promisify(execFile)
let cover
const client = new Client({ name: "wayland-acceptance", version: "1" })
const evidence = { passed: false, calls: [] }
async function readState() {
  return JSON.parse(await readFile("/tmp/gnome-target.json", "utf8"))
}
async function until(fn) {
  const deadline = Date.now() + 15000
  do {
    const value = await fn().catch(() => null)
    if (value) return value
    await delay(100)
  } while (Date.now() < deadline)
  throw new Error("Wayland fixture did not become ready")
}
async function cell(source) {
  const start = performance.now()
  let response = await client.callTool(
    { name: "mako_control_exec", arguments: { source } },
    undefined,
    { timeout: 70000 }
  )
  for (;;) {
    const receipt = JSON.parse(
      response.content.find((item) => item.type === "text")?.text ?? "{}"
    )
    if (receipt.status !== "running") break
    response = await client.callTool(
      { name: "mako_control_exec", arguments: { cell: receipt.cell } },
      undefined,
      { timeout: 70000 }
    )
  }
  const result = JSON.parse(
    response.content.filter((item) => item.type === "text").at(-1).text
  )
  evidence.calls.push({
    source,
    result,
    milliseconds: performance.now() - start,
  })
  if (response.isError || (result.code && result.outcome)) throw Error(JSON.stringify(result))
  return result
}
try {
  const target = await until(readState)
  await until(() =>
    stat("/tmp/mako-driver.sock").then((value) => value.isSocket())
  )
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [
        "/repo/packages/control-runtime/dist/computer-tools-main.js",
        "--driver",
        process.env.MAKO_RECORDING_DRIVER,
        "--socket",
        "/tmp/mako-driver.sock",
      ],
      env: { ...process.env },
      stderr: "inherit",
    })
  )
  await until(async () => (await readState()).frames > 20)
  const windows = await cell(`return await control.windows(${target.pid});`)
  evidence.windows = windows
  const window =
    windows.windows?.find((item) =>
      item.title.startsWith("Mako GNOME target")
    ) ?? windows.find?.((item) => item.title.startsWith("Mako GNOME target"))
  assert.ok(window, "Compositor identifies the exact native Wayland window")
  await cell(
    `state.target={pid:${target.pid},window_id:${JSON.stringify(window.window_id ?? window.id)}};state.window=control.window(state.target);state.view=await state.window.observe();return state.view;`
  )
  evidence.gestures = await exerciseGestures({cell, readState, until, recordingDirectory:'/tmp/gnome-gestures', frameOrigin: async () => {
    const windows = JSON.parse((await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"])).stdout)
    const actual = windows.find(item => item.pid === target.pid && item.id === (window.window_id ?? window.id))
    assert.ok(actual && Number.isFinite(actual.buffer_x) && Number.isFinite(actual.buffer_y))
    return { x: actual.x - actual.buffer_x, y: actual.y - actual.buffer_y }
  }});
  const value = "GNOME exact — 日本語 🧪 é"
  await cell(
    `return await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(value)});`
  )
  evidence.afterValue = await until(async () => {
    const state = await readState()
    return state.text === value ? state : null
  })
  evidence.visibleCapture = await cell(
    "try {const image=await state.window.screenshot({screenshot_out_file:'/tmp/gnome-visible.png'});return {status:'captured',keys:Object.keys(image)};} catch(error) {return {status:'refused',message:error.message};}"
  )
  cover = spawn(
    "python3",
    [
      "/repo/scripts/linux-control/recording-fixture.py",
      "Human work",
      "/tmp/gnome-cover.json",
      "ba3084",
    ],
    { stdio: "ignore" }
  )
  const coverState = await until(async () =>
    JSON.parse(await readFile("/tmp/gnome-cover.json", "utf8"))
  )
  const coverWindow = await until(async () =>
    JSON.parse(
      (await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"]))
        .stdout
    ).find((node) => node.pid === coverState.pid)
  )
  evidence.coverActivation = await cell(
    `return await control.native('bring_to_front',{pid:${coverState.pid},window_id:${coverWindow.id},foreground:true});`
  )
  await until(async () =>
    JSON.parse(
      (await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"]))
        .stdout
    ).some((node) => node.pid === coverState.pid && node.focused)
  )
  evidence.coveredCapture = await cell(
    "const image=await state.window.screenshot({screenshot_out_file:'/tmp/gnome-covered.png'});return {status:'captured',keys:Object.keys(image)};"
  )
  const image = sharp("/tmp/gnome-covered.png")
  const dimensions = await image.metadata()
  assert.equal(dimensions.width, window.bounds.width)
  assert.equal(dimensions.height, window.bounds.height)
  const sample = await image
    .extract({ left: 400, top: 300, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer()
  assert.deepEqual(
    [...sample],
    [43, 95, 143],
    "Covered capture contains the blue target, not the pink foreground window"
  )
  evidence.coveredPixel = [...sample]
  evidence.coveredDimensions = {
    width: dimensions.width,
    height: dimensions.height,
  }
  const afterCapture = JSON.parse(
    (await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"]))
      .stdout
  )
  assert.equal(
    afterCapture.find((node) => node.pid === coverState.pid).focused,
    true,
    "Capture does not activate its target"
  )
  await cell(
    "state.video=await state.window.record({directory:'/tmp/gnome-recording',maxDurationMs:30000});return state.video;"
  )
  const changedText = "Covered capture is current — 東京 42"
  await cell(
    `return await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(changedText)});`
  )
  await until(async () => (await readState()).text === changedText)
  await cell(
    "await state.window.screenshot({screenshot_out_file:'/tmp/gnome-covered-changed.png'});return true;"
  )
  const beforeText = await sharp("/tmp/gnome-covered.png")
    .extract({ left: 0, top: 37, width: 640, height: 34 })
    .raw()
    .toBuffer()
  const afterText = await sharp("/tmp/gnome-covered-changed.png")
    .extract({ left: 0, top: 37, width: 640, height: 34 })
    .raw()
    .toBuffer()
  assert.notDeepEqual(
    afterText,
    beforeText,
    "The covered window text repaints after the background write"
  )
  await delay(800)
  await cell("return await state.video.stop();")
  evidence.video = await until(async () => {
    const value = await cell("return await state.video.status();")
    return value.status === "finalizing" ? null : value
  })
  assert.equal(evidence.video.status, "finished", evidence.video.error)
  const probe = JSON.parse(
    (
      await exec("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        evidence.video.video,
      ])
    ).stdout
  )
  evidence.videoProbe = probe
  assert.equal(probe.streams[0].width, Math.ceil(dimensions.width / 2) * 2)
  assert.equal(probe.streams[0].height, Math.ceil(dimensions.height / 2) * 2)
  assert.ok(Number(probe.format.duration) > 0.5)
  await exec("ffmpeg", [
    "-v",
    "error",
    "-ss",
    "0.3",
    "-i",
    evidence.video.video,
    "-frames:v",
    "1",
    "/tmp/gnome-video-frame.png",
  ])
  const videoPixel = await sharp("/tmp/gnome-video-frame.png")
    .extract({ left: 400, top: 300, width: 1, height: 1 })
    .removeAlpha()
    .raw()
    .toBuffer()
  assert.ok(
    [...videoPixel].every(
      (value, index) => Math.abs(value - [43, 95, 143][index]) < 8
    ),
    "Video retains the covered target pixels"
  )
  await cell(
    "state.earlyVideo=await state.window.record({directory:'/tmp/gnome-recording',maxDurationMs:30000});return state.earlyVideo;"
  )
  await delay(700)
  await writeFile("/tmp/gnome-target.json.command", "minimize")
  await until(
    async () =>
      JSON.parse(
        (await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"]))
          .stdout
      ).find((node) => node.pid === target.pid)?.minimized
  )
  evidence.hiddenJobs = []
  for (let index = 0; index < 10; index++) {
    const text = `Hidden GNOME ${index} — 日本語 🧪 é`
    await cell(
      `return await state.window.locator({role:'TextArea',name:'Exact text'}).setValue(${JSON.stringify(text)});`
    )
    const actual = await until(async () => {
      const state = await readState()
      return state.text === text ? state : null
    })
    const tree = JSON.parse(
      (await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"]))
        .stdout
    )
    const targetNode = tree.find((node) => node.pid === target.pid)
    const foreground = tree.find((node) => node.pid === coverState.pid)
    assert.equal(targetNode.minimized, true, "Target remains minimized")
    assert.equal(
      foreground.focused,
      true,
      "Human window retains compositor focus"
    )
    evidence.hiddenJobs.push({
      text: actual.text,
      targetVisible: targetNode.visible,
      coverFocused: foreground.focused,
    })
  }
  evidence.earlyVideo = await until(async () => {
    const value = await cell("return await state.earlyVideo.status();")
    return ["recording", "finalizing"].includes(value.status) ? null : value
  })
  assert.equal(
    evidence.earlyVideo.status,
    "interrupted",
    evidence.earlyVideo.error
  )
  assert.ok(
    evidence.earlyVideo.video,
    "Minimization retains the partial recording"
  )
  await exec("ffprobe", ["-v", "error", evidence.earlyVideo.video])
  evidence.hiddenCapture = await cell(
    "try {await state.window.screenshot();return {status:'captured'};} catch(error) {return {status:'refused',message:error.message};}"
  )
  assert.equal(
    evidence.hiddenCapture.status,
    "refused",
    "Hidden window capture must not return unrelated desktop pixels"
  )
  assert.match(evidence.hiddenCapture.message, /capture|visible|window|scope/i)
  evidence.recording = await cell(
    "try {state.recording=await state.window.record({directory:'/tmp/wayland-recording'});await state.recording.stop();return {status:'started'};} catch(error) {return {status:'refused',message:error.message};}"
  )
  assert.equal(
    evidence.recording.status,
    "refused",
    "Unsupported exact-window recording refuses before desktop capture"
  )
  evidence.compositor = JSON.parse(
    (await exec("python3", ["/repo/scripts/linux-control/gnome-state.py"]))
      .stdout
  )
  evidence.passed = true
} catch (error) {
  evidence.error = error.message
  process.exitCode = 1
} finally {
  await client.close().catch(() => {})
  cover?.kill()
  await writeFile(
    "/tmp/gnome-evidence.json",
    JSON.stringify(evidence, null, 2) + "\n"
  )
  console.log(
    JSON.stringify({
      passed: evidence.passed,
      error: evidence.error,
      hiddenJobs: evidence.hiddenJobs?.length,
    })
  )
}
