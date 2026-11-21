import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeRecordings, helperRecordingDesktop, nativeRecordingRate, type NativeDriverCall } from "../packages/control-runtime/src/native-recording.js"
import type { ComputerDriverClient } from "../packages/control-runtime/src/computer-driver-client.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
const target = { kind: "window" as const, pid: 42, window_id: 7 }
const tools: Tool[] = [
  {
    name: "start_recording",
    inputSchema: {
      type: "object",
      properties: { window_target: {}, recording_id: {} },
    },
  },
  {
    name: "stop_recording",
    inputSchema: { type: "object", properties: { recording_id: {} } },
  },
]
// The control session names its driver session on every call it makes.
const inSession = (driver: ComputerDriverClient, session: string): NativeDriverCall =>
  (name, args, timeout) => driver.callTool(name, { ...args, session }, { timeout })
const directory = await mkdtemp(join(tmpdir(), "native-recording-lifecycle-"))
for (const fault of ["none", "lost-receipt", "wrong-id", "wrong-pid", "wrong-window"]) {
  const manager = new NativeRecordings(undefined)
  const calls: Array<{
    name: string
    args: Record<string, import("@mako/host/contracts/json").JsonValue>
  }> = []
  let recordingId = "",
    output = ""
  const driver: ComputerDriverClient = {
    async listTools() {
      return tools
    },
    onClose() {
      throw new Error("Do not replace the host lifecycle listener")
    },
    async close() {},
    async callTool(name, args) {
      calls.push({ name, args })
      assert.equal(
        args.session,
        "task-session",
        "media and actions share the same native session"
      )
      if (name === "start_recording") {
        recordingId = String(args.recording_id)
        output = String(args.output_dir)
        assert.deepEqual(args.window_target, { pid: 42, window_id: 7 })
        assert.equal(args.capture_actions, false)
        if (fault === "lost-receipt")
          throw new Error("start receipt was lost after dispatch")
      } else
        assert.equal(
          args.recording_id,
          recordingId,
          "stop retains the pre-dispatch identity even without a start receipt"
        )
      return {
        content: [],
        structuredContent: {
          recording_id: name === "start_recording" && fault === "wrong-id" ? "another-recording" : recordingId,
          target: {
            pid: name === "start_recording" && fault === "wrong-pid" ? 43 : 42,
            window_id: name === "start_recording" && fault === "wrong-window" ? 8 : 7,
          },
          generation: 1,
          video_active: name === "start_recording",
          output_dir: output,
          last_video_path: null,
          last_error: null,
        },
      }
    },
  }
  if (fault !== "none")
    await assert.rejects(
      manager.start(
        target,
        { directory },
        inSession(driver, "task-session"),
        tools,
        new AbortController().signal
      ),
      fault === "lost-receipt" ? /receipt was lost/ : /identity changed during startup/
    )
  else {
    const started = await manager.start(
      target,
      { directory },
      inSession(driver, "task-session"),
      tools,
      new AbortController().signal
    )
    assert.throws(
      () => manager.get({ ...target, window_id: 8 }, started.id),
      /does not belong/
    )
    assert.equal(
      manager.get({ window_id: 7, pid: 42, kind: "window" }, started.id).id,
      started.id,
      "Property ordering does not change target identity"
    )
    await assert.rejects(
      manager.start(
        target,
        { directory },
        inSession(driver, "task-session"),
        tools,
        new AbortController().signal
      ),
      /Finish/
    )
    await manager.get(target, started.id).stop()
  }
  await manager.close()
  assert.deepEqual(
    calls.map((call) => call.name),
    ["start_recording", "stop_recording"]
  )
}
const old = new NativeRecordings(undefined)
await assert.rejects(
  old.start(
    target,
    { directory },
    async () => {
      throw new Error("old driver must not receive capture")
    },
    [],
    new AbortController().signal
  ),
  /installed native driver/
)
console.log(
  "Native recording: exact target/session, old-driver refusal, owner handles, duplicate start and lost-receipt cleanup passed"
)

// Requested source rate reaches only drivers that declare it. Unsupported rates
// refuse before creating media or dispatching start, including old fixed-rate drivers.
assert.deepEqual(nativeRecordingRate(tools[0]), {maxFps:30, configurable:false})
for (const maxFps of [5, 60]) {
  const catalog: Tool[] = [{ ...tools[0], inputSchema: {
    type: "object", properties: { ...tools[0].inputSchema.properties,
      fps: {type:"integer", minimum:1, maximum:maxFps},
    },
  }}, tools[1]]
  assert.deepEqual(nativeRecordingRate(catalog[0]), {maxFps, configurable:true})
  const manager = new NativeRecordings(undefined)
  let starts = 0
  let id = ""
  let output = ""
  let requested = 0
  const driver: ComputerDriverClient = {
    listTools: async () => catalog, onClose() {}, async close() {},
    async callTool(name, args) {
      if (name === "start_recording") {
        starts++
        id = String(args.recording_id)
        output = String(args.output_dir)
        requested = Number(args.fps)
      }
      return { content: [], structuredContent: {
        generation:1, recording_id:id, target, video_active:name === "start_recording",
        output_dir:output, last_video_path:null, last_error:null, fps:requested,
      }}
    },
  }
  await assert.rejects(manager.start(target, {directory, fps:maxFps+1}, inSession(driver, "rates"), catalog, new AbortController().signal), {code:"unsupported", outcome:"not-dispatched"})
  assert.equal(starts, 0)
  const receipt = await manager.start(target, {directory}, inSession(driver, "rates"), catalog, new AbortController().signal)
  assert.equal(requested, maxFps)
  await manager.get(target, receipt.id).stop()
  await manager.close()
}
console.log("Native recording source rate: 5/60 fps backend ceilings, negotiated defaults and refusal before dispatch passed")

// Where the video helper records instead of the driver: a person's Linux desktop, and a job's own X display.
assert.equal(helperRecordingDesktop({ DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, "darwin"), undefined, "a Mac's driver records")
assert.equal(helperRecordingDesktop({}, "linux"), undefined, "no display, nothing to record")
assert.equal(helperRecordingDesktop({ DISPLAY: ":99" }, "linux")?.session, "x11", "a job's Xvfb is recorded by window")
assert.equal(helperRecordingDesktop({ WAYLAND_DISPLAY: "wayland-0", XDG_SESSION_TYPE: "wayland", SWAYSOCK: "/s" }, "linux")?.session, "wayland")
{
  // On X11 the helper captures the window into the recording's MP4; the driver is asked for its action journal only
  // (no video of its own, so no FFmpeg), and stopping ends both.
  process.env.MAKO_VIDEO_HELPER = fileURLToPath(new URL("fixtures/fake-video-helper.mjs", import.meta.url))
  process.env.FAKE_VIDEO_LOG = join(directory, "helper.jsonl")
  const manager = new NativeRecordings({ session: "x11", compositor: "other", xwayland: false })
  const calls: Array<{ name: string; args: Record<string, import("@mako/host/contracts/json").JsonValue> }> = []
  const driver: ComputerDriverClient = {
    listTools: async () => tools,
    onClose() {
      throw new Error("Do not replace the host lifecycle listener")
    },
    async close() {},
    async callTool(name, args) {
      calls.push({ name, args })
      return { content: [], structuredContent: {} }
    },
  }
  await assert.rejects(manager.start(target, { directory, fps: 31 }, inSession(driver, "helper"), tools, new AbortController().signal), { code: "unsupported", outcome: "not-dispatched" })
  const receipt = await manager.start(target, { directory, fps: 30, idle: "keep" }, inSession(driver, "helper"), tools, new AbortController().signal)
  assert.equal(receipt.status, "recording")
  const started = calls.find((call) => call.name === "start_recording")
  assert.equal(started?.args.record_video, false, "the driver records no video")
  assert.deepEqual(started?.args.window_target, { pid: 42, window_id: 7 })
  assert.deepEqual(JSON.parse(readFileSync(process.env.FAKE_VIDEO_LOG, "utf8").split("\n")[0]!).args.slice(0, 2), ["window", "7"], "the helper captures the window by its id")
  await manager.get(target, receipt.id).stop()
  const done = await manager.get(target, receipt.id).settled()
  assert.equal(done.status, "finished", JSON.stringify(done))
  assert.ok(calls.some((call) => call.name === "stop_recording" && call.args.recording_id === receipt.id), "the journal is closed")
  assert.ok(done.video?.endsWith("recording.mp4"))
  await manager.close()
}
console.log("Helper recording: a Linux desktop's and a job display's windows through mako-video, the driver journaling only")
