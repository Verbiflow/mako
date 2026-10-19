import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HarnessUpdates } from "@mako/host/contracts/harness-updates"
import { compareVersions, parseVersion, versionBehind } from "@mako/host/contracts/runtime-version"
import { scriptInstall, type ProviderUpdateSource } from "@mako/host/harnesses/update-source"
import { RuntimeUpdates, resolveRuntimeChannel } from "@mako/host/harnesses/runtime-updates"
import { installCommandText, runtimeRowView, runtimeRows, runtimesBehind } from "../src/lib/runtime-updates.ts"
import { featureFloor, featureFloorText, sessionRuntime, tooOld, tooOldText } from "../src/lib/runtime-versions.ts"
import { featureNeeds, runtimeVersions, versionStanding, versionsCompatible, type HarnessVersions } from "@mako/host/contracts/harness-versions"
import { npmInstall, pinnedPolicy } from "@mako/host/harnesses/update-source"
import { runtimeFloor } from "@mako/host/harnesses/runtime-floor"
import { launchContext, reportedRuntime } from "@mako/host/base/execution-context"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"

const processes = new DiscoveryProcesses()

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
  install: [],
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
  install: [],
}
const devin: ProviderUpdateSource = {
  provider: "devin",
  binary: () => null,
  managedBy: [["external_agents", "Zed"]],
  install: [
    { label: "Install", command: "/nonexistent/devin-installer", args: [] },
    scriptInstall("https://cli.devin.ai/install.sh"),
  ],
}
const cursor: ProviderUpdateSource = {
  provider: "cursor",
  binary: () => null,
  native: {
    label: "Update Cursor Agent",
    args: ["update"],
    ownsPath: (path) => path.includes("/.local/share/cursor-agent/"),
  },
  install: [],
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
  onRun?: () => void
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
    processes,
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
      world.onRun?.()
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
  assert.equal(next.changed.length, 0)

  // Every Mako on this Mac rewrites the file: what a newer one added is written back as it was, a newer one's file isn't written at all, and one past what this build reads isn't read.
  const shared = JSON.parse(await readFile(path, "utf8"))
  shared.addedByNewerMako = { kept: true }
  shared.updates.codex.newerField = "kept"
  shared.updates["newer-harness"] = { binary: "/opt/newer", installed: "1.0.0", newerField: "kept" }
  await writeFile(path, JSON.stringify(shared))
  const sharing = service(next, path)
  await sharing.load()
  next.clock += 61 * 60_000
  await sharing.refresh()
  const rewritten = JSON.parse(await readFile(path, "utf8"))
  assert.deepEqual(rewritten.addedByNewerMako, { kept: true }, "a field this build doesn't name survives its rewrite")
  assert.equal(rewritten.updates.codex.newerField, "kept", "so does one inside a reading it rewrote")
  assert.equal(rewritten.updates["newer-harness"].newerField, "kept", "and a harness it doesn't know")
  const newerFile = { ...rewritten, version: 3, reads: 2, readings: "a newer shape" }
  await writeFile(path, JSON.stringify(newerFile))
  const olderBuild = service(next, path)
  await olderBuild.load()
  assert.equal(olderBuild.snapshot().codex.installed, "0.154.0", "a newer Mako's file paints what this build reads of it")
  next.clock += 61 * 60_000
  await olderBuild.refresh()
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), newerFile, "and this build leaves the file to it")
  const pastFile = { ...newerFile, version: 4, reads: 3 }
  await writeFile(path, JSON.stringify(pastFile))
  const pastBuild = service(next, path)
  await pastBuild.load()
  assert.deepEqual(pastBuild.snapshot(), {}, "past what this build reads, it starts from nothing")
  await pastBuild.refresh()
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), pastFile, "and writes nothing")
  await writeFile(path, JSON.stringify(rewritten))

  next.runResult = { code: 0, output: "success without replacing the selected installation" }
  const wrongCopy = await second.update("codex")
  assert.equal(wrongCopy.result?.outcome, "failed", "updating a different copy cannot claim this one is current")
  assert.match(wrongCopy.result?.message ?? "", /still 0.154.0/)
  next.ran.length = 0

  // An update: the plan runs under the channel lock, the binary is read again, the receipt names both versions.
  next.runResult = { code: 0, output: "\nchanged 2 packages in 3s\n" }
  const codexBinary = "/Users/me/.nvm/versions/node/v24.19.0/bin/codex"
  next.emitted.length = 0
  next.onRun = () => {
    next.stats[codexBinary] = { mtimeMs: 9_000, size: 13 }
    next.versions[codexBinary] = "codex-cli 0.155.0"
  }
  const done = await second.update("codex")
  delete next.onRun
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
  assert.equal(next.changed.length, 0, "nothing changed")

  // An unchanged outcome is named as such; a runtime without a plan is refused with its owner.
  next.runResult = { code: 0, output: "up to date" }
  const unchanged = await second.update("codex")
  assert.equal(unchanged.result?.outcome, "unchanged")
  await assert.rejects(second.update("devin"), /does not update through Mako/)
  await assert.rejects(second.update("unknown"), /does not update through Mako/)

  // A missing runtime offers the first installer whose command exists here, and only while it is missing.
  const devinInstall = scriptInstall("https://cli.devin.ai/install.sh")
  assert.deepEqual(second.snapshot().devin.install, devinInstall, "a plan whose command is absent is skipped")
  assert.equal(second.snapshot().codex.install, undefined, "an installed runtime offers no installer")
  await assert.rejects(second.install("codex"), /does not install through Mako/)
  await assert.rejects(second.install("unknown"), /does not install through Mako/)

  // A failed install reports the installer's own words and keeps the plan, so Retry runs it again.
  next.ran.length = 0
  next.runResult = { code: 1, output: "curl: (6) Could not resolve host: cli.devin.ai" }
  const failedInstall = await second.install("devin")
  assert.equal(failedInstall.result?.outcome, "failed")
  assert.match(failedInstall.result?.message ?? "", /Could not resolve host/)
  assert.deepEqual(failedInstall.install, devinInstall)
  assert.equal(failedInstall.phase, undefined)

  // An installer that exits 0 without leaving a binary where the provider looks is a failure, not a success.
  next.runResult = { code: 0, output: "installed somewhere else" }
  const lostInstall = await second.install("devin")
  assert.equal(lostInstall.result?.outcome, "failed")
  assert.match(lostInstall.result?.message ?? "", /cannot find the CLI/)

  // An install: the plan runs as declared, the runtime is read again, discovery is told, the receipt says installed.
  const devinBinary = "/Users/me/.local/bin/devin"
  next.ran.length = 0
  next.changed.length = 0
  next.emitted.length = 0
  next.runResult = { code: 0, output: "Devin CLI installed" }
  next.onRun = () => {
    next.binaries.devin = devinBinary
    next.versions[devinBinary] = "devin 3000.10.23 (deb81600)"
    next.stats[devinBinary] = { mtimeMs: 1, size: 1 }
  }
  const installedDevin = await second.install("devin")
  delete next.onRun
  await settle()
  assert.ok(
    next.emitted.some((batch) => batch.devin?.phase === "installing"),
    "the row said so while the installer ran"
  )
  assert.deepEqual(next.ran, [{ command: "/bin/bash", args: devinInstall.args }])
  assert.equal(installedDevin.binary, devinBinary)
  assert.equal(installedDevin.installed, "3000.10.23")
  assert.equal(installedDevin.install, undefined)
  assert.equal(installedDevin.phase, undefined)
  assert.deepEqual(installedDevin.result, { at: next.clock, outcome: "installed", to: "3000.10.23" })
  assert.deepEqual(next.changed.map((change) => [change.provider, change.to]), [["devin", "3000.10.23"]])
  await assert.rejects(second.install("devin"), /already installed/)

  // `devin setup` signs in at the end of Devin's installer and fails without a terminal: the CLI in place decides.
  const wizard = fake()
  wizard.runResult = { code: 1, output: "Installed devin v3000.11.3\nError: Login canceled" }
  wizard.onRun = () => {
    wizard.binaries.devin = devinBinary
    wizard.versions[devinBinary] = "devin 3000.11.3"
    wizard.stats[devinBinary] = { mtimeMs: 2, size: 2 }
  }
  const wizardService = service(wizard, join(dir, "wizard.json"))
  await wizardService.refresh()
  const afterWizard = await wizardService.install("devin")
  assert.equal(afterWizard.result?.outcome, "installed", "an interactive step after the CLI landed does not fail the install")
  assert.equal(afterWizard.installed, "3000.11.3")
  wizardService.stop()

  // An installer that lands a version the provider does not support has not installed it.
  const retired = fake()
  retired.onRun = () => {
    retired.binaries.devin = devinBinary
    retired.versions[devinBinary] = "devin 1.0.0"
    retired.stats[devinBinary] = { mtimeMs: 3, size: 3 }
  }
  const retiredService = new RuntimeUpdates({
    processes,
    sources: () => [{ ...devin, binary: () => retired.binaries.devin, supportsVersion: (version) => version.startsWith("3000.") }],
    path: join(dir, "retired.json"),
    env: () => ({ PATH: "/usr/bin" }),
    emit: () => undefined,
    version: async (binary) => retired.versions[binary] ?? Promise.reject(new Error("missing")),
    run: async () => {
      retired.onRun?.()
      return { code: 0, output: "installed" }
    },
    stat: async (path) => retired.stats[path] ?? Promise.reject(new Error("ENOENT")),
    realpath: async (path) => path,
    now: () => retired.clock,
  })
  await retiredService.refresh()
  const unsupported = await retiredService.install("devin")
  assert.equal(unsupported.result?.outcome, "failed")
  assert.match(unsupported.result?.message ?? "", /does not support this installed version/)
  retiredService.stop()

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
    processes,
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
  next.runResult = { code: 1, output: "Temporary update error" }
  await second.update("codex")
  next.stats[codexBinary] = { mtimeMs: 10_000, size: 14 }
  next.versions[codexBinary] = "codex-cli 0.156.0"
  const externalUpdate = await second.check("codex")
  assert.equal(externalUpdate.result, undefined, "a detected external update clears the old failure receipt")
  third.stop()
  gated.stop()
  second.stop()
  first.stop()
} finally {
  await rm(dir, { recursive: true, force: true })
}

// The row's words follow the reading.
const now = 10_000_000
assert.deepEqual(runtimeRowView({ phase: "checking" }, now), { detail: "Checking…", busy: true, tone: "faint" })
assert.equal(
  runtimeRowView({ installed: "3000.10.23", checkedAt: now, result: { at: now - 1_000, outcome: "installed", to: "3000.10.23" } }, now).detail,
  "Installed",
  "a fresh install is named until it reads as merely present"
)
assert.equal(installCommandText(scriptInstall("https://cli.devin.ai/install.sh")), "curl -fsSL https://cli.devin.ai/install.sh | bash")
assert.equal(installCommandText({ label: "Install with npm", command: "npm", args: ["install", "-g", "@openai/codex@latest"] }), "npm install -g @openai/codex@latest")
assert.equal(runtimeRowView({ installed: "0.147.0", phase: "updating" }, now).busy, true, "an update in flight reads as work, not a result")
assert.equal(runtimeRowView({ installed: "0.147.0", channel: "npm" }, now).busy, true, "a version with no reading yet is still being checked")
assert.equal(runtimeRowView({ installed: "0.147.0", phase: "checking" }, now).version, "0.147.0", "a re-read keeps the version on screen")
assert.deepEqual(
  runtimeRowView({ installed: "0.147.0", latest: "0.154.0", channel: "npm", update: { label: "Update with npm", command: "npm", args: [] } }, now),
  { version: "0.147.0", detail: "0.154.0 available", action: { label: "Update with npm" }, busy: false, tone: "muted", note: undefined }
)
assert.equal(
  runtimeRowView({ installed: "0.147.0", latest: "0.154.0", channel: "app", managedBy: "ChatGPT.app" }, now).detail,
  "0.154.0 available · Included with ChatGPT"
)
assert.equal(runtimeRowView({ installed: "0.154.0", latest: "0.154.0", channel: "npm" }, now).detail, "Current")
assert.equal(runtimeRowView({ installed: "0.154.0", latest: "0.154.0", channel: "npm" }, now).action, undefined)
assert.equal(runtimeRowView({ installed: "0.154.0-alpha.6.2", latest: "0.154.0", channel: "app", managedBy: "ChatGPT.app" }, now).detail, "0.154.0 available · Included with ChatGPT", "a prerelease is behind its release")
assert.equal(runtimeRowView({ installed: "3000.6.14", channel: "managed", managedBy: "Zed", checkedAt: now }, now).detail, "Update through Zed")
const cursorRow = runtimeRowView({ installed: "2026.09.10-fd3934a", channel: "self", update: { label: "Update Cursor Agent", command: "cursor-agent", args: ["update"] }, checkedAt: now }, now)
assert.deepEqual(cursorRow.action, { label: "Check and update" }, "no public version: the CLI's own updater is the check")
assert.equal(cursorRow.detail, "Checks with its own updater")
assert.equal(runtimeRowView({ installed: "0.154.0", channel: "npm", latestError: "npm registry answered 503", checkedAt: now }, now).detail, "Couldn’t check for updates")
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

// Harness versions: Mako runs what a person has from `oldest` up, installs
// and updates to `tested`, never moves anyone back, and says nothing to
// someone newer than tested.
const declared: HarnessVersions = {
  oldest: "0.146.0",
  tested: "0.159.3",
  checked: { on: "2026-10-12", how: "test" },
  feed: { npm: "@openai/codex" },
  features: { review: { version: "0.155.0", evidence: "test" } },
}
assert.equal(versionStanding("0.140.0", declared), "below-oldest")
assert.equal(versionStanding("0.146.0", declared), "supported", "oldest itself runs")
assert.equal(versionStanding("0.159.3", declared), "tested")
assert.equal(versionStanding("0.162.1", declared), "newer")
assert.equal(versionStanding("0.100.0", { tested: "0.159.3" }), "supported", "no declared floor refuses nothing")
assert.equal(versionStanding("0.0.0-beta-19271", { oldest: "2.0.6", tested: "2.0.27" }, () => false), "supported", "a harness's own floor rule replaces version order")
assert.deepEqual(featureNeeds("0.150.0", declared), { review: "0.155.0" })
assert.equal(featureNeeds("0.155.0", declared), undefined)
assert.equal(runtimeVersions(undefined, declared), undefined, "an unreadable version has no standing, so it stops nothing")
assert.equal(runtimeVersions("2.1.300", { tested: "2.1.283", bundled: { package: "sdk", version: "0.3.283" }, checked: { on: "x", how: "x" }, feed: { npm: "x" } }), undefined,
  "a bundled runtime's row is the person's own CLI, which the declaration doesn't judge")
assert.equal(versionsCompatible("0.150.0", "0.162.1", "0.146.0"), true, "both at or above oldest: the client speaks both")
assert.equal(versionsCompatible("0.140.0", "0.159.3", "0.146.0"), false)
assert.equal(versionsCompatible("0.150.0", "0.159.3", undefined), false, "without a floor a change stays unproven")

// The policy a declaration implies: the registry is asked for tested exactly, and only tested is current.
const pinnedCodex = pinnedPolicy({ ...codex, versions: declared })
assert.equal(pinnedCodex.npmTag, "0.159.3")
assert.equal(pinnedCodex.pinVersion, true)
assert.equal(pinnedCodex.acceptsLatest?.("0.150.0", "0.162.1"), false, "the vendor's newest is not Mako's target")
assert.equal(pinnedPolicy({ ...cursor, versions: { tested: "1.0.31", bundled: { package: "@cursor/sdk", version: "1.0.31" }, checked: { on: "x", how: "x" }, feed: { npm: "x" } } }).pinVersion, undefined,
  "a bundled runtime leaves the person's CLI on its vendor's updates")
assert.deepEqual(npmInstall("@openai/codex", "0.159.3").args.at(-1), "@openai/codex@0.159.3", "an install goes to tested")
assert.equal(scriptInstall("https://x.ai/cli/install.sh", "1.0.46").args.at(-1), "curl -fsSL https://x.ai/cli/install.sh | bash -s 1.0.46")
assert.throws(() => scriptInstall("https://x.ai/cli/install.sh", "1.0.46; rm -rf ~"), /not a version/)

const versionsDir = await mkdtemp(join(tmpdir(), "mako-harness-versions-"))
try {
  const binaries = new Map([
    ["codex", "/Users/me/.nvm/versions/node/v24.19.0/bin/codex"],
    ["brew", "/opt/homebrew/bin/codex"],
    ["grok", "/Users/me/.grok/bin/grok"],
    ["devin", "/Users/me/.local/bin/devin"],
  ])
  const printed = new Map([
    ["/Users/me/.nvm/versions/node/v24.19.0/bin/codex", "codex-cli 0.140.0"],
    ["/opt/homebrew/bin/codex", "codex-cli 0.150.0"],
    ["/Users/me/.grok/bin/grok", "grok 1.0.52 (abc) [stable]"],
    ["/Users/me/.local/bin/devin", "devin 3000.9.1 (abc)"],
  ])
  const reals = new Map([
    ["/Users/me/.nvm/versions/node/v24.19.0/bin/codex", "/Users/me/.nvm/versions/node/v24.19.0/lib/node_modules/@openai/codex/bin/codex.js"],
    ["/opt/homebrew/bin/codex", "/opt/homebrew/Cellar/codex/0.150.0/bin/codex"],
    ["/Users/me/.grok/bin/grok", "/Users/me/.grok/bin/grok-1.0.52"],
    ["/Users/me/.local/bin/devin", "/Users/me/.local/share/devin/cli/_versions/3000.9.1/bin/devin"],
  ])
  const asked: string[] = []
  const world = { runCode: 1, clock: 5_000_000 }
  const grokSource: ProviderUpdateSource = {
    provider: "grok",
    binary: () => binaries.get("grok") ?? null,
    npmPackage: "@xai-official/grok",
    versions: { tested: "1.0.46", checked: { on: "x", how: "x" }, feed: { npm: "x" } },
    native: { label: "Update Grok", args: ["update"], ownsPath: (path) => path.includes("/.grok/bin/"), installVersion: (version) => scriptInstall("https://x.ai/cli/install.sh", version) },
    install: [],
  }
  const devinSource: ProviderUpdateSource = {
    provider: "devin",
    binary: () => binaries.get("devin") ?? null,
    versions: { tested: "3000.10.23", checked: { on: "x", how: "x" }, feed: { npm: "x" } },
    native: { label: "Update Devin", args: [], ownsPath: (path) => path.includes("/.local/share/devin/"), installVersion: (version) => scriptInstall(`https://static.devin.ai/cli/${version}/setup.sh`) },
    install: [],
  }
  const runtimes = new RuntimeUpdates({
    processes,
    sources: () => [
      { ...codex, versions: declared, binary: () => binaries.get("codex") ?? null, installations: [{ id: "brew", label: "Codex (Homebrew)", binary: () => binaries.get("brew") ?? null }] },
      grokSource,
      devinSource,
    ],
    path: join(versionsDir, "runtime-updates.json"),
    env: () => ({ PATH: "/usr/bin" }),
    emit: () => {},
    version: async (binary) => {
      const output = printed.get(binary)
      if (output === undefined) throw new Error(`${binary} would not start`)
      return output
    },
    // The registry answers an exact version with that version.
    latest: async (pkg, tag) => {
      asked.push(`${pkg}@${tag ?? "latest"}`)
      return tag && tag !== "latest" ? tag : "9.9.9"
    },
    run: async () => {
      printed.set("/Users/me/.local/bin/devin", "devin 3000.10.23 (abc)")
      return { code: world.runCode, output: "devin setup needs a terminal" }
    },
    stat: async () => ({ mtimeMs: world.clock, size: 1 }),
    realpath: async (path) => reals.get(path) ?? path,
    now: () => world.clock,
  })
  const read = await runtimes.refresh({ latest: true })

  // Below oldest on npm: the one standing that asks for anything, with an update to tested.
  assert.deepEqual(read.codex.versions, { oldest: "0.146.0", tested: "0.159.3", standing: "below-oldest", needs: { review: "0.155.0" } })
  assert.equal(read.codex.latest, "0.159.3", "the registry is asked for tested, not the vendor's newest")
  assert.deepEqual(read.codex.update?.args.at(-1), "@openai/codex@0.159.3", "Update goes to tested")
  assert.ok(asked.includes("@openai/codex@0.159.3"))
  const row = runtimeRowView(read.codex)
  assert.equal(row.tone, "caution")
  assert.equal(row.detail, "Mako needs 0.146.0 or newer")
  assert.equal(row.action?.label, "Update with npm")

  // Homebrew can't pin: a brew install at or above oldest stays on brew's version, with no Update.
  assert.equal(read["codex:brew"].versions?.standing, "supported", "an installation inherits its harness's declaration")
  assert.equal(read["codex:brew"].update, undefined, "Homebrew is never asked to move a supported install")

  // Newer than tested: runs, no Update, no downgrade, a quiet line in Settings and nothing in the composer.
  assert.equal(read.grok.versions?.standing, "newer")
  assert.equal(read.grok.update, undefined, "an install above tested is left alone")
  const newer = runtimeRowView(read.grok)
  assert.equal(newer.detail, "Newer than Mako has tested")
  assert.equal(newer.tone, "faint")
  assert.equal(newer.action, undefined)
  assert.equal(tooOld(read, "grok"), undefined, "the composer says nothing to a fast upgrader")

  // No registry publishes Devin's CLI: tested is the release, and its own installer takes the version.
  assert.equal(read.devin.latest, "3000.10.23")
  assert.equal(read.devin.versions?.standing, "supported")
  assert.deepEqual(read.devin.update, { label: "Update Devin", command: "/bin/bash", args: ["-o", "pipefail", "-c", "curl -fsSL https://static.devin.ai/cli/3000.10.23/setup.sh | bash"] },
    "a CLI whose own updater goes to the vendor's newest is updated by its pinned installer")
  // The setup script ends in an interactive `devin setup` that fails without a terminal; the binary decides.
  world.clock += 1_000
  const updated = await runtimes.update("devin")
  assert.equal(updated.result?.outcome, "updated", "a failed last step after the right version landed is still an update")
  assert.equal(updated.installed, "3000.10.23")
  assert.equal(updated.versions?.standing, "tested")
  assert.equal(updated.update, undefined, "at tested, nothing more is offered")

  // The composer's view of the same readings.
  assert.equal(sessionRuntime(read, "codex")?.id, "codex", "the harness's own row is the one sessions run")
  const blocked = tooOld(read, "codex")
  assert.ok(blocked)
  assert.equal(tooOldText("Codex", blocked), "Codex 0.140.0 is older than Mako supports. Mako needs 0.146.0 or newer.")
  assert.equal(blocked.update, "Update with npm")
  const floor = featureFloor(read, "codex", "review")
  assert.ok(floor)
  assert.equal(featureFloorText("Codex", "Code review", floor), "Code review needs Codex 0.155.0 or newer; this one is 0.140.0.")
  assert.equal(featureFloor(read, "codex", "goals"), undefined, "a feature without a declared floor is never refused")
  assert.equal(tooOld({ codex: { binary: "/x/codex", error: "codex --version exited with 1" } }, "codex"), undefined, "an unreadable version blocks nothing")

  // Readings an earlier host kept meet today's declaration.
  const persisted = JSON.parse(await readFile(join(versionsDir, "runtime-updates.json"), "utf8"))
  assert.equal(persisted.updates.codex.versions, undefined, "the standing is derived, never stored")
  assert.equal(runtimes.snapshot().codex.versions?.standing, "below-oldest")

  // The launch backstop: a reported runtime below oldest is refused with the same words, and nothing else is.
  const floorCheck = runtimeFloor((provider) => provider === "codex" ? { ...codex, versions: declared } : undefined, () => "Codex")
  const launched = launchContext("app-server", { kind: "unavailable", reason: "test" })
  const reported = (version: string) => ({ ...launched, runtime: reportedRuntime(version, "initialize") })
  assert.match(floorCheck.refusal("codex", reported("0.140.0")) ?? "", /^Codex 0\.140\.0 is older than Mako supports\. Mako needs 0\.146\.0 or newer\./)
  assert.equal(floorCheck.refusal("codex", reported("0.162.1")), undefined, "newer than tested runs")
  assert.equal(floorCheck.refusal("codex", launched), undefined, "an unreported version runs")
  assert.equal(floorCheck.refusal("grok", reported("0.0.1")), undefined, "a harness with no declaration runs")
  assert.equal(floorCheck.oldest("codex"), "0.146.0")
} finally {
  await rm(versionsDir, { recursive: true, force: true })
}

console.log("runtime updates: channel ladder, signature cache, registry TTL, persistence, update receipts and row words hold")
