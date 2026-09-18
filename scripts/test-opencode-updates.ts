import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeUpdates } from "../electron/runtime-updates.ts"
import {
  openCodeRelease,
  openCodeUpdateSource,
  openCodeVersionGeneration,
} from "../electron/providers/opencode/updates.ts"
import { compareVersions } from "../electron/contracts/runtime-version.ts"
import { runtimeRowView } from "../src/lib/runtime-updates.ts"

const root = await mkdtemp(join(tmpdir(), "mako-opencode-updates-"))
try {
  const bin = join(root, ".opencode", "bin")
  await mkdir(bin, { recursive: true })
  const v1 = join(bin, "opencode")
  const v2 = join(bin, "opencode2")
  for (const file of [v1, v2])
    await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const env = { PATH: bin, OPENCODE1_BIN_PATH: v1, OPENCODE2_BIN_PATH: v2 }
  const versions = {
    [v1]: "1.18.29",
    [v2]: "opencode2 v0.0.0-beta-19425",
  }
  let beta: string | Error = "0.0.0-beta-19425"
  const read: string[] = []
  const ran: Array<{ command: string; args: string[] }> = []
  const changed: string[] = []
  const runtime = new RuntimeUpdates({
    sources: () => [openCodeUpdateSource],
    path: join(root, "updates.json"),
    env: () => env,
    emit: () => {},
    version: async (binary) => versions[binary],
    githubLatest: async (repository) => {
      read.push(repository)
      if (repository === "anomalyco/opencode") return "1.18.31"
      if (beta instanceof Error) throw beta
      return beta
    },
    latest: async () => {
      throw new Error("A native beta must not read npm latest")
    },
    onRuntimeChanged: ({ provider }) => changed.push(provider),
    run: async (command, args) => {
      ran.push({ command, args })
      versions[command] = args.at(-1) ?? ""
      return { code: 0, output: "Updated" }
    },
  })
  const first = await runtime.refresh()
  assert.equal(first.opencode.installed, "1.18.29")
  assert.equal(first["opencode:opencode2"].installed, "0.0.0-beta-19425")
  assert.equal(first["opencode:opencode2"].provider, "opencode")
  assert.equal(runtimeRowView(first["opencode:opencode2"]).detail, "Current")
  assert.equal(runtimeRowView(first.opencode).detail, "1.18.31 available")
  assert.deepEqual(read.sort(), [
    "anomalyco/opencode",
    "anomalyco/opencode-beta",
  ])
  assert.deepEqual(first.opencode.update?.args, ["upgrade", "1.18.31"])
  await runtime.update("opencode")
  assert.deepEqual(ran, [{ command: v1, args: ["upgrade", "1.18.31"] }])
  assert.equal(
    runtime.snapshot()["opencode:opencode2"].installed,
    "0.0.0-beta-19425"
  )
  beta = "0.0.0-beta-19426"
  await runtime.check("opencode:opencode2", { latest: true })
  await runtime.update("opencode:opencode2")
  assert.deepEqual(ran[1], {
    command: v2,
    args: ["upgrade", "0.0.0-beta-19426"],
  })
  assert.ok(
    changed.every((provider) => provider === "opencode"),
    "refresh the provider, never an installation ID"
  )
  beta = "1.18.31"
  const mismatch = await runtime.check("opencode:opencode2", { latest: true })
  assert.equal(mismatch.latest, undefined)
  assert.equal(mismatch.update, undefined)
  assert.match(mismatch.latestError ?? "", /different release channel/)
  await assert.rejects(runtime.update("opencode:opencode2"), /does not update/)
  beta = new Error("Offline")
  const offline = await runtime.check("opencode:opencode2", { latest: true })
  assert.equal(offline.installed, "0.0.0-beta-19426")
  assert.equal(offline.update, undefined)
  assert.equal(runtimeRowView(offline).detail, "Latest version unknown")
  const npm = openCodeRelease(
    "0.0.0-beta-19425",
    "/tmp/opencode2",
    "/opt/lib/node_modules/@opencode-ai/cli/bin/opencode2"
  )
  assert.equal(npm.npmPackage, "@opencode-ai/cli")
  assert.equal(npm.npmTag, "beta")
  assert.equal(npm.githubRelease, undefined)
  assert.equal(
    openCodeVersionGeneration("2.0.1"),
    "v2",
    "version identifies V2 even when its binary is named opencode"
  )
  // Use a package-manager path, not the native install root, for this fixture.
  const packageSource = {
    ...openCodeUpdateSource,
    installations: [],
    binary: () => "/opt/bin/opencode2",
  }
  const packaged = new RuntimeUpdates({
    sources: () => [packageSource],
    path: join(root, "packaged.json"),
    env: () => env,
    emit: () => {},
    version: async () => "0.0.0-beta-19270",
    stat: async () => ({ mtimeMs: 1, size: 1 }),
    realpath: async () =>
      "/opt/lib/node_modules/@opencode-ai/cli/bin/opencode2",
    latest: async (pkg, tag) => {
      assert.equal(pkg, "@opencode-ai/cli")
      assert.equal(tag, "beta")
      return "0.0.0-beta-19271"
    },
  })
  assert.deepEqual((await packaged.refresh()).opencode.update?.args, [
    "install",
    "-g",
    "--allow-scripts=@opencode-ai/cli",
    "@opencode-ai/cli@0.0.0-beta-19271",
  ])
  packaged.stop()
  assert.equal(openCodeVersionGeneration("0.0.0-beta-19425"), "v2")
  assert.equal(openCodeVersionGeneration("1.18.31"), "v1")
  assert.equal(openCodeVersionGeneration("0.0.0-local"), undefined)
  assert.equal(compareVersions("0.0.0-beta-999", "0.0.0-beta-1000"), -1)
  // A binary replaced by a new generation must not inherit the prior release feed.
  versions[v1] = "0.0.0-beta-19425"
  beta = "0.0.0-beta-19425"
  const replaced = await runtime.check("opencode", { force: true })
  assert.equal(replaced.latest, "0.0.0-beta-19425")
  assert.equal(replaced.label, "OpenCode 2 · beta")
  assert.equal(replaced.releaseSource, "github:anomalyco/opencode-beta")
  await rm(v1)
  await symlink(v2, v1)
  assert.equal(
    await openCodeUpdateSource.installations?.[0].binary(env),
    null,
    "two names for one executable produce one installation"
  )
  runtime.stop()
  console.log(
    "OpenCode updates: both installations, separate feeds, pinned targets, channel rejection and renamed V2 detection hold"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
