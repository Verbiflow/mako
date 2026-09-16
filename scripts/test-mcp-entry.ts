import assert from "node:assert/strict"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

const directory = await mkdtemp(join(tmpdir(), "mako-mcp-entry-"))
try {
  for (const [file, tool] of [
    ["browser-tools-main.ts", "mako_browser_exec"],
    ["computer-tools-main.ts", "mako_control_exec"],
  ]) {
    const path = join(directory, file)
    await symlink(
      fileURLToPath(new URL(`../electron/${file}`, import.meta.url)),
      path
    )
    const client = new Client({ name: "mako-entry-test", version: "1" })
    try {
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [...process.execArgv, path],
          stderr: "pipe",
        }),
        { timeout: 5_000 }
      )
      assert.ok(
        (await client.listTools()).tools.some((entry) => entry.name === tool)
      )
    } finally {
      await client.close()
    }
  }
  console.log(
    "Managed MCP entry points initialize and advertise tools through symlinks"
  )
} finally {
  await rm(directory, { recursive: true, force: true })
}
