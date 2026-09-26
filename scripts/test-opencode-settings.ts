import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import { resolveSessionSettings } from "@mako/sessions/settings"
import { openCodeProfileLoader } from "../electron/providers/opencode/profile.ts"
import { createOpenCodeDriver } from "../electron/providers/opencode/live-driver.ts"

const variants = { low: {}, medium: {}, high: {} }
for (const defaultVariant of ["low", "high"]) {
  const catalog = normalizeOpenCodeModels([
    { id: "model", providerID: "provider", variants, defaultVariant },
  ])
  const resolved = resolveSessionSettings({
    models: catalog.models,
    context: "new",
    phase: "launch",
    overrides: { model: "provider/model" },
  })
  assert.equal(
    resolved.options.effort?.kind === "known" && resolved.options.effort.value,
    defaultVariant
  )
}
assert.equal(
  normalizeOpenCodeModels([{ id: "model", providerID: "provider", variants }])
    .models[0]?.options[0]?.current,
  undefined
)
console.log(
  "OpenCode catalog preserves declared reasoning defaults without inventing them from an unordered list"
)

if (process.argv.includes("--live")) {
  // A fresh, disposable OpenCode home: discovery must work before any cache
  // exists, and a session must open on the defaults discovery reported.
  const root = await mkdtemp(join(tmpdir(), "mako-opencode-settings-"))
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCODE_CONFIG_CONTENT: "{}" }
  for (const name of ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "OPENCODE_CONFIG_DIR"]) {
    env[name] = join(root, name)
    await mkdir(env[name]!, { recursive: true })
  }
  const driver = createOpenCodeDriver({ env: async () => ({ ...env }), approvalRoot: async () => join(root, "approvals") })
  const conversationId = randomUUID()
  try {
    const started = Date.now()
    const profile = await openCodeProfileLoader.load(env, root)
    const discoveryMs = Date.now() - started
    assert.ok(profile.models.length > 0, "a fresh OpenCode home reports its models")
    assert.ok(profile.settings?.model, profile.configurationError)
    const expected = resolveSessionSettings({ models: profile.models, context: "new", phase: "launch", defaults: profile.settings })
    const session = await driver.start(root, { conversationId, emit() {}, tuning: expected.settings })
    console.log(`OpenCode discovery (${discoveryMs} ms, ${profile.models.length} models): ${JSON.stringify(expected.settings)}; native session: ${JSON.stringify(session.settings)}`)
    assert.equal(session.settings?.model, expected.settings.model)
    assert.equal(session.settings?.options?.effort, expected.settings.options?.effort)
  } finally {
    await driver.close(conversationId)
    await rm(root, { recursive: true, force: true })
  }
}
