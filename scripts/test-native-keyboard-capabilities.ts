import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  CallToolResultSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import { ExecutionReceiptSchema } from "@mako/control/control"
import { z } from "zod"
import { createComputerToolsServer } from "../packages/control-runtime/src/computer-tools-main.js"
import type { ComputerDriverClient } from "../packages/control-runtime/src/computer-driver-client.js"

// Reproduce Terminal's transient titled window without relaxing the separate
// driver's dispatch-time same-process guard. No actual OS input is sent.
const target = { pid: 42, window_id: 7 }
let siblingVisibility: boolean | null | undefined = false
let targetVisible = true
let refuseAtDispatch = false
const dispatchSchema = z.object({
  name: z.enum(["press_key", "hotkey"]),
  pid: z.number().int(),
  window_id: z.number().int(),
  delivery_mode: z.enum(["background", "foreground"]).optional(),
  foreground: z.boolean().optional(),
  force: z.boolean().optional(),
})
const dispatches: z.infer<typeof dispatchSchema>[] = []
const resultSchema = z.union([
  z.object({ receipt: ExecutionReceiptSchema }),
  z.object({ error: z.string(), outcome: z.string() }),
])
const toolNames = ["list_windows", "press_key", "hotkey"]
const fixtureTools: Tool[] = toolNames.map((name) => ({
  name,
  inputSchema: { type: "object", additionalProperties: true },
}))
const driver: ComputerDriverClient = {
  async listTools() {
    return fixtureTools
  },
  async callTool(name, args) {
    if (name === "list_windows") {
      const sibling = { pid: 42, window_id: 8, title: "Window" }
      const value = {
        windows: [
          { ...target, title: "Scratch terminal", is_on_screen: targetVisible },
          siblingVisibility === undefined
            ? sibling
            : { ...sibling, is_on_screen: siblingVisibility },
        ],
      }
      return { content: [], structuredContent: value }
    }
    assert.ok(name === "press_key" || name === "hotkey", name)
    dispatches.push(dispatchSchema.parse({ name, ...args }))
    if (refuseAtDispatch)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Background input refused (same_pid_keyboard_ambiguity): fresh AX evidence found a competing window",
          },
        ],
      }
    return {
      content: [],
      structuredContent: {
        route: "synthetic_events",
        effect: "unverifiable",
        delivery: { mode: "background" },
      },
    }
  },
  onClose() {},
  async close() {},
}
const server = createComputerToolsServer(
  { command: "unused-fixture", args: [] },
  "native-keyboard-capabilities",
  async () => driver,
  { surface: "control" }
)
const client = new Client({
  name: "native-keyboard-capabilities",
  version: "1",
})
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
async function run(source: string) {
  const response = CallToolResultSchema.parse(
    await client.callTool({
      name: "mako_control_exec",
      arguments: { source },
    })
  )
  assert.ok(!response.isError, JSON.stringify(response))
  const text = response.content.find((part) => part.type === "text")
  assert.ok(text, JSON.stringify(response))
  return resultSchema.parse(JSON.parse(text.text))
}
const press = `const w=control.window({pid:42,window_id:7});
try {return {receipt:await w.pressKey('return')}}
catch(e) {return {error:e.message,outcome:e.outcome}}`
try {
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  if (process.platform !== "darwin") {
    const refused = await run(press)
    assert.ok("error" in refused)
    assert.match(
      refused.error,
      /Background pid-keyboard delivery has not been verified/
    )
    assert.equal(refused.outcome, "not-dispatched")
    assert.equal(dispatches.length, 0)
    console.log(
      "native keyboard capabilities: unverified platform remains blocked"
    )
  } else {
    const allowed = await run(press)
    assert.ok("receipt" in allowed)
    assert.equal(allowed.receipt.status, "dispatched")
    assert.equal(allowed.receipt.route, "pid-keyboard")
    assert.equal(dispatches.length, 1)
    assert.equal(dispatches[0].pid, 42)
    assert.equal(dispatches[0].window_id, 7)
    assert.notEqual(dispatches[0].delivery_mode, "foreground")
    assert.notEqual(dispatches[0].foreground, true)
    assert.notEqual(dispatches[0].force, true)

    for (const visibility of [true, null, undefined]) {
      siblingVisibility = visibility
      const refused = await run(press)
      assert.ok("error" in refused)
      assert.match(refused.error, /2 document windows share this process/)
      assert.match(refused.error, /foreground-required/)
      assert.equal(refused.outcome, "not-dispatched")
      assert.equal(
        dispatches.length,
        1,
        `sibling visibility ${visibility} must block dispatch`
      )
    }

    siblingVisibility = false
    targetVisible = false
    const hidden = await run(press)
    assert.ok("error" in hidden)
    assert.match(hidden.error, /hidden, minimized or off screen/)
    assert.equal(dispatches.length, 1)
    targetVisible = true
    const command =
      await run(`try {return await control.window({pid:42,window_id:7}).pressKey('a',{modifiers:['Meta']})}
catch(e) {return {error:e.message,outcome:e.outcome}}`)
    assert.ok("error" in command)
    assert.match(
      command.error,
      /not passed background Command delivery acceptance/
    )
    assert.equal(command.outcome, "not-dispatched")
    assert.equal(
      dispatches.length,
      1,
      "Command restriction still precedes native dispatch"
    )

    refuseAtDispatch = true
    const driverRefusal = await run(press)
    assert.ok("error" in driverRefusal)
    assert.match(driverRefusal.error, /same_pid_keyboard_ambiguity/)
    assert.ok(!("receipt" in driverRefusal))
    assert.equal(
      dispatches.length,
      2,
      "allowed capability still asks the native driver exactly once"
    )
    console.log(
      "native keyboard capabilities: visibility, refusal reasons and driver guard passed"
    )
  }
} finally {
  await client.close()
  await server.close()
}
