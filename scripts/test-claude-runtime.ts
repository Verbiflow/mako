import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { query } from "@anthropic-ai/claude-agent-sdk"
import type { ProviderHost } from "../electron/providers/host.ts"
import type { ProviderUpdateSource } from "../electron/providers/update-source.ts"
import { installClaude } from "../electron/providers/claude/index.ts"
import {
  bundledClaudeExecutable,
  claudeRuntime,
  terminalClaudeExecutable,
} from "../electron/providers/claude/runtime.ts"
import { RuntimeUpdates, resolveRuntimeChannel } from "../electron/runtime-updates.ts"

// Settings and model discovery read the build the SDK itself launches.
const bundled = bundledClaudeExecutable()
assert.ok(bundled, "the SDK's platform build is installed")
let spawned: string | undefined
assert.throws(
  () =>
    query({
      prompt: "unused",
      options: {
        spawnClaudeCodeProcess: (options) => {
          spawned = options.command
          throw new Error("spawn intercepted")
        },
      },
    }),
  /spawn intercepted/
)
assert.equal(spawned, bundled, "Mako reads the executable the SDK spawns")

const sdk = JSON.parse(
  readFileSync("node_modules/@anthropic-ai/claude-agent-sdk/package.json", "utf8")
) as { claudeCodeVersion: string }
assert.match(
  execFileSync(bundled, ["--version"], { encoding: "utf8" }),
  new RegExp(`^${sdk.claudeCodeVersion.replaceAll(".", "\\.")} `),
  "the platform build matches the SDK's pinned Claude Code"
)
console.log(`Bundled Claude Code ${sdk.claudeCodeVersion} is the executable the SDK spawns`)

const root = await mkdtemp(join(tmpdir(), "mako-claude-runtime-"))
try {
  const terminal = join(root, "bin", "claude")
  const linked = join(root, "linked-claude")
  await mkdir(join(root, "bin"))
  await writeFile(terminal, "#!/bin/sh\necho '2.1.290 (Claude Code)'\n", { mode: 0o700 })
  await symlink(terminal, linked)
  const env = { PATH: join(root, "bin") }

  assert.deepEqual(claudeRuntime(env), { kind: "bundled", executable: bundled })
  assert.equal(
    terminalClaudeExecutable(env),
    terminal,
    "a newer terminal CLI is listed separately and never replaces the session runtime"
  )
  assert.deepEqual(
    claudeRuntime({ ...env, CLAUDE_CODE_EXECUTABLE: linked }),
    { kind: "configured", executable: linked }
  )
  assert.equal(
    terminalClaudeExecutable({ ...env, CLAUDE_CODE_EXECUTABLE: linked }),
    null,
    "a configured executable is not listed twice"
  )
  assert.equal(
    claudeRuntime({ ...env, CLAUDE_CODE_EXECUTABLE: join(root, "missing") }),
    null,
    "a missing configured executable is never replaced by the bundled build"
  )

  const sources: ProviderUpdateSource[] = []
  const collect = new Proxy(
    {},
    {
      get: (_, key) => ({
        register: (value: ProviderUpdateSource) => {
          if (key === "updateSources") sources.push(value)
        },
      }),
    }
  )
  installClaude(collect as ProviderHost)
  const [source] = sources
  assert.ok(source)
  assert.equal(await source.binary(env), bundled)
  assert.deepEqual(resolveRuntimeChannel(source, bundled, bundled), {
    channel: "managed",
    managedBy: "Mako",
  })
  const packaged =
    "/Applications/Mako.app/Contents/Resources/app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"
  assert.deepEqual(resolveRuntimeChannel(source, packaged, packaged), {
    channel: "managed",
    managedBy: "Mako",
  })

  const versions: Record<string, string> = {
    [bundled]: "2.1.283 (Claude Code)",
    [terminal]: "2.1.290 (Claude Code)",
  }
  const updates = new RuntimeUpdates({
    sources: () => sources,
    path: join(root, "runtime-updates.json"),
    env: () => env,
    emit: () => undefined,
    version: async (binary) => versions[binary] ?? "",
    latest: async () => "2.1.290",
    stat: async () => ({ mtimeMs: 1, size: 1 }),
    realpath: async (path) =>
      path === terminal ? join(root, ".local/share/claude/versions/2.1.290") : path,
  })
  const rows = await updates.refresh({ latest: true })
  assert.equal(rows.claude.primary, true, "the session runtime is the row new conversations use")
  assert.equal(rows.claude.binary, bundled)
  assert.equal(rows.claude.installed, "2.1.283")
  assert.equal(rows.claude.latest, "2.1.290", "a newer public release is visible on the session row")
  assert.equal(rows.claude.update, undefined, "the bundled build is updated by updating Mako")
  assert.equal(rows["claude:terminal"].binary, terminal)
  assert.equal(rows["claude:terminal"].channel, "self")
  assert.deepEqual(rows["claude:terminal"].update?.args, ["update"])
  assert.notEqual(rows["claude:terminal"].primary, true)
  console.log("Settings lists the session runtime first and the terminal CLI beside it")
} finally {
  await rm(root, { recursive: true, force: true })
}
