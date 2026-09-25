// Explicit native probe: metadata only, no prompt or persisted session.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { z } from "zod"
import { claudeProfileLoader } from "../electron/providers/claude/profile.js"
import {
  claudeDiscoveryArgs,
  claudeDiscoveryControl,
  ClaudeEffectiveSettingsSchema,
} from "../electron/providers/claude/settings.js"
import { withDiscoveryStream } from "../electron/providers/profile-transport.js"

assert.ok(
  process.argv.includes("--live"),
  "This test requires --live and the installed Claude CLI"
)
const root = await mkdtemp(join(tmpdir(), "mako-claude-discovery-"))
const sentinel = join(root, "hook-ran")
const localSettings = join(root, ".claude", "settings.local.json")
await mkdir(join(root, ".claude"))
const command = `touch '${sentinel}'`
await writeFile(
  localSettings,
  JSON.stringify({
    effortLevel: "low",
    hooks: {
      PreModelSwitch: [{ hooks: [{ type: "command", command }] }],
      PostModelSwitch: [{ hooks: [{ type: "command", command }] }],
    },
  })
)
const paths = [
  ...new Set([
    localSettings,
    join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      "settings.json"
    ),
    join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
      "settings.local.json"
    ),
  ]),
]
const fingerprints = () =>
  Promise.all(
    paths.map(async (path) => {
      try {
        return createHash("sha256")
          .update(await readFile(path))
          .digest("hex")
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return null
        throw error
      }
    })
  )
const env = process.env
const native = async (model: string) =>
  withDiscoveryStream(
    {
      command: env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      args: [...claudeDiscoveryArgs, "--model", model],
      env,
      cwd: root,
    },
    async (stream) =>
      ClaudeEffectiveSettingsSchema.parse(
        await claudeDiscoveryControl(stream)({ subtype: "get_settings" })
      )
  )
const rows: Array<{
  round: number
  reusedMs: number
  referenceMs: number
  modelCount: number
}> = []
try {
  const before = await fingerprints()
  for (let round = 0; round < 2; round++) {
    const started = performance.now()
    const profile = await claudeProfileLoader.load(env, root)
    assert.equal(profile.configurationError, undefined)
    const reusedMs = performance.now() - started
    const referenceStart = performance.now()
    const reference = await Promise.all(
      profile.models.map((model) => native(model.id))
    )
    for (const [index, model] of profile.models.entries()) {
      const effort = model.options.find((option) => option.id === "effort")
      if (effort)
        assert.equal(effort.current, reference[index].effort, model.id)
      const fast = model.options.find((option) => option.id === "fast")
      assert.equal(
        fast?.current,
        fast?.disabledReason ? false : reference[index].fast,
        model.id
      )
    }
    rows.push({
      round,
      reusedMs,
      referenceMs: performance.now() - referenceStart,
      modelCount: profile.models.length,
    })
    assert.deepEqual(
      await fingerprints(),
      before,
      "Metadata discovery changed saved settings"
    )
    await assert.rejects(access(sentinel), { code: "ENOENT" })
  }
  // A positive control proves the fixture's hook really can run in this CLI.
  await withDiscoveryStream(
    {
      command: env.CLAUDE_CODE_EXECUTABLE ?? "claude",
      args: [...claudeDiscoveryArgs.slice(0, -2), "--setting-sources", "local"],
      env,
      cwd: root,
    },
    async (stream) => {
      const control = claudeDiscoveryControl(stream)
      const catalog = z
        .object({
          models: z.array(
            z.object({
              value: z.string(),
              resolvedModel: z.string().optional(),
            })
          ),
        })
        .parse(await control({ subtype: "list_models" }))
      for (const model of catalog.models.filter(
        (row) => row.value !== "default"
      ))
        await control({
          subtype: "set_model",
          model: model.resolvedModel ?? model.value,
        })
    }
  )
  await access(sentinel)
  assert.deepEqual(await fingerprints(), before)
  console.log(
    JSON.stringify(
      {
        rows,
        hooksSuppressed: true,
        hookPositiveControl: true,
        savedSettingsUnchanged: true,
        cwd: root,
      },
      null,
      2
    )
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
