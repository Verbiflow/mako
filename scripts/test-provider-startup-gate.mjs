import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { randomUUID } from "node:crypto"
import { syncBuiltinESMExports } from "node:module"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { noAcpCapabilities } from "./fixtures/driver-capabilities.ts"
import { admitted } from "./fixtures/admitted-start.ts"

const root = await mkdtemp(join(tmpdir(), "mako-startup-gate-"))
process.env.MAKO_LIFECYCLE_ROOT = root
try {
  await checkMcpStartup()
  const { stderrDetail } = await import("../dist-electron/provider-startup.js")
  assert.equal(
    stderrDetail(
      "Model unavailable\n\u001b[2m2026-09-09T00:00:00Z\u001b[0m  INFO SessionEnd dispatched"
    ),
    "Model unavailable"
  )
  assert.equal(
    stderrDetail("  2026-09-09T00:00:00Z INFO SessionEnd dispatched"),
    ""
  )
  console.log("PASS: a provider's failed start reads its error, not its log lines")
} finally {
  await rm(root, { recursive: true, force: true })
}

async function checkMcpStartup() {
  const originalSpawn = childProcess.spawn
  const originalExec = childProcess.execFile
  childProcess.spawn = () => {
    throw new Error("Unexpected provider process before MCP readiness")
  }
  childProcess.execFile = () => {
    throw new Error("Unexpected discovery process before MCP readiness")
  }
  syncBuiltinESMExports()
  const { DiscoveryProcesses } = await import("../dist-electron/providers/discovery-process.js")
  const { createAcpEngine } = await import("../dist-electron/acp.js")
  const { createCodexEngine } = await import("../dist-electron/codex-app.js")
  try {
    const acp = createAcpEngine({
      ...noAcpCapabilities,
      provider: "startup-gate",
      available: () => true,
      launch: async () => ({
        command: process.execPath,
        args: [],
        configureEnvironment() {},
      }),
    }, { processes: new DiscoveryProcesses(), servesMcp: () => false })
    let calls = 0
    const options = {
      conversationId: randomUUID(),
      emit: () => {},
      mcpSnapshot: async () => {
        calls++
        throw new Error("MCP readiness gate")
      },
    }
    await assert.rejects(
      acp.start(process.env.MAKO_LIFECYCLE_ROOT, admitted("startup-gate", options)),
      /MCP readiness gate/
    )
    await assert.rejects(
      createCodexEngine().start(process.env.MAKO_LIFECYCLE_ROOT, admitted("codex", {
        ...options,
        conversationId: randomUUID(),
      })),
      /MCP readiness gate/
    )
    assert.equal(calls, 2)
    console.log(
      "PASS: ACP and app-server starts honor the host MCP readiness gate before launching a process"
    )
  } finally {
    childProcess.spawn = originalSpawn
    childProcess.execFile = originalExec
    syncBuiltinESMExports()
  }
}
