import assert from "node:assert/strict"
import { createMakoBridge, type BridgeTransport } from "@mako/host/contracts/renderer-bridge"
import { mcp, mcpStore } from "../src/state/mcp.ts"
import { simulators } from "../src/state/simulators.ts"

/**
 * What a window asks its host without the person asking for browser or computer use: as it opens, which simulators
 * there are; as `/` is typed in a composer, which MCP servers there are. On a host that loads browser and computer
 * use at its first use, neither may be a use of it: the first is `mako:simulators-list` as the person, which such a
 * host answers itself off a Mac, and the second is `mako:mcp-discover` alone, which isn't control's. Settings still
 * reads the computer's grants, browsers and driver. `test-control-on-demand.mjs` holds the host to these two calls.
 */
const asked: Array<{ channel: string; args: readonly unknown[] }> = []
const ANSWERS = new Map([
  ["mako:mcp-discover", JSON.stringify({ cwd: "/work", servers: [] })],
  ["mako:simulators-list", JSON.stringify({ hosts: [], simulators: [], consent: "allowed" })],
])
const transport: BridgeTransport = {
  invoke: async (channel, ...args) => {
    asked.push({ channel, args })
    return JSON.parse(ANSWERS.get(channel) ?? "[]")
  },
  onEvent: () => () => {},
  onTerminalEvent: () => () => {},
  pathForFile: () => null,
  resolveFileUrl: (url) => url,
}
Object.defineProperty(globalThis, "window", { configurable: true, value: { addEventListener: () => {}, mako: createMakoBridge(transport) } })
const channels = () => asked.splice(0).map((call) => call.channel)

// A window opening (`desk/builtins.tsx`).
await simulators.load()
assert.deepEqual(asked.map((call) => [call.channel, call.args]), [["mako:simulators-list", [{ kind: "person" }]]], "a window asks for the simulators as the person")
asked.length = 0

// `/` typed in a composer (`mention-menu.tsx`).
mcp.ensure("/work")
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(channels(), ["mako:mcp-discover"], "the composer's menu asks for the MCP servers alone")
assert.equal(mcpStore.get().status, "ready")
assert.equal(mcpStore.get().snapshot?.cwd, "/work")
mcp.ensure("/work")
await new Promise((resolve) => setTimeout(resolve, 20))
assert.deepEqual(channels(), [], "and once for a workspace")

// Settings › MCP reads all of it, as it did.
await mcp.load()
assert.deepEqual(channels().sort(), ["mako:browser-control-status", "mako:computer-driver", "mako:computer-permissions", "mako:mcp-discover"])
console.log("control unasked: a window opening asks for the simulators as the person, and the composer's menu for the MCP servers alone; Settings reads the computer's grants, browsers and driver")
