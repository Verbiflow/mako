import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { LATEST_PROTOCOL_VERSION, ListToolsRequestSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import { createControlMcpServer } from "@mako/control-runtime/mcp"
import { listedComputerServer } from "@mako/host/tools/conversation-mcp"
import { COMPUTER_MANIFEST_FILE, computerManifestText, liveComputerManifest } from "./computer-manifest.mjs"

/**
 * An agent's `computer` server answers its handshake and `tools/list` from a manifest, with Local Control's server
 * loaded only for a tool's call (`tools/conversation-mcp.ts`). The manifest is what that server says now, or this
 * fails until `node scripts/computer-manifest.mjs` writes it again; and the server made from it answers an agent's
 * `initialize` and `tools/list` with the same bytes Local Control's own does.
 */
assert.equal(readFileSync(COMPUTER_MANIFEST_FILE, "utf8"), computerManifestText(await liveComputerManifest()), "packages/host/src/tools/computer-manifest.ts is what Local Control's server lists (node scripts/computer-manifest.mjs)")

/** What `server` answers an agent's handshake and its reading of the tools, as the bytes sent. */
async function answers(server: McpServer): Promise<string[]> {
  const [agent, far] = InMemoryTransport.createLinkedPair()
  const heard: string[] = []
  const waiting: Array<() => void> = []
  agent.onmessage = (message) => {
    heard.push(JSON.stringify(message))
    waiting.shift()?.()
  }
  await server.connect(far)
  await agent.start()
  const ask = async (message: JSONRPCMessage) => {
    const answered = new Promise<void>((resolve) => waiting.push(resolve))
    await agent.send(message)
    await answered
  }
  await ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "agent", version: "1" } } })
  await agent.send({ jsonrpc: "2.0", method: "notifications/initialized" })
  await ask({ jsonrpc: "2.0", id: 2, method: "tools/list" })
  await ask({ jsonrpc: "2.0", id: 3, method: "tools/list", params: { cursor: "next" } })
  await ask({ jsonrpc: "2.0", id: 4, method: "ping" })
  await ask({ jsonrpc: "2.0", id: 5, method: "resources/list" })
  await server.close()
  return heard
}

const live = await answers(createControlMcpServer(async () => {
  throw new Error("A server asked only what it lists calls nothing")
}))
const listed = await answers(listedComputerServer(McpServer, ListToolsRequestSchema))
assert.equal(live.length, 5)
assert.deepEqual(listed, live, "the manifest's server answers an agent as Local Control's does, byte for byte")
console.log(`computer manifest: initialize, tools/list (${live[1]?.length} bytes), ping and an unknown method answered byte for byte as Local Control's server answers them`)
