import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import sharp from "sharp"
const execute = promisify(execFile)
export async function validateBrowserRecording({
  run,
  service,
  target,
  root,
  round,
  fixtureSaves,
}) {
  for (const scale of [1, 2]) {
    await run({
      action: "cdp",
      target,
      method: "Emulation.setPageScaleFactor",
      params: { pageScaleFactor: scale },
    })
    // The independent fixture draws a red 12px marker at the actual event location.
    await run({
      action: "evaluate",
      target,
      expression: `window.recordingClick=null;window.recordingListener=e=>{window.recordingClick={x:e.clientX,y:e.clientY};let m=document.createElement('div');m.id='recording-proof';m.style.cssText='position:fixed;pointer-events:none;background:rgb(255,0,0);width:12px;height:12px;left:'+e.clientX+'px;top:'+e.clientY+'px';document.body.append(m)};document.addEventListener('mousedown',window.recordingListener)`,
    })
    const before = await run({ action: "observe", target })
    const started = await run({
      action: "recording",
      target,
      operation: "start",
      options: {
        directory: root,
        name: `Browser scale ${scale}`,
        maxDurationMs: 20_000,
      },
    })
    await assert.rejects(
      service.execute(
        "intruder",
        { action: "recording", target, operation: "stop", id: started.id },
        new AbortController().signal
      )
    )
    await assert.rejects(
      run({
        action: "recording",
        target,
        operation: "start",
        options: { directory: root },
      })
    )
    await delay(250)
    await run({ action: "click", target, at: { x: 160, y: 160 } })
    await delay(350)
    const events = await run({ action: "events", target })
    assert.ok(
      !JSON.stringify(events).includes("screencastFrame"),
      "video frames never enter ordinary agent event history"
    )
    await run({
      action: "recording",
      target,
      operation: "stop",
      id: started.id,
    })
    await run({
      action: "recording",
      target,
      operation: "stop",
      id: started.id,
    })
    let receipt
    for (let i = 0; i < 200; i++) {
      receipt = await run({
        action: "recording",
        target,
        operation: "status",
        id: started.id,
      })
      if (!["recording", "finalizing"].includes(receipt.status)) break
      await delay(100)
    }
    assert.equal(receipt.status, "finished", receipt.error)
    assert.ok(receipt.frames > 0)
    const timeline = JSON.parse(await readFile(receipt.timeline, "utf8"))
    assert.ok(
      timeline.pointer.some((p) => p.x === 160 && p.y === 160 && p.pressed)
    )
    assert.ok(
      timeline.frames.every((f) => f.pageScaleFactor === scale),
      JSON.stringify(timeline.frames)
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
          receipt.video,
        ])
      ).stdout
    )
    assert.equal(probe.streams[0].codec_name, "h264")
    const decoded = join(receipt.directory, "decoded.png")
    await execute("ffmpeg", [
      "-v",
      "error",
      "-sseof",
      "-0.15",
      "-i",
      receipt.video,
      "-frames:v",
      "1",
      decoded,
    ])
    const { data, info } = await sharp(decoded)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    // Red fixture marker and bright cursor outline must overlap spatially.
    const red = []
    for (let y = 0; y < info.height; y++)
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * info.channels
        if (data[i] > 180 && data[i + 1] < 65 && data[i + 2] < 65)
          red.push([x, y])
      }
    assert.ok(
      red.length > 0,
      "recorded tab contains independently drawn input marker"
    )
    const [minX, minY] = [
      Math.min(...red.map((p) => p[0])),
      Math.min(...red.map((p) => p[1])),
    ]
    // Save decoded video and fixture state for visual inspection, never just encoder success.
    const oracle = await run({
      action: "evaluate",
      target,
      expression: "window.recordingClick",
    })
    await writeFile(
      join(receipt.directory, "oracle.json"),
      JSON.stringify(
        {
          oracle: oracle.result.value,
          red: { minX, minY },
          probe,
          receipt,
          before: before.observation,
        },
        null,
        2
      )
    )
    console.log(
      JSON.stringify({
        recording: true,
        round,
        scale,
        video: receipt.video,
        decoded,
        red: { minX, minY },
        pointer: timeline.pointer,
        frames: receipt.frames,
      })
    )
    await run({
      action: "evaluate",
      target,
      expression:
        "document.removeEventListener('mousedown',window.recordingListener);document.querySelector('#recording-proof')?.remove()",
    })
  }
  await run({
    action: "cdp",
    target,
    method: "Emulation.setPageScaleFactor",
    params: { pageScaleFactor: 1 },
  })
  if (round === 0 && process.argv.includes("--recording-stress")) {
    const cover = await run({
      action: "open",
      browser: target.browser,
      background: false,
    })
    await run({
      action: "evaluate",
      target,
      expression:
        "window.videoFrames=0;let square=document.createElement('div');square.id='video-motion';square.style.cssText='position:fixed;width:60px;height:60px;background:#357ab7;top:220px;left:20px';document.body.append(square);window.videoTick=setInterval(()=>{window.videoFrames++;square.style.transform='translateX('+(window.videoFrames%30)*5+'px)'},33)",
    })
    const latency = { baseline: [], recording: [] }
    const jobs = process.argv.includes("--recording-long") ? 300 : 30
    const completeJobs = process.argv.includes("--recording-long")
    if (completeJobs) await run({ action: "dialog", target, auto: "accept" })
    let record
    for (const phase of ["baseline", "recording"]) {
      if (phase === "recording")
        record = await run({
          action: "recording",
          operation: "start",
          target,
          options: {
            directory: root,
            name: "Hidden complete jobs",
            maxDurationMs: 300000,
          },
        })
      for (let i = 0; i < jobs; i++) {
        const began = performance.now()
        const observation = await run({ action: "observe", target })
        const ref = observation.nodes.find((n) => n.role === "textbox").ref
        await run({
          action: "type",
          target,
          ref,
          text: `${phase}-${i}`,
          clear: true,
        })
        latency[phase].push(performance.now() - began)
        const oracle = await run({
          action: "evaluate",
          target,
          expression: "document.querySelector('input').value",
        })
        assert.equal(oracle.result.value, `${phase}-${i}`)
        if (completeJobs) {
          const count = fixtureSaves.length
          const save = observation.nodes.find(
            (node) => node.role === "button" && node.name === "Save"
          )
          await run({ action: "click", target, at: { ref: save.ref } })
          for (
            let attempt = 0;
            attempt < 100 && fixtureSaves.length === count;
            attempt++
          )
            await delay(20)
          assert.equal(
            fixtureSaves.length,
            count + 1,
            "exactly one server-confirmed save"
          )
          assert.deepEqual(fixtureSaves.at(-1), { value: `${phase}-${i}` })
        }
        await delay(100)
      }
    }
    await run({ action: "recording", operation: "stop", target, id: record.id })
    let receipt
    for (let i = 0; i < 1200; i++) {
      receipt = await run({
        action: "recording",
        operation: "status",
        target,
        id: record.id,
      })
      if (receipt.status !== "finalizing") break
      await delay(100)
    }
    assert.equal(receipt.status, "finished", receipt.error)
    const summary = {
      receipt,
      latency,
      jobsPerPhase: jobs,
      serverConfirmed: completeJobs,
    }
    await writeFile(
      join(receipt.directory, "performance.json"),
      JSON.stringify(summary, null, 2)
    )
    console.log(JSON.stringify({ hiddenRecording: true, ...summary }))
    await run({
      action: "evaluate",
      target,
      expression:
        "clearInterval(window.videoTick);document.querySelector('#video-motion').remove()",
    })
    const cleanView = await run({ action: "observe", target })
    const cleanField = cleanView.nodes.find((node) => node.role === "textbox")
    await run({
      action: "type",
      target,
      ref: cleanField.ref,
      text: "",
      clear: true,
    })
    await run({ action: "close", target: cover })
  }
}
