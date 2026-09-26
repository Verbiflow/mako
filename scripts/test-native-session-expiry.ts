import assert from "node:assert/strict"
import { CallToolResultSchema, type Tool } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { controlSessionProbe } from "./lib/control-session-probe.ts"
import type { ComputerDriverClient } from "../packages/control-runtime/src/computer-driver-client.js"

// The driver ends a named session after five idle minutes and refuses later
// calls naming it before running the tool (serve.rs resurrection guard).
const ended = new Set<string>()
const calls: { name: string; session?: string }[] = []
let failWith: string | undefined
const sessionTool = (name: string): Tool => ({
  name,
  inputSchema: { type: "object", properties: { session: { type: "string" } }, additionalProperties: true },
})
const driver: ComputerDriverClient = {
  async listTools() {
    return ["get_window_state", "set_agent_cursor_enabled", "set_agent_cursor_motion"].map(sessionTool)
  },
  async callTool(name, args) {
    const session = z.string().optional().safeParse(args.session).data
    calls.push({ name, session })
    if (session && ended.has(session))
      return {
        isError: true,
        content: [{ type: "text", text: `session '${session}' has ended; tool call '${name}' was rejected. Call start_session with this id to revive it before issuing further actions, or use a new session id.` }],
        structuredContent: { code: "tool_invocation_failed", exit_code: 1 },
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
  const first = reads()[0]!.session
  assert.ok(first?.startsWith("mako-native-session-expiry-"), JSON.stringify(calls))

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
  console.log("native session expiry: ended driver sessions are replaced once; window-state errors keep their message")
} finally {
  await server.close()
}
