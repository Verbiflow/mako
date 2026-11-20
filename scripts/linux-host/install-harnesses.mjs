import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, open, readdir, realpath, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, relative, sep } from "node:path"
import { othersRunning, startHost, until } from "./host-process.mjs"

/**
 * The image's harnesses, installed as Mako's Settings installs them: a host
 * reads each harness's runtime, and every one it can't find but has an
 * install plan for goes through `mako:harness-install`, the vendor's own
 * installer or npm into this user's home, at the version the harness declares
 * tested. Nothing here names a harness or a command; a definition that can't
 * install on Linux, or installs another version, fails the image's build.
 * `only`: the providers to install, as the image that runs on a person's own
 * machine is given them; every one the host has without it.
 *
 *   node install-harnesses.mjs <record.json> [<provider>...]
 */
const [record, ...only] = process.argv.slice(2)
assert.ok(record, "Pass where to record what was installed")
// The image holds the harnesses, not the Mako state installing them leaves
// in this home, so the proof's host starts as on a fresh machine.
const makoHome = join(homedir(), ".mako")
assert.ok(!existsSync(makoHome), `${makoHome} exists: this prepares a fresh home, never one Mako has used`)
// What the harnesses leave in the temporary folder as they install and start (extracted libraries, logs, caches)
// isn't the image's: what wasn't there before goes with the install's other scratch.
const tmpBefore = new Set(await readdir(tmpdir()))
const scratch = await mkdtemp(join(tmpdir(), "mako-install-"))
/** Each harness as installed, or found present: its binary, its version and how. */
const installed = {}
const host = await startHost({ dataRoot: join(scratch, "data"), output: join(scratch, "host-output.log") })
try {
  const known = (await host.call("mako:harness-descriptors")).map((harness) => harness.provider)
  for (const provider of only) assert.ok(known.includes(provider), `The host has no harness ${provider}; it has ${known.join(", ")}`)
  const providers = only.length ? only : known
  // The first read starts a check of every runtime and answers what it holds so far.
  const before = await until(() => host.call("mako:harness-updates"), (updates) => providers.every((provider) => updates[provider]?.checkedAt), "every harness's runtime read")
  for (const provider of providers) {
    const reading = before[provider]
    if (reading.binary) {
      // A build seed-harnesses.mjs laid out from Mako's kept archives is held to the version tested, as an install is.
      if (reading.versions) assert.equal(reading.versions.standing, "tested", `${provider} ${reading.installed} is present, not the tested ${reading.versions.tested}`)
      installed[provider] = { binary: reading.binary, version: reading.installed, tested: reading.versions?.tested, how: "already present" }
      continue
    }
    assert.ok(reading.install, `${provider} isn't installed and has no install plan Mako can run here${reading.error ? `: ${reading.error}` : ""}`)
    const began = performance.now()
    const after = await host.call("mako:harness-install", provider)
    assert.equal(after.result?.outcome, "installed", `${provider} didn't install: ${after.result?.message ?? JSON.stringify(after)}`)
    // Install plans pin the version Mako tested, so a cloud machine runs exactly it.
    if (after.versions) assert.equal(after.versions.standing, "tested", `${provider} installed ${after.installed}, not the tested ${after.versions.tested}`)
    installed[provider] = { binary: after.binary, version: after.installed, tested: after.versions?.tested, how: [reading.install.command, ...reading.install.args].join(" "), ms: Math.round(performance.now() - began) }
    console.log(`${provider} ${after.installed} at ${after.binary}, in ${installed[provider].ms} ms`)
  }
  // The same host, as Settings would see it right after installing.
  const live = new Set((await host.call("mako:harness-descriptors")).filter((harness) => harness.live).map((harness) => harness.provider))
  assert.deepEqual(providers.filter((provider) => !live.has(provider)), [], "Every harness can start a conversation once installed")
  await writeFile(record, `${JSON.stringify(installed, null, 2)}\n`)
} finally {
  await host.stop()
  await rm(scratch, { recursive: true, force: true })
}
// Its shared daemons leave on their own, and must before their state goes.
await until(othersRunning, (rows) => rows.length === 0, "the host's daemons leaving", 30_000)
await rm(makoHome, { recursive: true, force: true })
for (const [provider, { binary, version }] of Object.entries(installed)) await dropUnusedBuilds(provider, binary, version)
// Last, after every harness has run here: what they left in the temporary folder goes.
for (const name of await readdir(tmpdir())) if (!tmpBefore.has(name)) await rm(join(tmpdir(), name), { recursive: true, force: true })

/**
 * The builds for other machines an npm-installed harness downloaded and doesn't run. A launcher that is itself the
 * native executable, which its postinstall copied or linked out of one of the platform packages nested under it
 * (OpenCode's: four Linux x64 builds of some 250 MB each, one picked by the CPU and C library), never reads those
 * packages again; a launcher that is a script may resolve them as it runs, so those stay. The harness must still
 * report the version recorded after, or the image's build fails.
 */
async function dropUnusedBuilds(provider, binary, version) {
  const executable = await realpath(binary)
  const prefix = join(homedir(), ".local", "lib", "node_modules") + sep
  if (!executable.startsWith(prefix) || !(await nativeExecutable(executable))) return
  const [scope, name] = relative(prefix, executable).split(sep)
  const pkg = scope.startsWith("@") ? `${scope}/${name}` : scope
  const nested = join(prefix, pkg, "node_modules")
  const candidates = pkg.startsWith("@") ? [pkg.split("/")[0]] : ["."]
  let dropped = 0
  for (const parent of candidates)
    for (const entry of await readdir(join(nested, parent)).catch(() => [])) {
      const full = parent === "." ? entry : `${parent}/${entry}`
      const folder = join(nested, full)
      if (!full.startsWith(`${pkg}-`) || executable.startsWith(folder + sep)) continue
      await rm(folder, { recursive: true, force: true })
      dropped++
    }
  if (!dropped) return
  const reported = execFileSync(binary, ["--version"], { encoding: "utf8", timeout: 30_000 }).trim()
  assert.ok(reported.includes(version), `${provider} reports ${reported} once its unused builds went, not ${version}`)
  console.log(`${provider}: dropped ${dropped} builds for other machines that ${pkg} doesn't run`)
}

/** An ELF executable, rather than a script that may load what's beside it. */
async function nativeExecutable(path) {
  const file = await open(path, "r")
  try {
    const { buffer } = await file.read(Buffer.alloc(4), 0, 4, 0)
    return buffer.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
  } finally {
    await file.close()
  }
}
