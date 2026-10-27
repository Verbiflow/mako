import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { compareVersions, parseVersion } from "@mako/host/contracts/runtime-version"
import { resolveExecutable } from "@mako/host/base/executable"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { RuntimeUpdates } from "@mako/host/harnesses/runtime-updates"
import type { ProviderUpdateSource, RuntimeUpdateSource } from "@mako/host/harnesses/update-source"

/**
 * An update Mako runs lands on the binary Mako runs, and says so when it doesn't; what a reading offers is what an
 * update runs, for every harness on every kind of install; and a reading asked for is taken after the ask.
 *
 * Production met all three on one Mac (2026-10-27): nvm's node with an `.npmrc` naming `prefix=/opt/homebrew`, so
 * `npm install -g @openai/codex@0.164.0` put a second Codex under /opt/homebrew and left the one Mako runs at
 * 0.159.3; OpenCode offered "Update" and then refused it; and a refresh right after an update answered the old
 * versions. Nothing here touches the person's installs: npm runs against a scratch prefix, a scratch home and a
 * registry served from this process, and every other harness's binaries are fakes.
 */

const run = promisify(execFile)
const processes = new DiscoveryProcesses()
// Real, so a prefix read off a binary's real path reads as the folder made here (/var is /private/var on macOS).
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-update-paths-")))

try {
  // 1. npm: the update goes to the prefix the binary Mako runs lives under, whatever npm's config names.
  {
    const scratch = join(root, "npm")
    const nvm = join(scratch, "nvm", "versions", "node", "v24.19.0")
    const elsewhere = join(scratch, "homebrew")
    const home = join(scratch, "home")
    for (const dir of [nvm, elsewhere, home, join(scratch, "cache"), join(scratch, "packages")]) await mkdir(dir, { recursive: true })
    // A registry of this process's own, serving a Codex package of each version.
    const tarballs = new Map<string, Buffer>()
    const server = createServer((request, response) => {
      const url = request.url ?? ""
      const version = url.match(/\/codex-(\d+\.\d+\.\d+)\.tgz$/)?.[1]
      const tarball = version ? tarballs.get(version) : undefined
      if (tarball) return void response.end(tarball)
      if (decodeURIComponent(url).toLowerCase() !== "/@openai/codex") return void response.writeHead(404).end("{}")
      response.setHeader("content-type", "application/json")
      response.end(JSON.stringify({
        name: "@openai/codex",
        "dist-tags": { latest: "0.164.0" },
        versions: Object.fromEntries([...tarballs].map(([each, bytes]) => [each, {
          name: "@openai/codex",
          version: each,
          bin: { codex: "bin/codex.js" },
          dist: {
            tarball: `${registry}@openai/codex/-/codex-${each}.tgz`,
            shasum: createHash("sha1").update(bytes).digest("hex"),
            integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
          },
        }])),
      }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const registry = `http://127.0.0.1:${z.object({ port: z.number() }).parse(server.address()).port}/`
    try {
      // npm's own config names another tree than the node Mako's Codex runs under, as this Mac's `.npmrc` did.
      await writeFile(join(home, ".npmrc"), `prefix=${elsewhere}\n`)
      const scratchNpm: NodeJS.ProcessEnv = {
        HOME: home,
        npm_config_userconfig: join(home, ".npmrc"),
        npm_config_globalconfig: join(scratch, "global-npmrc"),
        // Held in the environment as well, so no npm here writes outside the scratch folder whatever its builtin config says.
        npm_config_prefix: elsewhere,
        npm_config_cache: join(scratch, "cache"),
        npm_config_registry: registry,
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      }
      for (const version of ["0.159.3", "0.164.0"]) {
        const dir = join(scratch, "packages", version)
        await mkdir(join(dir, "bin"), { recursive: true })
        await writeFile(join(dir, "package.json"), JSON.stringify({ name: "@openai/codex", version, bin: { codex: "bin/codex.js" } }))
        await writeFile(join(dir, "bin", "codex.js"), `#!/usr/bin/env node\nconsole.log("codex-cli ${version}")\n`, { mode: 0o755 })
        const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", join(scratch, "packages")], { cwd: dir, env: { ...scratchNpm, PATH: process.env.PATH } })
        const [packed] = z.array(z.object({ filename: z.string() })).parse(JSON.parse(stdout))
        tarballs.set(version, await readFile(join(scratch, "packages", packed?.filename ?? "")))
      }
      const env: NodeJS.ProcessEnv = { ...scratchNpm, PATH: [join(nvm, "bin"), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter) }
      await run("npm", ["install", "-g", "--prefix", nvm, "@openai/codex@0.159.3"], { env })
      assert.equal((await run("npm", ["config", "get", "prefix"], { env })).stdout.trim(), elsewhere, "the trap: npm's own prefix is another tree")
      const codex: ProviderUpdateSource = {
        provider: "codex",
        binary: (each) => resolveExecutable("codex", each),
        npmPackage: "@openai/codex",
        versions: { tested: "0.164.0", checked: { on: "2026-10-27", how: "fixture" }, feed: { npm: "@openai/codex" } },
        install: [],
      }
      const updates = new RuntimeUpdates({ processes, sources: () => [codex], path: join(scratch, "readings.json"), env: () => env, emit: () => {}, latest: async () => "0.164.0" })
      const offered = (await updates.refresh()).codex
      assert.equal(offered.binary, join(nvm, "bin", "codex"))
      assert.equal(offered.installed, "0.159.3")
      const done = await updates.update("codex")
      assert.equal(existsSync(join(elsewhere, "lib", "node_modules", "@openai", "codex")), false, "no second copy goes where npm's config points")
      assert.deepEqual(done.result && { outcome: done.result.outcome, from: done.result.from, to: done.result.to, message: done.result.message }, { outcome: "updated", from: "0.159.3", to: "0.164.0", message: undefined }, "the binary Mako runs is the one updated")
      assert.equal(done.installed, "0.164.0")
      assert.deepEqual(offered.update?.args, ["install", "-g", "--prefix", nvm, "--allow-scripts=@openai/codex", "@openai/codex@0.164.0"], "the offer named the prefix it installs into")
      assert.match((await run(join(nvm, "bin", "codex"), [], { env })).stdout, /codex-cli 0\.164\.0/)
      updates.stop()
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  // 2. Every harness, on every kind of install it can have: what the reading offers is what the update runs, even
  //    when the registry is down at the moment of the click; a reading that offers nothing refuses with why.
  {
    const scratch = join(root, "offers")
    const host = createHarnessHost(detachedHarnessContext(new NativeStores(false), join(scratch, "data")))
    const sources = host.updateSources.list()
    const keys = sources.flatMap((source) => [
      { source, installation: source satisfies RuntimeUpdateSource, key: source.provider },
      ...(source.installations ?? []).map((installation) => ({ source, installation, key: `${source.provider}:${installation.id}` })),
    ])
    assert.ok(keys.length >= 6, "every harness Mako ships")
    // A file at each path an update could run, so the command resolves; the fakes print nothing and change nothing.
    const bin = join(scratch, "bin")
    await mkdir(bin, { recursive: true })
    for (const tool of ["npm", "bun", "pnpm"]) await writeFile(join(bin, tool), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    const env: NodeJS.ProcessEnv = { PATH: [bin, "/usr/bin", "/bin"].join(delimiter), HOME: join(scratch, "home") }
    const placed = async (path: string) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, "#!/bin/sh\nexit 0\n")
      await chmod(path, 0o755)
      return path
    }
    let checked = 0
    let offeredUpdates = 0
    for (const { source, installation, key } of keys) {
      const name = basename(key.split(":").at(-1) === "terminal" ? "claude" : source.provider)
      const tested = (installation.versions ?? source.versions)?.tested
      const below = tested ? older(tested) : "1.0.0"
      // What a harness says of its runtime, with what it says once its version is read (OpenCode's feed and updater).
      const policy = { ...source, ...installation, ...installation.release?.(below, "/fixture", "/fixture", env) }
      // The installs a harness can have: npm's global, the CLI's own root, a Homebrew keg, an app bundle, another app's registry.
      const placements: Array<{ kind: string; binary: string; real: string }> = []
      if (policy.npmPackage) {
        const prefix = join(scratch, key.replace(":", "-"), "node")
        placements.push({ kind: "npm", binary: await placed(join(prefix, "bin", name)), real: join(prefix, "lib", "node_modules", policy.npmPackage, "bin", name) })
      }
      const native = policy.native
      if (native) {
        const candidates = [".local/bin/claude", ".local/share/cursor-agent/versions/1/cursor-agent", ".grok/bin/grok", ".opencode/bin/opencode", ".local/share/devin/cli/1/devin", `.local/bin/${name}`]
        const own = candidates.map((each) => join(scratch, key.replace(":", "-"), "home", each)).find((path) => native.ownsPath(path))
        assert.ok(own, `${key}: its own updater's install root (native.ownsPath) is placed here; add a path it owns to this list`)
        placements.push({ kind: "self", binary: await placed(own), real: own })
      }
      const brew = join(scratch, key.replace(":", "-"), "homebrew")
      await placed(join(brew, "bin", "brew"))
      placements.push({ kind: "brew", binary: join(brew, "bin", name), real: join(brew, "Cellar", name, below, "bin", name) })
      placements.push({ kind: "app", binary: `/Applications/Some.app/Contents/Resources/${name}`, real: `/Applications/Some.app/Contents/Resources/${name}` })
      for (const [needle] of policy.managedBy ?? []) placements.push({ kind: "managed", binary: join(scratch, needle, name), real: join(scratch, needle, name) })

      for (const placement of placements) {
        const label = `${key} (${placement.kind})`
        const versions = new Map([[placement.binary, below]])
        let registryDown = false
        let clock = 1_000_000
        const ran: Array<{ command: string; args: string[] }> = []
        // Only this installation is present: the rest of the harness's report no binary.
        const only = sources.map((each) => ({
          ...each,
          binary: () => (each === source && installation === source ? placement.binary : null),
          installations: (each.installations ?? []).map((other) => ({ ...other, binary: () => (each === source && other === installation ? placement.binary : null) })),
        }))
        const updates = new RuntimeUpdates({
          processes,
          sources: () => only,
          path: join(scratch, `${key.replace(":", "-")}-${placement.kind}.json`),
          env: () => env,
          emit: () => {},
          now: () => clock,
          version: async (binary) => versions.get(binary) ?? "",
          stat: async (binary) => ({ mtimeMs: versions.get(binary) === below ? 1 : 2, size: 1 }),
          realpath: async (path) => (path === placement.binary ? placement.real : path),
          latest: async (_pkg, tag) => {
            if (registryDown) throw new Error("npm registry didn't answer within 4 s")
            return tag && parseVersion(tag) === tag ? tag : newer(below)
          },
          githubLatest: async () => {
            if (registryDown) throw new Error("Release server didn't answer within 4 s")
            return newer(below)
          },
          run: async (command, args) => {
            ran.push({ command, args })
            const target = updates.snapshot()[key]?.latest
            versions.set(placement.binary, target && compareVersions(target, below) > 0 ? target : newer(below))
            return { code: 0, output: "" }
          },
        })
        const offered = (await updates.refresh())[key]
        if (process.env.MAKO_TEST_VERBOSE) console.log(label, offered?.channel, offered?.update ? [offered.update.command, ...offered.update.args].join(" ") : `none (${offered?.managedBy ?? offered?.error ?? offered?.latestError ?? ""})`)
        assert.ok(offered?.installed, `${label}: read`)
        const harness = source.provider
        const restore = updates.restoreRuntime(harness)
        if (restore.offer.kind === "update") {
          assert.equal(restore.offer.runtimeId, key, `${label}: a restore's update is this installation's`)
          assert.ok(offered.update, `${label}: a restore offers Mako's update only when the reading has one`)
        } else if (restore.offer.kind !== "owner" || restore.offer.owner !== "Mako")
          assert.equal(offered.update === undefined || installation !== source, true, `${label}: a reading's update is offered to a restore too`)
        // The person clicks a minute later, and the registry is down just then.
        registryDown = true
        clock += 60_000
        if (offered.update) {
          offeredUpdates += 1
          const done = await updates.update(key)
          assert.equal(done.result?.outcome, "updated", `${label}: offered, so it updates (${done.result?.message ?? ""})`)
          assert.deepEqual(ran, [{ command: resolveExecutable(offered.update.command, env), args: offered.update.args }], `${label}: the update runs exactly what was offered`)
        } else {
          await assert.rejects(updates.update(key), (error: Error) => {
            assert.doesNotMatch(error.message, /^\S+ does not update through Mako$/, `${label}: a refusal says why, by name`)
            return true
          }, `${label}: nothing offered, nothing run`)
          assert.deepEqual(ran, [])
        }
        updates.stop()
        checked += 1
      }
    }
    assert.ok(offeredUpdates >= 8, `npm and each harness's own updater are offered and run (${offeredUpdates})`)
    console.log(`  ${checked} installs across ${keys.length} runtimes, ${offeredUpdates} with an update: each offer is the update that runs`)
  }

  // 3. A reading asked for is taken after the ask: a refresh right after an update or a terminal's install answers the
  //    new version, not the one read before it.
  {
    const scratch = join(root, "fresh")
    let installed = "0.159.3"
    let size = 1
    const updates = new RuntimeUpdates({
      processes,
      sources: () => [{ provider: "codex", binary: () => "/u/bin/codex", npmPackage: "@openai/codex", install: [] }],
      path: join(scratch, "readings.json"),
      emit: () => {},
      version: async () => `codex-cli ${installed}`,
      stat: async () => ({ mtimeMs: 1, size }),
      latest: async () => "0.164.0",
    })
    assert.equal((await updates.refresh()).codex.installed, "0.159.3")
    // Updated in a terminal: the binary changed on disk.
    installed = "0.164.0"
    size = 2
    assert.equal((await updates.read(true)).codex.installed, "0.164.0", "the answer to a refresh is the reading it asked for")
    assert.equal((await updates.read(false)).codex.installed, "0.164.0")
    // A pass already running when the binary changes is waited out, and the answer is read after it.
    installed = "0.165.0"
    size = 3
    const running = updates.refresh()
    assert.equal((await updates.read(true)).codex.installed, "0.165.0")
    await running
    // The weighing before a move rereads what's installed, without asking the registry.
    installed = "0.166.0"
    size = 4
    await updates.reread("codex")
    assert.equal(updates.restoreRuntime("codex").version, "0.166.0", "what's weighed is what's installed now")
    updates.stop()
  }

  console.log("PASS: an update lands in the prefix of the binary Mako runs and is verified there; every harness's offer is the update it runs; a refresh answers what it read")
} finally {
  await rm(root, { recursive: true, force: true })
}

/** A version below `version` in the same numbering: its last nonzero part, one less. */
function older(version: string): string {
  const parts = version.split(".")
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const number = Number.parseInt(parts[index] ?? "", 10)
    if (number > 0) {
      parts[index] = String(number - 1)
      return parts.join(".")
    }
  }
  return version
}

/** A version past `version`: its last part, one more. */
function newer(version: string): string {
  const parts = version.split(".")
  parts[parts.length - 1] = String(Number.parseInt(parts.at(-1) ?? "0", 10) + 1)
  return parts.join(".")
}
