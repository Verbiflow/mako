import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { NativeRecordings } from "../electron/native-recording.js"
import type { ComputerDriverClient } from "../electron/computer-driver-client.js"
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
const directory = await mkdtemp(join(tmpdir(), "native-recording-lifecycle-"))
for (const fault of ["none", "lost-receipt", "wrong-id", "wrong-pid", "wrong-window"]) {
  const manager = new NativeRecordings()
  const calls: Array<{
    name: string
    args: Record<string, import("../electron/codex-app-json.js").JsonValue>
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
        driver,
        tools,
        "task-session",
        new AbortController().signal
      ),
      fault === "lost-receipt" ? /receipt was lost/ : /identity changed during startup/
    )
  else {
    const started = await manager.start(
      target,
      { directory },
      driver,
      tools,
      "task-session",
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
        driver,
        tools,
        "task-session",
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
const old = new NativeRecordings()
await assert.rejects(
  old.start(
    target,
    { directory },
    {
      listTools: async () => [],
      callTool: async () => {
        throw new Error("old driver must not receive capture")
      },
      onClose() {},
      async close() {},
    },
    [],
    "session",
    new AbortController().signal
  ),
  /installed native driver/
)
console.log(
  "Native recording: exact target/session, old-driver refusal, owner handles, duplicate start and lost-receipt cleanup passed"
)
