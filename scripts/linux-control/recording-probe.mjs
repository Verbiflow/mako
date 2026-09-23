import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { setTimeout as delay } from "node:timers/promises"
const execute = promisify(execFile)
const read = async (path) => JSON.parse(await readFile(path, "utf8"))
for (let i = 0; i < 100; i++) {
  if (await read("/tmp/record-target.json").catch(() => null)) break
  await delay(50)
}
const target = await read("/tmp/record-target.json")
const client = new Client({ name: "recording-acceptance", version: "1" })
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [
      "/repo/packages/control-runtime/dist/computer-tools-main.js",
      "--driver",
      process.env.MAKO_RECORDING_DRIVER ?? "/target/debug/cua-driver",
      "--socket",
      "/tmp/mako-driver.sock",
    ],
    env: { ...process.env },
    stderr: "inherit",
  })
)
const receipts = []
async function cell(source) {
  let result = await client.callTool(
    { name: "mako_control_exec", arguments: { source } },
    undefined,
    { timeout: 70_000 }
  )
  for (;;) {
    const first = JSON.parse(
      result.content.find((b) => b.type === "text")?.text ?? "{}"
    )
    if (first.status !== "running") break
    result = await client.callTool(
      { name: "mako_control_exec", arguments: { cell: first.cell } },
      undefined,
      { timeout: 70_000 }
    )
  }
  const value = JSON.parse(
    result.content.filter((b) => b.type === "text").at(-1).text
  )
  if (result.isError || value.code) throw Error(JSON.stringify(value))
  receipts.push({ source, value })
  return value
}
let cover
try {
  let window
  const windowDeadline = Date.now() + 10000
  do {
    const windows = await cell(
      `return await control.native('list_windows',{pid:${target.pid}})`
    )
    window = windows.windows.find((w) => w.title === "Mako record target")
    if (window) break
    await delay(100)
  } while (Date.now() < windowDeadline)
  if (!window) {
    await cell("return await control.native('list_windows',{})")
    const diagnostics=await execute('xprop',['-root','_NET_CLIENT_LIST','_NET_CLIENT_LIST_STACKING']).catch(error=>({stdout:error.message}))
    await writeFile('/evidence/window-discovery.json',JSON.stringify({target,current:await read('/tmp/record-target.json'),root:diagnostics.stdout,tree:(await execute('xwininfo',['-root','-tree']).catch(error=>({stdout:error.message}))).stdout},null,2))
  }
  assert.ok(window, "Fixture window is registered before recording")
  await cell(
    `state.window=control.window({pid:${target.pid},window_id:${window.window_id}});state.recording=await state.window.record({directory:'/evidence',name:'Occluded Linux window',maxDurationMs:30000});return state.recording;`
  )
  cover = spawn(
    "python3",
    [
      "/repo/scripts/linux-control/recording-fixture.py",
      "User cover",
      "/tmp/record-cover.json",
      "ba3084",
    ],
    { stdio: "ignore" }
  )
  for (let i = 0; i < 100; i++) {
    if (await read("/tmp/record-cover.json").catch(() => null)) break
    await delay(50)
  }
  const coverPid = (await read("/tmp/record-cover.json")).pid
  const observed = await cell("return await state.window.observe()")
  await writeFile(
    "/evidence/observation.json",
    JSON.stringify(observed, null, 2)
  )
  const foreground = []
  for (let i = 0; i < 10; i++) {
    await cell(
      `await state.window.locator({role:'TextArea',name:'Exact text'}).setValue('record-${i} 東京');return true;`
    )
    let actual
    const deadline = Date.now() + 3000
    do {
      actual = await read("/tmp/record-target.json")
      if (actual.text === `record-${i} 東京`) break
      await delay(25)
    } while (Date.now() < deadline)
    assert.equal(actual.text, `record-${i} 東京`)
    foreground.push((await read("/tmp/record-cover.json")).active)
    await delay(150)
  }
  assert.ok(foreground.every(Boolean), "The covering user window retains focus")
  if (process.env.MAKO_GESTURE_ACCEPTANCE === "1") {
    const refusal = await cell("try {await state.window.raw('drag',{from_x:100,from_y:180,to_x:330,to_y:230,steps:20,duration_ms:400});return {status:'dispatched'};} catch(error) {return {status:'refused',message:error.message};}")
    assert.equal(refusal.status, "refused", "This GTK/Xvfb backend must declare its foreground requirement")
    await writeFile("/evidence/background-drag.json", JSON.stringify(refusal, null, 2))
    await cell("return await state.window.observe();")
    await cell("return await state.window.raw('bring_to_front',{foreground:true});")
    await cell("return await state.window.raw('drag',{from_x:100,from_y:180,to_x:330,to_y:230,steps:20,duration_ms:400,delivery_mode:'foreground',foreground:true});")
    await cell("return await state.window.raw('scroll',{x:250,y:190,direction:'down',amount:3,delivery_mode:'foreground',foreground:true});")
    await delay(100)
    const gestures = await read("/tmp/record-target.json")
    assert.ok(gestures.points.some(point => point.kind === "down") && gestures.points.some(point => point.kind === "up"), "Target receives both ends of the drag")
    assert.ok(gestures.points.filter(point => point.kind === "move").length >= 10, "Target receives the drag path")
    assert.ok(gestures.points.some(point => point.kind === "scroll"), "Target receives scrolling")
    const coverWindows = await cell(`return await control.windows(${coverPid});`)
    await cell(`return await control.native('bring_to_front',{pid:${coverPid},window_id:${coverWindows.windows[0].window_id},foreground:true});`)
    const restoreDeadline = Date.now() + 3000
    while (!(await read("/tmp/record-cover.json")).active && Date.now() < restoreDeadline) await delay(25)
    assert.equal((await read("/tmp/record-cover.json")).active, true, "The controlled foreground phase restores the covering fixture")
    await writeFile("/evidence/gesture-oracle.json", JSON.stringify(gestures, null, 2))
  }
  await cell("return await state.recording.stop()")
  let result
  for (let i = 0; i < 300; i++) {
    result = await cell("return await state.recording.status()")
    if (result.status !== "finalizing") break
    await delay(100)
  }
  assert.equal(result.status, "finished", result.error)
  if (process.env.MAKO_GESTURE_ACCEPTANCE === "1") {
    const timeline = await read(result.timeline)
    assert.ok(timeline.pointer.length >= 22, "Recording retains the dispatched drag path")
    assert.ok(new Set(timeline.pointer.map(point => Math.round(point.x))).size >= 15, "Cursor covers the dispatched gesture")
    const oracle = await read("/evidence/gesture-oracle.json")
    const down = oracle.points.find(point => point.kind === "down")
    const point = timeline.pointer.find(point => point.pressed)
    const pressIndex = timeline.pointer.indexOf(point)
    const releaseIndex = timeline.pointer.findIndex((sample, index) => index > pressIndex && !sample.pressed)
    assert.ok(pressIndex >= 0 && releaseIndex - pressIndex >= 21, "Recorded button stays held throughout the drag")
    const probe = JSON.parse((await execute("ffprobe", ["-v", "error", "-show_streams", "-of", "json", result.video])).stdout)
    assert.ok(Math.abs(point.x / probe.streams[0].width - down.window_x / oracle.width) < 0.005, "Recorded horizontal position matches the app's actual event")
    assert.ok(Math.abs(point.y / probe.streams[0].height - down.window_y / oracle.height) < 0.005, "Recorded vertical position matches the app's actual event")
  }
  const decoded = `${result.directory}/decoded.png`
  await execute("ffmpeg", [
    "-v",
    "error",
    "-sseof",
    "-0.5",
    "-i",
    result.video,
    "-frames:v",
    "1",
    decoded,
  ])
  const pixels = await execute(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      decoded,
      "-vf",
      "crop=1:1:300:250,format=rgb24",
      "-f",
      "rawvideo",
      "pipe:1",
    ],
    { encoding: "buffer" }
  )
  const [r, g, b] = pixels.stdout
  assert.ok(
    Math.abs(r - 43) < 10 && Math.abs(g - 95) < 10 && Math.abs(b - 143) < 10,
    `Expected blue target, not purple cover: ${[r, g, b]}`
  )
  const probe = JSON.parse(
    (
      await execute("ffprobe", [
        "-v",
        "error",
        "-show_streams",
        "-show_format",
        "-of",
        "json",
        result.video,
      ])
    ).stdout
  )
  await cell(
    "state.closedRecording=await state.window.record({directory:'/evidence',name:'Closed Linux window',maxDurationMs:10000});return state.closedRecording"
  )
  await delay(500)
  process.kill(target.pid, "SIGTERM")
  let interrupted
  for (let i = 0; i < 300; i++) {
    interrupted = await cell("return await state.closedRecording.status()")
    if (!["recording", "finalizing"].includes(interrupted.status)) break
    await delay(100)
  }
  assert.equal(interrupted.status, "interrupted", interrupted.error)
  assert.ok(interrupted.video, "closed window retains a finalized recording")
  await writeFile(
    "/evidence/interruption.json",
    JSON.stringify(interrupted, null, 2)
  )
  await writeFile(
    "/evidence/result.json",
    JSON.stringify(
      { passed: true, target, coverPid, foreground, probe, result, receipts },
      null,
      2
    )
  )
  console.log(
    JSON.stringify({
      passed: true,
      video: result.video,
      pixel: [r, g, b],
      frames: result.frames,
      duration: probe.format.duration,
    })
  )
} catch (error) {
  await writeFile(
    "/evidence/failure.json",
    JSON.stringify({ error: error.message, receipts }, null, 2)
  )
  throw error
} finally {
  await client.close()
  cover?.kill()
}
