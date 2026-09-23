import assert from "node:assert/strict"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { verifyForegroundInput } from "../packages/control-runtime/src/computer-input-target.js"
import type { JsonObject } from "../electron/codex-app-json.js"

const server = new Server(
  { name: "target-fixture", version: "1" },
  { capabilities: { tools: {} } }
)
const client = new Client({ name: "target-test", version: "1" })
let activePid = 7
let frontWindow = 70
let windowReads = 0
let exactFocus: boolean | null | undefined
let windowPid = 7
server.setRequestHandler(CallToolRequestSchema, (request) => {
  if (request.params.name === "list_apps")
    return {
      content: [],
      structuredContent: { apps: [{ pid: activePid, active: true }] },
    }
  assert.equal(request.params.name, "list_windows")
  windowReads++
  return {
    content: [],
    structuredContent: {
      windows: [
        {
          pid: windowPid,
          window_id: 70,
          z_index: frontWindow === 70 ? 10 : 1,
          focused: exactFocus,
          is_on_screen: true,
        },
        {
          pid: 7,
          window_id: 71,
          z_index: frontWindow === 71 ? 10 : 1,
          is_on_screen: true,
        },
        { pid: 7, window_id: 72, z_index: 100, is_on_screen: false },
      ],
    },
  }
})
const [ct, st] = InMemoryTransport.createLinkedPair()
try {
  await server.connect(st)
  await client.connect(ct)
  const driver = {
    callTool: (name: string, args: JsonObject) =>
      client.callTool({ name, arguments: args }),
  }
  const target = { pid: 7, window_id: 70 }
  const signal = AbortSignal.timeout(5000)
  await verifyForegroundInput(driver, target, signal, "darwin")
  activePid = 8
  const previousReads = windowReads
  await assert.rejects(
    verifyForegroundInput(driver, target, signal, "darwin"),
    /application is not frontmost/
  )
  assert.equal(windowReads, previousReads)
  activePid = 7
  frontWindow = 71
  await assert.rejects(
    verifyForegroundInput(driver, target, signal, "darwin"),
    /window is not frontmost/
  )
  exactFocus = true
  await verifyForegroundInput(driver, target, signal, "darwin")
  windowPid = 8
  await assert.rejects(verifyForegroundInput(driver, target, signal, "darwin"), /keyboard focus could not be verified/)
  windowPid = 7
  for (const focus of [false, null]) {
    exactFocus = focus
    await assert.rejects(verifyForegroundInput(driver, target, signal, "darwin"), /keyboard focus could not be verified/)
  }
  exactFocus = undefined
  await assert.rejects(verifyForegroundInput(driver, { pid: 7 }, signal, "darwin"))
  let linuxFocused: boolean | null = true
  let backend = "x11"
  const linuxDriver = {
    callTool: async (name: string) => {
      assert.equal(name, "list_windows")
      return { content: [], structuredContent: {
        platform: "linux", backend,
        windows: [{ ...target, is_on_screen: true, focused: linuxFocused }],
      } }
    },
  }
  await verifyForegroundInput(linuxDriver, target, signal, "linux")
  for (const focus of [false, null]) {
    linuxFocused = focus
    await assert.rejects(verifyForegroundInput(linuxDriver, target, signal, "linux"), /could not verify keyboard focus/)
  }
  linuxFocused = true
  backend = "wayland"
  await verifyForegroundInput(linuxDriver, target, signal, "linux")
  for (const focus of [false, null]) {
    linuxFocused = focus
    await assert.rejects(verifyForegroundInput(linuxDriver, target, signal, "linux"), /could not verify keyboard focus/)
  }
  console.log(
    "Foreground guard: accepts matching target; refuses another app, another window, and incomplete identity"
  )
} finally {
  await client.close()
  await server.close()
}
