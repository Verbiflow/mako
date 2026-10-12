import assert from "node:assert/strict"
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RuntimeUpdates } from "@mako/host/harnesses/runtime-updates"
import {
  OPENCODE_RELEASE,
  openCodeRelease,
  openCodeUpdateSource,
} from "@mako/host/harnesses/opencode/updates"
import hostPackage from "../packages/host/package.json" with { type: "json" }
import { isOpenCodeV2, openCodeVersionProblem } from "@mako/host/harnesses/opencode/version"
import { compareVersions } from "@mako/host/contracts/runtime-version"
import { runtimeRowView } from "../src/lib/runtime-updates.ts"
import { DiscoveryProcesses } from "@mako/host/harnesses/discovery-process"

const processes = new DiscoveryProcesses()

assert.equal(OPENCODE_RELEASE, hostPackage.dependencies["@opencode/client"], "Mako installs the OpenCode release its client was published with")
assert.deepEqual(openCodeUpdateSource.install.map((plan) => plan.args), [
  ["install", "-g", "--allow-scripts=@opencode/cli", `@opencode/cli@${OPENCODE_RELEASE}`],
])

const root = await mkdtemp(join(tmpdir(), "mako-opencode-updates-"))
try {
  const bin = join(root, ".opencode", "bin")
  await mkdir(bin, { recursive: true })
  const stable = join(bin, "opencode")
  const v2 = join(bin, "opencode2")
  for (const file of [stable, v2])
    await writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const env = { PATH: bin, OPENCODE2_BIN_PATH: v2 }
  const versions = {
    [stable]: "2.0.0",
    [v2]: "opencode2 v0.0.0-beta-19425",
  }
  let published = OPENCODE_RELEASE
  let beta: string | Error = "0.0.0-beta-19425"
  const read: string[] = []
  const ran: Array<{ command: string; args: string[] }> = []
  const changed: string[] = []
  const runtime = new RuntimeUpdates({
    processes,
    sources: () => [openCodeUpdateSource],
    path: join(root, "updates.json"),
    env: () => env,
    emit: () => {},
    version: async (binary) => versions[binary],
    githubLatest: async (repository) => {
      read.push(repository)
      if (beta instanceof Error) throw beta
      return beta
    },
    latest: async (pkg, tag) => {
      read.push(`npm:${pkg}@${tag}`)
      assert.equal(tag, OPENCODE_RELEASE, "only a stable install reads npm, for the release Mako is verified against")
      return published
    },
    onRuntimeChanged: ({ provider }) => changed.push(provider),
    run: async (command, args) => {
      ran.push({ command, args })
      versions[command] = args.at(-1) ?? ""
      return { code: 0, output: "Updated" }
    },
  })
  const first = await runtime.refresh()
  assert.equal(first.opencode.installed, "2.0.0")
  assert.equal(first["opencode:opencode2"].installed, "0.0.0-beta-19425")
  assert.equal(first["opencode:opencode2"].provider, "opencode")
  assert.equal(runtimeRowView(first["opencode:opencode2"]).detail, "Current")
  assert.equal(runtimeRowView(first.opencode).detail, `${OPENCODE_RELEASE} available`)
  assert.deepEqual(read.sort(), [
    "anomalyco/opencode-beta",
    `npm:@opencode/cli@${OPENCODE_RELEASE}`,
  ])
  assert.deepEqual(first.opencode.update?.args, ["upgrade", OPENCODE_RELEASE])
  await runtime.update("opencode")
  assert.deepEqual(ran, [{ command: stable, args: ["upgrade", OPENCODE_RELEASE] }])
  published = "2.0.28"
  const ahead = await runtime.check("opencode", { latest: true })
  assert.equal(ahead.update, undefined, "a stable install goes to the release Mako is verified against, never another")
  assert.match(ahead.latestError ?? "", /different release channel/)
  published = OPENCODE_RELEASE
  versions[stable] = "2.0.30"
  const newer = await runtime.check("opencode", { force: true, latest: true })
  assert.equal(newer.installed, "2.0.30")
  assert.equal(newer.update, undefined, "a newer release someone runs is kept: an update never moves back")
  assert.equal(runtimeRowView(newer).detail, "Current")
  await assert.rejects(runtime.update("opencode"), /does not update/)
  versions[stable] = OPENCODE_RELEASE
  await runtime.check("opencode", { force: true, latest: true })
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
  beta = "2.0.2"
  const mismatch = await runtime.check("opencode:opencode2", { latest: true })
  assert.equal(mismatch.latest, undefined)
  assert.equal(mismatch.update, undefined)
  assert.match(mismatch.latestError ?? "", /different release channel/)
  await assert.rejects(runtime.update("opencode:opencode2"), /does not update/)
  beta = new Error("Offline")
  const offline = await runtime.check("opencode:opencode2", { latest: true })
  assert.equal(offline.installed, "0.0.0-beta-19426")
  assert.equal(offline.update, undefined)
  assert.equal(runtimeRowView(offline).detail, "Couldn’t check for updates")
  const npm = openCodeRelease(
    "0.0.0-dev-20840",
    "/tmp/opencode2",
    "/opt/lib/node_modules/@opencode/cli/bin/opencode.exe"
  )
  assert.equal(npm.npmPackage, "@opencode/cli")
  assert.equal(npm.npmTag, "dev")
  assert.equal(npm.githubRelease, undefined)
  const npmStable = openCodeRelease(
    "2.0.0",
    "/opt/bin/opencode",
    "/opt/lib/node_modules/@opencode/cli/bin/opencode.exe"
  )
  assert.equal(npmStable.npmPackage, "@opencode/cli")
  assert.equal(npmStable.npmTag, OPENCODE_RELEASE)
  assert.equal(npmStable.githubRelease, undefined)
  assert.equal(
    isOpenCodeV2("2.0.1"),
    true,
    "version identifies V2 even when its binary is named opencode"
  )
  // Use a package-manager path, not the native install root, for this fixture.
  const packageSource = {
    ...openCodeUpdateSource,
    installations: [],
    binary: () => "/opt/bin/opencode2",
  }
  const packaged = new RuntimeUpdates({
    processes,
    sources: () => [packageSource],
    path: join(root, "packaged.json"),
    env: () => env,
    emit: () => {},
    version: async () => "0.0.0-dev-20840",
    stat: async () => ({ mtimeMs: 1, size: 1 }),
    realpath: async () =>
      "/opt/lib/node_modules/@opencode/cli/bin/opencode.exe",
    latest: async (pkg, tag) => {
      assert.equal(pkg, "@opencode/cli")
      assert.equal(tag, "dev")
      return "0.0.0-dev-20843"
    },
  })
  assert.deepEqual((await packaged.refresh()).opencode.update?.args, [
    "install",
    "-g",
    "--allow-scripts=@opencode/cli",
    "@opencode/cli@0.0.0-dev-20843",
  ])
  packaged.stop()
  assert.equal(isOpenCodeV2("0.0.0-beta-19425"), true)
  assert.equal(isOpenCodeV2("1.18.31"), false)
  assert.equal(isOpenCodeV2("0.0.0-local"), false)
  for (const supported of ["2.0.6", "2.0.27", "2.1.0", "opencode v2.0.27", "0.0.0-dev-19740", "0.0.0-dev-20843"])
    assert.equal(openCodeVersionProblem(supported), undefined, `${supported} runs`)
  assert.equal(openCodeVersionProblem("2.0.5"), "OpenCode 2.0.5 is older than Mako supports. Update OpenCode to 2.0.6 or newer.")
  assert.match(openCodeVersionProblem("0.0.0-beta-19723") ?? "", /older than Mako supports/, "a prerelease counts its build")
  assert.match(openCodeVersionProblem("1.18.31") ?? "", /Mako runs OpenCode 2\.0\.6 or newer; this executable reports "1\.18\.31"/)
  assert.equal(compareVersions("0.0.0-beta-999", "0.0.0-beta-1000"), -1)
  // A binary replaced by a new generation must not inherit the prior release feed.
  versions[stable] = "0.0.0-beta-19425"
  beta = "0.0.0-beta-19425"
  const replaced = await runtime.check("opencode", { force: true })
  assert.equal(replaced.latest, "0.0.0-beta-19425")
  assert.equal(replaced.label, "OpenCode 2 · beta")
  assert.equal(replaced.releaseSource, "github:anomalyco/opencode-beta")
  versions[stable] = "1.18.31"
  const unsupported = await runtime.check("opencode", { force: true, latest: true })
  assert.equal(unsupported.update, undefined)
  assert.equal(unsupported.releaseSource, undefined)
  assert.match(unsupported.error ?? "", /does not support/)
  assert.equal(runtimeRowView(unsupported).version, "1.18.31")
  assert.equal(runtimeRowView(unsupported).action, undefined)
  assert.equal(runtime.snapshot().opencode, undefined, "retired runtime is absent from Settings")
  const cached = new RuntimeUpdates({ processes, sources: () => [openCodeUpdateSource], path: join(root, "updates.json"), emit: () => {} })
  await cached.load()
  assert.equal(cached.snapshot().opencode, undefined, "cached v1 reading must not flash on startup")
  assert.ok(cached.snapshot()["opencode:opencode2"], "supported installation remains visible")
  cached.stop()
  await assert.rejects(runtime.update("opencode"), /does not update/)
  versions[stable] = "2.0.2"
  assert.throws(() => openCodeRelease("3.0.0", stable, stable, env), /not an OpenCode 2 release/)
  await writeFile(v2, '#!/bin/sh\nexec "$(dirname "$0")/opencode" "$@"\n', {
    mode: 0o755,
  })
  assert.equal(
    await openCodeUpdateSource.installations?.[0].binary(env),
    null,
    "the argument-preserving wrapper is the same installation"
  )
  assert.equal(
    openCodeRelease("2.0.1", stable, stable, env).primary,
    true,
    "wrapper-selected runtime remains primary"
  )
  const deduplicated = await runtime.refresh()
  assert.equal(
    deduplicated["opencode:opencode2"].binary,
    undefined,
    "old persisted duplicate is retired"
  )
  await writeFile(
    v2,
    '#!/bin/sh\nexport OPENCODE_DB=other.db\nexec "$(dirname "$0")/opencode" "$@"\n'
  )
  assert.equal(
    await openCodeUpdateSource.installations?.[0].binary(env),
    v2,
    "a wrapper changing configuration remains distinct"
  )
  await rm(stable)
  await symlink(v2, stable)
  assert.equal(
    await openCodeUpdateSource.installations?.[0].binary(env),
    null,
    "two names for one executable produce one installation"
  )
  runtime.stop()
  console.log(
    "OpenCode updates: both installations, separate feeds, the verified target never moving a newer install back, channel rejection, the version floor and renamed V2 detection hold"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
