import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessUpdates } from "../electron/contracts/harness-updates.ts"
import { compareVersions, parseVersion, versionBehind } from "../electron/contracts/runtime-version.ts"
import type { ProviderUpdateSource } from "../electron/providers/update-source.ts"
import { RuntimeUpdates, resolveRuntimeChannel } from "../electron/runtime-updates.ts"
import { runtimeRowView, runtimeRows, runtimesBehind } from "../src/lib/runtime-updates.ts"

// Versions the way CLIs print them, ordered the way a person would.
assert.equal(parseVersion("codex-cli 0.147.0"), "0.147.0")
assert.equal(parseVersion("2.1.266 (Claude Code)"), "2.1.266")
assert.equal(parseVersion("2026.09.10-fd3934a"), "2026.09.10-fd3934a")
assert.equal(parseVersion("codex-cli 0.154.0-alpha.6.2\n"), "0.154.0-alpha.6.2")
assert.equal(parseVersion("no version here"), undefined)
assert.equal(compareVersions("0.147.0", "0.154.0"), -1)
assert.equal(compareVersions("0.154.0-alpha.6.2", "0.154.0"), -1, "a prerelease precedes its release")
assert.equal(compareVersions("0.154.0-alpha.6.2", "0.154.0-alpha.6.10"), -1, "numeric identifiers compare as numbers")
assert.equal(compareVersions("v2.1.266", "2.1.266"), 0)
assert.equal(compareVersions("2026.09.12-abc", "2026.09.10-fd3934a"), 1)
assert.equal(compareVersions("1.18.30", "1.18"), 1)
assert.equal(versionBehind("0.147.0", "0.154.0"), true)
assert.equal(versionBehind("0.154.0", "0.154.0"), false)
assert.equal(versionBehind("0.155.0", "0.154.0"), false, "ahead of the registry is not behind")
assert.equal(versionBehind(undefined, "0.154.0"), null)

// The channel ladder reads the binary's path and real path.
const codex: ProviderUpdateSource = {
  provider: "codex",
  binary: () => null,
  npmPackage: "@openai/codex",
  homebrew: { name: "codex" },
}
const claude: ProviderUpdateSource = {
  provider: "claude",
  binary: () => null,
  npmPackage: "@anthropic-ai/claude-code",
  homebrew: { name: "claude-code", cask: true },
  native: {
    label: "Update Claude Code",
    args: ["update"],
    ownsPath: (path) => path.includes("/.local/share/claude/") || path.endsWith("/.local/bin/claude"),
  },
}
const devin: ProviderUpdateSource = {
  provider: "devin",
  binary: () => null,
  managedBy: [["external_agents", "Zed"]],
}
const cursor: ProviderUpdateSource = {
  provider: "cursor",
  binary: () => null,
  native: {
    label: "Update Cursor Agent",
    args: ["update"],
    ownsPath: (path) => path.includes("/.local/share/cursor-agent/"),
  },
}
assert.deepEqual(
  resolveRuntimeChannel(
    codex,
    "/Users/me/.nvm/versions/node/v24.19.0/bin/codex",
    "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/bin/codex.js"
  ),
  {
    channel: "npm",
    update: {
      label: "Update with npm",
      command: "npm",
      args: ["install", "-g", "--allow-scripts=@openai/codex", "@openai/codex@latest"],
    },
  },
  "an nvm symlink resolves into lib/node_modules and updates through npm at @latest with its scripts allowed"
)
assert.deepEqual(
  resolveRuntimeChannel(codex, "/Applications/ChatGPT.app/Contents/Resources/codex", "/Applications/ChatGPT.app/Contents/Resources/codex"),
  { channel: "app", managedBy: "ChatGPT.app" },
  "a binary inside an app bundle is that app's to update"
)
assert.deepEqual(
  resolveRuntimeChannel(codex, "/opt/homebrew/bin/codex", "/opt/homebrew/Cellar/codex/0.154.0/bin/codex"),
  { channel: "brew", update: { label: "Update with Homebrew", command: "brew", args: ["upgrade", "codex"] } }
)
assert.deepEqual(
  resolveRuntimeChannel(claude, "/opt/homebrew/bin/claude", "/opt/homebrew/Caskroom/claude-code/2.1.236/claude"),
  { channel: "brew", update: { label: "Update with Homebrew", command: "brew", args: ["upgrade", "--cask", "claude-code"] } },
  "a cask upgrades as a cask"
)
assert.deepEqual(
  resolveRuntimeChannel(cursor, "/opt/homebrew/bin/cursor-agent", "/opt/homebrew/Cellar/cursor-cli/1.0/bin/cursor-agent"),
  { channel: "brew", managedBy: "Homebrew" },
  "a Homebrew install of a runtime with no declared formula is shown, never upgraded blind"
)
assert.deepEqual(
  resolveRuntimeChannel(claude, "/Users/me/.local/bin/claude", "/Users/me/.local/share/claude/versions/2.1.266"),
  { channel: "self", update: { label: "Update Claude Code", command: "/Users/me/.local/bin/claude", args: ["update"] } },
  "the native installer's layout runs the CLI's own updater, by the resolved binary"
)
assert.deepEqual(
  resolveRuntimeChannel(claude, "/Users/me/.bun/bin/claude", "/Users/me/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js"),
  { channel: "bun", update: { label: "Update with bun", command: "bun", args: ["add", "-g", "@anthropic-ai/claude-code@latest"] } }
)
assert.deepEqual(
  resolveRuntimeChannel(claude, "/Users/me/Library/pnpm/claude", "/Users/me/Library/pnpm/global/5/node_modules/@anthropic-ai/claude-code/cli.js"),
  { channel: "pnpm", update: { label: "Update with pnpm", command: "pnpm", args: ["add", "-g", "@anthropic-ai/claude-code@latest"] } }
)
assert.deepEqual(
  resolveRuntimeChannel(
    devin,
    "/Users/me/Library/Application Support/Zed/external_agents/registry/devin/v_3000/bin/devin",
    "/Users/me/Library/Application Support/Zed/external_agents/registry/devin/v_3000/bin/devin"
  ),
  { channel: "managed", managedBy: "Zed" }
)
assert.deepEqual(
  resolveRuntimeChannel(cursor, "/usr/local/bin/cursor-agent", "/usr/local/bin/cursor-agent"),
  { channel: "manual" },
  "a path Mako cannot place is shown and left alone"
)
assert.deepEqual(
  resolveRuntimeChannel(codex, "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/.bin/codex", "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/bin/codex.js").channel,
  "npm"
)

// The service: readings, caching by binary signature, the registry's TTL, events, persistence, updates.
interface Fake {
  binaries: Record<string, string | null>
  versions: Record<string, string>
  stats: Record<string, { mtimeMs: number; size: number }>
  latest: Record<string, string | Error>
  reals: Record<string, string>
  spawned: string[]
  fetched: string[]
  ran: Array<{ command: string; args: string[] }>
  runResult: { code: number | null; output: string }
  clock: number
  emitted: HarnessUpdates[]
  changed: Array<{ provider: string; from?: string; to?: string }>
}

function fake(): Fake {
  return {
    binaries: {
      codex: "/Users/me/.nvm/versions/node/v24.19.0/bin/codex",
      claude: "/Users/me/.local/bin/claude",
      devin: null,
    },
    versions: {
      "/Users/me/.nvm/versions/node/v24.19.0/bin/codex": "codex-cli 0.147.0",
      "/Users/me/.local/bin/claude": "2.1.266 (Claude Code)",
    },
    stats: {
      "/Users/me/.nvm/versions/node/v24.19.0/bin/codex": { mtimeMs: 1_000, size: 10 },
      "/Users/me/.local/bin/claude": { mtimeMs: 2_000, size: 20 },
    },
    latest: { "@openai/codex": "0.154.0", "@anthropic-ai/claude-code": "2.1.266" },
    reals: {
      "/Users/me/.nvm/versions/node/v24.19.0/bin/codex":
        "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/bin/codex.js",
      "/Users/me/.local/bin/claude": "/Users/me/.local/share/claude/versions/2.1.266",
    },
    spawned: [],
    fetched: [],
    ran: [],
    runResult: { code: 0, output: "changed 2 packages" },
    clock: 1_000_000,
    emitted: [],
    changed: [],
  }
}

function service(world: Fake, path: string, options: { startDelayMs?: number } = {}) {
  const sources: ProviderUpdateSource[] = [
    { ...codex, binary: () => world.binaries.codex },
    { ...claude, binary: () => world.binaries.claude },
    { ...devin, binary: () => world.binaries.devin },
  ]
  return new RuntimeUpdates({
    sources: () => sources,
    path,
    env: () => ({ PATH: "/usr/bin" }),
    emit: (updates) => world.emitted.push(updates),
    onRuntimeChanged: (change) => world.changed.push(change),
    version: async (binary) => {
      world.spawned.push(binary)
      const output = world.versions[binary]
      if (output === undefined) throw new Error(`${binary} would not start`)
      return output
    },
    latest: async (pkg) => {
      world.fetched.push(pkg)
      const answer = world.latest[pkg]
      if (answer instanceof Error) throw answer
      if (!answer) throw new Error("npm registry answered 404")
      return answer
    },
    run: async (command, args) => {
      world.ran.push({ command, args })
      return world.runResult
    },
    stat: async (path) => {
      const entry = world.stats[path]
      if (!entry) throw new Error("ENOENT")
      return entry
    },
    realpath: async (path) => world.reals[path] ?? path,
    now: () => world.clock,
    startDelayMs: options.startDelayMs ?? 5_000,
    latestTtlMs: 60 * 60_000,
    latestRetryMs: 10 * 60_000,
    installedTtlMs: 10 * 60_000,
  })
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 5))

const dir = await mkdtemp(join(tmpdir(), "mako-runtime-updates-"))
try {
  const path = join(dir, "runtime-updates.json")
  const world = fake()
  const first = service(world, path)
  await first.load()
  assert.deepEqual(first.snapshot(), {}, "nothing read yet")
  assert.deepEqual(await first.read(), {}, "read answers at once and starts the pass behind it")
  const updates = await first.refresh()
  await settle()

  const codexInfo = updates.codex
  assert.equal(codexInfo.installed, "0.147.0")
  assert.equal(codexInfo.latest, "0.154.0")
  assert.equal(codexInfo.channel, "npm")
  assert.equal(codexInfo.update?.command, "npm")
  assert.equal(codexInfo.checkedAt, world.clock)
  assert.equal(codexInfo.phase, undefined, "a finished reading carries no phase")
  assert.equal(updates.claude.channel, "self")
  assert.equal(updates.claude.update?.command, "/Users/me/.local/bin/claude")
  assert.equal(updates.devin.binary, undefined, "a runtime that is not installed has no row")
  assert.equal(updates.devin.error, undefined)
  assert.deepEqual(world.spawned.sort(), ["/Users/me/.local/bin/claude", "/Users/me/.nvm/versions/node/v24.19.0/bin/codex"])
  assert.deepEqual(world.fetched.sort(), ["@anthropic-ai/claude-code", "@openai/codex"])
  assert.deepEqual(world.changed, [], "the first reading is not a change")

  // The installed reading was published before the registry answered.
  const codexStates = world.emitted.map((batch) => batch.codex).filter(Boolean)
  assert.equal(codexStates[0]?.phase, "checking", "a pass announces itself")
  const installedFirst = codexStates.find((state) => state.installed && !state.phase)
  assert.ok(installedFirst, "the installed reading was emitted")
  assert.equal(installedFirst.latest, undefined, "the installed reading did not wait on the network")

  // A second pass spawns nothing while the binaries have not moved, and does not ask the registry inside its TTL.
  world.spawned.length = 0
  world.fetched.length = 0
  world.clock += 60_000
  await first.refresh()
  assert.deepEqual(world.spawned, [], "an unchanged binary is not spawned again")
  assert.deepEqual(world.fetched, [], "the public version stands for an hour")

  // The file moved: `npm i -g` in a terminal. The version is read again and discovery is told.
  world.stats["/Users/me/.nvm/versions/node/v24.19.0/bin/codex"] = { mtimeMs: 5_000, size: 12 }
  world.versions["/Users/me/.nvm/versions/node/v24.19.0/bin/codex"] = "codex-cli 0.154.0"
  await first.refresh()
  assert.deepEqual(world.spawned, ["/Users/me/.nvm/versions/node/v24.19.0/bin/codex"])
  assert.deepEqual(world.changed, [{ provider: "codex", from: "0.147.0", to: "0.154.0" }])
  assert.equal(first.snapshot().codex.installed, "0.154.0")
  assert.equal(versionBehind(first.snapshot().codex.installed, first.snapshot().codex.latest), false)

  // The registry fails: the installed reading stands, the failure is held briefly, then asked again.
  world.latest["@openai/codex"] = new Error("npm registry answered 503")
  world.clock += 61 * 60_000
  world.fetched.length = 0
  await first.refresh()
  assert.equal(first.snapshot().codex.installed, "0.154.0")
  assert.equal(first.snapshot().codex.latest, "0.154.0", "the last public reading is kept")
  assert.equal(first.snapshot().codex.latestError, "npm registry answered 503")
  world.fetched.length = 0
  world.clock += 5 * 60_000
  await first.refresh()
  assert.deepEqual(world.fetched, [], "a failed public reading is held ten minutes")
  world.clock += 6 * 60_000
  world.latest["@openai/codex"] = "0.155.0"
  await first.refresh()
  assert.deepEqual(world.fetched.filter((pkg) => pkg === "@openai/codex"), ["@openai/codex"])
  assert.equal(first.snapshot().codex.latest, "0.155.0")
  assert.equal(first.snapshot().codex.latestError, undefined)

  // `read` re-reads only when the installed reading is old or when asked.
  world.spawned.length = 0
  world.fetched.length = 0
  await first.read()
  await settle()
  assert.deepEqual(world.fetched, [], "a fresh reading is answered from memory")
  await first.read(true)
  await first.refresh()
  await settle()
  assert.deepEqual(world.fetched.sort(), ["@anthropic-ai/claude-code", "@openai/codex"], "an explicit refresh asks the registry again")

  // Persisted: the next host paints the last reading, without phases, and needs no spawn for an unchanged binary.
  const stored = JSON.parse(await readFile(path, "utf8"))
  assert.equal(stored.updates.codex.installed, "0.154.0")
  assert.equal(stored.updates.codex.phase, undefined)
  const next = fake()
  next.stats = world.stats
  next.versions = world.versions
  next.latest = { "@openai/codex": "0.155.0", "@anthropic-ai/claude-code": "2.1.266" }
  next.clock = world.clock + 1_000
  const second = service(next, path)
  await second.load()
  assert.equal(second.snapshot().codex.installed, "0.154.0", "the last host's reading paints first")
  assert.equal(second.snapshot().codex.latest, "0.155.0")
  await second.refresh()
  assert.deepEqual(next.spawned, [], "the persisted signature spares the spawn")
  assert.deepEqual(next.changed, [])

  // An update: the plan runs under the channel lock, the binary is read again, the receipt names both versions.
  next.runResult = { code: 0, output: "\nchanged 2 packages in 3s\n" }
  const codexBinary = "/Users/me/.nvm/versions/node/v24.19.0/bin/codex"
  next.emitted.length = 0
  const update = second.update("codex")
  // The updater replaced the file.
  next.stats[codexBinary] = { mtimeMs: 9_000, size: 13 }
  next.versions[codexBinary] = "codex-cli 0.155.0"
  const done = await update
  await settle()
  assert.ok(
    next.emitted.some((batch) => batch.codex?.phase === "updating"),
    "the row said so while the updater ran"
  )
  assert.equal(next.ran.length, 1)
  assert.match(next.ran[0].command, /npm$/, "the plan's command is resolved on the host's PATH")
  assert.deepEqual(
    next.ran[0].args,
    ["install", "-g", "--allow-scripts=@openai/codex", "@openai/codex@latest"],
    "the plan ran as declared"
  )
  assert.equal(done.installed, "0.155.0")
  assert.equal(done.phase, undefined)
  assert.deepEqual(done.result, { at: next.clock, outcome: "updated", from: "0.154.0", to: "0.155.0" })
  assert.deepEqual(next.changed, [{ provider: "codex", from: "0.154.0", to: "0.155.0" }], "discovery is told once")

  // An updater that fails keeps the reading and reports its own last words.
  next.runResult = { code: 1, output: "npm ERR! code EACCES\nnpm ERR! syscall mkdir\nnpm ERR! path /usr/lib/node_modules\nnpm ERR! Error: EACCES: permission denied" }
  next.changed.length = 0
  const failed = await second.update("codex")
  assert.equal(failed.result?.outcome, "failed")
  assert.match(failed.result?.message ?? "", /EACCES: permission denied/)
  assert.equal(failed.installed, "0.155.0", "the reading stands")
  assert.equal(failed.phase, undefined)
  assert.deepEqual(next.changed, [], "nothing changed")

  // An unchanged outcome is named as such; a runtime without a plan is refused with its owner.
  next.runResult = { code: 0, output: "up to date" }
  const unchanged = await second.update("codex")
  assert.equal(unchanged.result?.outcome, "unchanged")
  await assert.rejects(second.update("devin"), /does not update through Mako/)
  await assert.rejects(second.update("unknown"), /does not update through Mako/)

  // Two updates on one channel run one after the other; a second update of one runtime is refused.
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const order: string[] = []
  const third = service(next, path)
  await third.load()
  const originalRun = next.runResult
  const gated = new RuntimeUpdates({
    sources: () => [
      { ...codex, binary: () => codexBinary },
      { ...claude, binary: () => "/Users/me/.nvm/versions/node/v24.19.0/bin/claude" },
    ],
    path: join(dir, "gated.json"),
    env: () => ({}),
    emit: () => undefined,
    version: async (binary) => (binary.endsWith("codex") ? "0.1.0" : "0.2.0"),
    latest: async () => "9.9.9",
    stat: async () => ({ mtimeMs: 1, size: 1 }),
    realpath: async (path) =>
      path.endsWith("codex")
        ? "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/bin/codex.js"
        : "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/@anthropic-ai/claude-code/cli.js",
    run: async (_command, args) => {
      order.push(`start ${args.at(-1)}`)
      if (args.at(-1)?.startsWith("@openai")) await gate
      order.push(`end ${args.at(-1)}`)
      return originalRun
    },
    now: () => next.clock,
  })
  await gated.refresh()
  const codexUpdate = gated.update("codex")
  await settle()
  const claudeUpdate = gated.update("claude")
  await settle()
  await assert.rejects(gated.update("codex"), /already updating/)
  assert.deepEqual(order, ["start @openai/codex@latest"], "the second npm install waits for the first")
  release()
  await Promise.all([codexUpdate, claudeUpdate])
  assert.deepEqual(order, [
    "start @openai/codex@latest",
    "end @openai/codex@latest",
    "start @anthropic-ai/claude-code@latest",
    "end @anthropic-ai/claude-code@latest",
  ])
  third.stop()
  gated.stop()
  second.stop()
  first.stop()
} finally {
  await rm(dir, { recursive: true, force: true })
}

// The row's words follow the reading.
const now = 10_000_000
assert.deepEqual(runtimeRowView({ phase: "checking" }, now), { version: "…", detail: "Checking…", shimmer: true, tone: "faint" })
assert.equal(runtimeRowView({ installed: "0.147.0", phase: "checking" }, now).version, "0.147.0", "a re-read keeps the version on screen")
assert.deepEqual(
  runtimeRowView({ installed: "0.147.0", latest: "0.154.0", channel: "npm", update: { label: "Update with npm", command: "npm", args: [] } }, now),
  { version: "0.147.0", detail: "0.154.0 available", action: { label: "Update with npm" }, shimmer: false, tone: "muted", note: undefined }
)
assert.equal(
  runtimeRowView({ installed: "0.147.0", latest: "0.154.0", channel: "app", managedBy: "ChatGPT.app" }, now).detail,
  "0.154.0 available · Updates come with ChatGPT.app"
)
assert.equal(runtimeRowView({ installed: "0.154.0", latest: "0.154.0", channel: "npm" }, now).detail, "Current")
assert.equal(runtimeRowView({ installed: "0.154.0", latest: "0.154.0", channel: "npm" }, now).action, undefined)
assert.equal(runtimeRowView({ installed: "0.154.0-alpha.6.2", latest: "0.154.0", channel: "app", managedBy: "ChatGPT.app" }, now).detail, "0.154.0 available · Updates come with ChatGPT.app", "a prerelease is behind its release")
assert.equal(runtimeRowView({ installed: "3000.6.14", channel: "managed", managedBy: "Zed", checkedAt: now }, now).detail, "Updates come from Zed")
const cursorRow = runtimeRowView({ installed: "2026.09.10-fd3934a", channel: "self", update: { label: "Update Cursor Agent", command: "cursor-agent", args: ["update"] }, checkedAt: now }, now)
assert.deepEqual(cursorRow.action, { label: "Check for updates" }, "no public version: the CLI's own updater is the check")
assert.equal(cursorRow.detail, "Checks with its own updater")
assert.equal(runtimeRowView({ installed: "0.154.0", channel: "npm", latestError: "npm registry answered 503", checkedAt: now }, now).detail, "Latest version unknown")
assert.equal(runtimeRowView({ installed: "0.154.0", channel: "brew", managedBy: "Homebrew", checkedAt: now }, now).detail, "Installed with Homebrew")
const updating = runtimeRowView({ installed: "0.147.0", latest: "0.154.0", phase: "updating", update: { label: "Update with npm", command: "npm", args: [] } }, now)
assert.equal(updating.detail, "Updating…")
assert.equal(updating.action, undefined, "no second update while one runs")
const failedRow = runtimeRowView(
  { installed: "0.147.0", latest: "0.154.0", channel: "npm", update: { label: "Update with npm", command: "npm", args: [] }, result: { at: now - 1_000, outcome: "failed", message: "EACCES: permission denied" } },
  now
)
assert.equal(failedRow.note, "Update failed: EACCES: permission denied")
assert.deepEqual(failedRow.action, { label: "Try again" })
assert.equal(
  runtimeRowView({ installed: "0.154.0", latest: "0.154.0", channel: "npm", result: { at: now - 30_000, outcome: "updated", from: "0.147.0", to: "0.154.0" } }, now).detail,
  "Updated from 0.147.0"
)
assert.equal(
  runtimeRowView({ installed: "0.154.0", latest: "0.154.0", channel: "npm", result: { at: now - 10 * 60_000, outcome: "updated", from: "0.147.0", to: "0.154.0" } }, now).detail,
  "Current",
  "a finished update is named for five minutes, then the row is merely current"
)
assert.equal(runtimeRowView({ binary: "/x/codex", error: "codex --version exited with 1", checkedAt: now }, now).tone, "negative")
assert.deepEqual(
  runtimeRows({ codex: { binary: "/x", installed: "1" }, devin: { checkedAt: now }, claude: { binary: "/y" } }).map(([id]) => id),
  ["claude", "codex"],
  "rows are the runtimes found, in a stable order"
)
assert.deepEqual(
  runtimesBehind({ codex: { binary: "/x", installed: "0.147.0", latest: "0.154.0" }, claude: { binary: "/y", installed: "2.1.266", latest: "2.1.266" } }),
  ["codex"]
)

console.log("runtime updates: channel ladder, signature cache, registry TTL, persistence, update receipts and row words hold")
