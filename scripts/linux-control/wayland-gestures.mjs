import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

// All foreground injection runs on an isolated container desktop, never on the
// user's workstation. The GTK event log independently verifies actual delivery.
export async function exerciseGestures({ cell, readState, until, recordingDirectory, frameOrigin }) {
  const before = (await readState()).points.length
  await cell("return await state.window.raw('bring_to_front',{foreground:true});")
  // GTK reports coordinates in its full buffer, including client-side shadows.
  // The public action frame excludes those shadows on GNOME.
  const origin = frameOrigin ? await frameOrigin() : { x: 0, y: 0 }
  if (recordingDirectory) await cell(`state.gestureVideo=await state.window.record({directory:${JSON.stringify(recordingDirectory)},maxDurationMs:30000});return state.gestureVideo;`)
  const drag = await cell("return await state.window.raw('drag',{from_x:100,from_y:180,to_x:330,to_y:230,steps:20,duration_ms:400,delivery_mode:'foreground',foreground:true});")
  const scroll = await cell("return await state.window.raw('scroll',{x:250,y:190,direction:'down',amount:3,delivery_mode:'foreground',foreground:true});")
  const actual = await until(async () => {
    const state = await readState()
    return state.points.slice(before).some(point => point.kind === 'scroll') ? state : null
  })
  const points = actual.points.slice(before)
  assert.equal(points.filter(point => point.kind === "down").length, 1, "Exactly one drag press reaches the app")
  assert.equal(points.filter(point => point.kind === "up").length, 1, "Exactly one drag release reaches the app")
  const moves = points.filter(point => point.kind === "move")
  assert.ok(moves.length >= 10, "The app receives a continuous drag path")
  const down = points.find(point => point.kind === "down")
  const up = points.find(point => point.kind === "up")
  assert.ok(Math.abs(down.window_x - origin.x - 100) < 2 && Math.abs(down.window_y - origin.y - 180) < 2, "The app receives the requested press in the action frame")
  assert.ok(Math.abs(up.window_x - origin.x - 330) < 2 && Math.abs(up.window_y - origin.y - 230) < 2, "The app receives the requested release in the action frame")
  assert.ok(Math.abs(up.window_x - down.window_x - 230) < 2, "Received drag displacement matches the requested horizontal distance")
  assert.ok(Math.abs(up.window_y - down.window_y - 50) < 2, "Received drag displacement matches the requested vertical distance")
  // GDK timestamps come from delivered input, not MCP call overhead. Unsigned
  // subtraction handles the compositor's 32-bit millisecond clock wrapping.
  const durationMs = (up.event_ms - down.event_ms) >>> 0
  assert.ok(durationMs >= 360, `Requested 400 ms drag lasted only ${durationMs} ms`)
  const result = { drag, scroll, points, durationMs, frameOrigin: origin }
  if (recordingDirectory) {
    await cell("return await state.gestureVideo.stop();")
    result.recording = await until(async () => {
      const status = await cell("return await state.gestureVideo.status();")
      return status.status === "finalizing" ? null : status
    })
    assert.equal(result.recording.status, "finished", result.recording.error)
    const timeline = JSON.parse(await readFile(result.recording.timeline, "utf8"))
    result.pointer = timeline.pointer
    assert.ok(timeline.pointer.length >= 22, "Recording retains the actual dispatched gesture path")
    assert.ok(new Set(timeline.pointer.map(point => Math.round(point.x))).size >= 15, "Recorded cursor traverses the drag")
    const pressed = timeline.pointer.find(point => point.pressed)
    assert.ok(pressed && Math.abs(pressed.x - 100) < 2 && Math.abs(pressed.y - 180) < 2, "Recorded press uses the requested window coordinates")
    const pressIndex = timeline.pointer.indexOf(pressed)
    const releaseIndex = timeline.pointer.findIndex((point, index) => index > pressIndex && !point.pressed)
    assert.ok(releaseIndex - pressIndex >= 21, "The recording retains the held button through all drag steps")
    assert.ok(Math.abs(timeline.pointer[releaseIndex].x - 330) < 2 && Math.abs(timeline.pointer[releaseIndex].y - 230) < 2, "The recorded button releases at the requested endpoint")
  }
  return result
}
