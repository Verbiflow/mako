import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { unlaunchableMcpServers } from "../electron/mcp-preflight.ts"

// A harness with no MCP status of its own (Cursor's SDK) still says which
// servers could not be launched, the way the others do. Nothing is spawned,
// and only a command found nowhere is named.
const root = mkdtempSync(join(tmpdir(), "mako-mcp-preflight-"))
try {
  const bin = join(root, "bin")
  mkdirSync(bin)
  const tool = join(bin, "present-server")
  writeFileSync(tool, "#!/bin/sh\n")
  chmodSync(tool, 0o755)
  const local = join(root, "scripts", "local-server")
  mkdirSync(join(root, "scripts"))
  writeFileSync(local, "#!/bin/sh\n")
  chmodSync(local, 0o755)
  const env = { PATH: bin, HOME: root }
  const missing = unlaunchableMcpServers([
    { name: "on-path", command: "present-server" },
    { name: "absolute", command: tool },
    { name: "relative", command: "./scripts/local-server" },
    { name: "own-path", command: "present-server", env: { PATH: bin } },
    { name: "remote" },
    { name: "missing", command: "mako-no-such-server-7f3a" },
    { name: "missing-absolute", command: join(root, "gone") },
    { name: "missing-relative", command: "./scripts/gone" },
  ], root, env)
  assert.deepEqual(missing, ["missing", "missing-absolute", "missing-relative"])
  console.log("MCP preflight: only stdio commands found nowhere are named; remote servers and present commands are left to the harness")
} finally {
  rmSync(root, { recursive: true, force: true })
}
