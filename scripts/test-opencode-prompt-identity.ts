import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { OpenCodeProvider } from "../packages/sessions/src/providers/opencode.ts"
import { createOpenCodeDriver } from "../electron/providers/opencode/live-driver.ts"
import type { PromptDeliveryEvidence } from "../electron/contracts/prompt-delivery.ts"

// Opt-in native proof: only its own isolated account/store and caller-assigned
// Thread port. Not part of fast fixture gates; requires OpenCode v2 installed.
assert.ok(process.env.MAKO_OPENCODE_API_PORT, "Assign a free port from this Thread before running the native proof")
const root = await mkdtemp(join(tmpdir(), "mako-opencode-prompt-identity-"))
const env: NodeJS.ProcessEnv = { ...process.env,
  OPENCODE_BIN_PATH: process.env.OPENCODE_BIN_PATH ?? join(homedir(), ".opencode/bin/opencode2"),
  OPENCODE_CONFIG_CONTENT: "{}",
}
for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]) {
  env[name] = join(root, name)
  await mkdir(env[name]!, { recursive: true })
}
const id = randomUUID()
const driver = createOpenCodeDriver({ env: async () => env, approvalRoot: async () => join(root, "approvals") })
const reader = new OpenCodeProvider(env.HOME, env)
const reports: PromptDeliveryEvidence[] = []
try {
  const started = await driver.start(root, { conversationId: id, emit() {},
    tuning: { model: process.env.MAKO_OPENCODE_MODEL ?? "opencode/space-bunny-free" },
    title: "Mako isolated prompt identity proof",
  })
  assert.ok(started.nativePath)
  await driver.prompt(id, "Reply with just OK. Do not run tools.", [], undefined, {
    operationId: randomUUID(), attemptId: randomUUID(), report: evidence => reports.push(evidence),
  })
  const accepted = reports.find(item => item.kind === "accepted" && item.referenceId)
  assert.ok(accepted?.kind === "accepted" && accepted.referenceId)
  const deadline = Date.now() + 20_000
  for (;;) {
    const stored = await reader.read(started.nativePath)
    if (stored?.entries.some(entry => entry.kind === "user" && entry.id === accepted.referenceId)) break
    assert.ok(Date.now() < deadline, "Native receipt did not identify a stored user message")
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  await driver.cancel(id)
  await driver.close(id)
  const reopened = await reader.read(started.nativePath)
  assert.ok(reopened?.entries.some(entry => entry.kind === "user" && entry.id === accepted.referenceId),
    "correspondence survives cancellation and native server closure")
  console.log(JSON.stringify({ passed: true, runtime: started.executionContext?.runtime,
    receipt: accepted.source, sameStoredUserId: true, retainedAfterClose: true,
    isolated: true, port: Number(env.MAKO_OPENCODE_API_PORT),
    scope: "One real OpenCode v2 prompt; not independent-CLI exclusion or six-harness installed acceptance" }))
} finally {
  await driver.close(id)
  await rm(root, { recursive: true, force: true })
}
