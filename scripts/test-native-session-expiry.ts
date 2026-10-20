import assert from "node:assert/strict"
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { controlSessionProbe } from "./lib/control-session-probe.ts"
import type { ComputerDriverClient, ComputerDriverResult } from "../packages/control-runtime/src/computer-driver-client.js"

// The driver ends a named session after five idle minutes and refuses later
// calls naming it before running the tool (serve.rs resurrection guard).
const ended = new Set<string>()
const calls: { name: string; session?: string }[] = []
let failWith: string | undefined
let started: { recording_id: string; output_dir?: string } | undefined
const sessionTool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object", properties: { session: { type: "string" } }, additionalProperties: true },
})
const driver: ComputerDriverClient = {
  async listTools() {
    return [
      ...["get_window_state", "set_agent_cursor_enabled", "set_agent_cursor_motion"].map(sessionTool),
      { name: "start_recording", inputSchema: { type: "object", properties: { session: { type: "string" }, window_target: { type: "object" }, fps: { type: "integer", minimum: 1, maximum: 30 } } } },
      { name: "stop_recording", inputSchema: { type: "object", properties: { session: { type: "string" }, recording_id: { type: "string" } } } },
    ]
  },
  async callTool(name, args): Promise<ComputerDriverResult> {
    const session = z.string().optional().safeParse(args.session).data
    calls.push({ name, session })
    if (session && ended.has(session))
      return {
        isError: true,
        content: [{ type: "text", text: `session '${session}' has ended; tool call '${name}' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.` }],
        structuredContent: { code: "tool_invocation_failed", exit_code: 1 },
      }
    if (name === "start_recording" || name === "stop_recording" || name === "get_recording_state") {
      if (name !== "get_recording_state") started = z.object({ recording_id: z.string(), output_dir: z.string().optional() }).parse(args)
      const recording = started!
      const state = {
        generation: 1, recording_id: recording.recording_id, target: { pid: 42, window_id: 7 },
        video_active: name !== "stop_recording", fps: 30, output_dir: recording.output_dir ?? null,
        last_video_path: null, last_error: name === "stop_recording" ? "fixture keeps no video" : null,
      }
      return { content: [{ type: "text", text: JSON.stringify(state) }], structuredContent: state }
    }
    if (name !== "get_window_state") return { content: [], structuredContent: {} }
    if (failWith)
      return {
        isError: true,
        content: [{ type: "text", text: failWith }],
        structuredContent: { code: "tool_invocation_failed", exit_code: 1 },
      }
    return {
      content: [{ type: "text", text: "window_id=7 pid=42 elements=0" }],
      structuredContent: { app_name: "Fixture", pid: 42, window_id: 7, elements: [] },
    }
  },
  onClose() {},
  async close() {},
}
const server = controlSessionProbe({ command: "unused-fixture", args: [] }, "native-session-expiry", async () => driver, {
  surface: "control",
})
const readSchema = z.object({ ok: z.literal(true).optional(), error: z.string().optional(), outcome: z.string().optional() })
async function read() {
  const response = CallToolResultSchema.parse(
    await server.request({
      method: "exec",
      arguments: {
        source: "try { await control.native('get_window_state',{pid:42,window_id:7}); return {ok:true} } catch (e) { return {error:e.message,outcome:e.outcome} }",
      },
    })
  )
  const text = response.content.find((part) => part.type === "text")
  assert.ok(text && text.type === "text", JSON.stringify(response))
  return readSchema.parse(JSON.parse(text.text))
}
const reads = () => calls.filter((call) => call.name === "get_window_state")
try {
  assert.deepEqual(await read(), { ok: true })
  const first = reads()[0]?.session
  assert.ok(first, JSON.stringify(calls))
  assert.ok(first.startsWith("mako-native-session-expiry-"), JSON.stringify(calls))

  ended.add(first)
  calls.length = 0
  assert.deepEqual(await read(), { ok: true }, "An idle-ended driver session is replaced, not left refusing every call")
  const [refused, retried] = reads()
  assert.equal(refused?.session, first)
  assert.ok(retried?.session && retried.session !== first, JSON.stringify(calls))
  assert.equal(reads().length, 2, "The refused call is repeated exactly once")
  assert.ok(
    calls.some((call) => call.name === "set_agent_cursor_enabled" && call.session === retried.session),
    "The replacement session is quieted before use"
  )

  calls.length = 0
  failWith = "AX walk failed: the window closed"
  const failed = await read()
  assert.equal(failed.error, "AX walk failed: the window closed", "A window-state error keeps the driver's own message")
  assert.equal(reads().length, 1, "Other errors are not retried")

  const current = calls.at(-1)?.session
  assert.ok(current, JSON.stringify(calls))
  ended.add(current)
  calls.length = 0
  const recorded = CallToolResultSchema.parse(await server.request({
    method: "exec",
    arguments: { source: "try { const r = await control.window({pid:42,window_id:7}).record({fps:30}); return {status:r.receipt?.status ?? (await r.status()).status} } catch (e) { return {error:e.message} }" },
  }))
  const recordText = recorded.content.find((part) => part.type === "text")
  assert.ok(recordText?.type === "text" && recordText.text.includes('"status":"recording"'), JSON.stringify(recorded))
  const starts = calls.filter((call) => call.name === "start_recording")
  assert.equal(starts.length, 2, "A recording start refused for an ended session is sent once more, under a new one")
  assert.equal(starts[0]?.session, current)
  assert.ok(starts[1]?.session && starts[1].session !== current, JSON.stringify(calls))
  console.log("native session expiry: ended driver sessions are replaced once, recordings included; window-state errors keep their message")
} finally {
  await server.close()
}
