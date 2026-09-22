import assert from "node:assert/strict"
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { randomUUID } from "node:crypto"
import { query } from "@anthropic-ai/claude-agent-sdk"
import { createClaudeSdkDriver } from "../electron/providers/claude/sdk-driver.ts"
import { installHostLog } from "../electron/host-log.ts"

// Exercise the real SDK handshake and driver's spawn boundary without sending
// a model prompt. Progress continues beyond the old fixed 20-second deadline.
const root = await mkdtemp(join(tmpdir(), "mako-claude-startup-"))
const logPath = join(root, "host.log")
const log = installHostLog(logPath)
const shim = join(root, "claude-startup")
const binary = resolve("node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude")
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`
await writeFile(shim, `#!/bin/sh\nfor i in 1 2 3 4 5; do\n echo startup-progress >&2\n sleep 5\ndone\nexec ${quote(binary)} "$@"\n`)
await chmod(shim, 0o700)
const driver = createClaudeSdkDriver({
  available: () => true,
  query,
  configure: async () => ({
    cwd: root,
    pathToClaudeCodeExecutable: shim,
    settingSources: [],
    strictMcpConfig: true,
    sessionId: randomUUID(),
  }),
})
const id = randomUUID()
try {
  const startedAt = performance.now()
  const session = await driver.start(root, { conversationId: id, emit() {} })
  const elapsed = performance.now() - startedAt
  assert.ok(elapsed >= 25_000)
  assert.equal(session.status, "ready")
  assert.equal(session.connection, "connected")
  console.log(`Claude real SDK initialized after ${Math.round(elapsed)} ms with continuing progress; no prompt sent`)
  await driver.close(id)
  await writeFile(shim, "#!/bin/sh\necho private-startup-payload >&2\nexit 7\n")
  const failedId = randomUUID()
  const failedAt = performance.now()
  try {
    await assert.rejects(driver.start(root, { conversationId: failedId, emit() {} }), /exit/i)
    assert.ok(performance.now() - failedAt < 5_000, "process exit must fail before the silence deadline")
  } finally {
    await driver.close(failedId)
  }
  await log.flush()
  const evidence = await readFile(logPath, "utf8")
  assert.match(evidence, /process spawned/)
  assert.match(evidence, /initialized/)
  assert.match(evidence, /initialization failed/)
  assert.match(evidence, /process exited/)
  assert.ok(!evidence.includes("private-startup-payload"), "startup logs must not copy native stderr")
  console.log("Early process exit and durable payload-free startup diagnostics passed")
} finally {
  await driver.close(id)
  await rm(root, { recursive: true, force: true })
}
