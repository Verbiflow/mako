import assert from "node:assert/strict"
import { build } from "esbuild"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"

// Explicit payload for another machine. Never archive the checkout, .git,
// node_modules, environment files, personal profiles or cloud CLI state.
const [driverArg, outputArg] = process.argv.slice(2)
assert.ok(driverArg && outputArg, "Usage: node scripts/linux-control/prepare-acceptance.mjs <linux driver package> <new output directory>")
const root = process.cwd()
const output = resolve(outputArg)
const driver = resolve(driverArg)
await mkdir(output) // Must be new; do not mix a run with pre-existing files.
const manifest = JSON.parse(await readFile("vendor/cua-driver/release.json", "utf8"))
const provenance = JSON.parse(await readFile(join(driver, "provenance.json"), "utf8"))
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex")
const lock = JSON.parse(await readFile("scripts/linux-control/runtime/package-lock.json", "utf8"))
for (const [path, entry] of Object.entries(lock.packages)) {
  assert.ok(path === "" || ["packages/control", "packages/control-runtime"].includes(path) || path.startsWith("node_modules/"), `Unexpected lockfile path: ${path}`)
  assert.ok(!path.split("/").includes(".."), "Lockfile must not refer outside the payload")
  if (entry.resolved && !["packages/control", "packages/control-runtime"].includes(entry.resolved)) {
    const url = new URL(entry.resolved)
    assert.equal(url.origin, "https://registry.npmjs.org", "Acceptance dependencies must use the public npm registry")
    assert.equal(url.username + url.password + url.search + url.hash, "", "Dependency URLs must not contain credentials or query parameters")
    assert.match(entry.integrity, /^sha512-/)
  }
}
const files = []
async function copy(source, destination) {
  const metadata = await lstat(source)
  assert.equal(metadata.isFile(), true, `Only regular files enter the payload: ${source}`)
  const bytes = await readFile(source)
  const target = join(output, destination)
  await mkdir(dirname(target), { recursive: true })
  // Copy bytes and ordinary permission bits, not extended attributes, resource
  // forks, ownership or setuid/setgid metadata from the developer's machine.
  await writeFile(target, bytes, { mode: metadata.mode & 0o777 })
  files.push({ path: destination, bytes: bytes.length, sha256: sha256(bytes) })
}
const graph = await build({ entryPoints: ["packages/control-runtime/dist/desktop-session-worker.js", "packages/control-runtime/dist/browser-service.js"], outdir: "/unused", bundle: true, platform: "node", format: "esm", packages: "external", write: false, metafile: true, logLevel: "silent" })
for (const file of Object.keys(graph.metafile.inputs)) {
  assert.match(file, /^packages\/control-runtime\/dist\/[\w./-]+\.js$/)

}
async function copyJavaScript(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name)
    if (entry.isDirectory()) await copyJavaScript(file)
    else if (entry.name.endsWith(".js")) await copy(file, relative(root, file))
  }
}
await copyJavaScript(resolve("packages/control/dist"))
await copy("packages/control/package.json", "packages/control/package.json")
await copyJavaScript(resolve("packages/control-runtime/dist"))
await copy("packages/control-runtime/package.json", "packages/control-runtime/package.json")
await copy("scripts/linux-control/runtime/package.json", "package.json")
await copy("scripts/linux-control/runtime/package-lock.json", "package-lock.json")
await copy("scripts/lib/control-cli-probe.mjs", "scripts/lib/control-cli-probe.mjs")
for (const name of ["Dockerfile.acceptance", "start-desktop.sh", "start-recording.sh", "wait-desktop.py", "fixture.py", "probe.mjs", "recording-fixture.py", "recording-probe.mjs", "run-acceptance.sh", "start-wayland.sh", "wayland-probe.mjs", "wayland-gestures.mjs", "identity.sh"]) {
  await copy(join("scripts/linux-control", name), join("scripts/linux-control", name))
}
assert.equal(provenance.version, manifest.version)
assert.equal(provenance.base, manifest.base)
assert.equal(provenance.patchSha256, sha256(await readFile(join("vendor/cua-driver", manifest.patch))))
assert.ok(["linux-x64", "linux-arm64"].includes(provenance.platform))
const binary = await readFile(join(driver, "cua-driver"))
assert.equal(sha256(binary), provenance.binarySha256, "Packaged driver does not match its provenance")
for (const name of ["cua-driver", "provenance.json", "LICENSE-Cua.md"]) await copy(join(driver, name), join("driver", name))
await writeFile(join(output, "payload.json"), JSON.stringify({ version: manifest.version, platform: provenance.platform, files }, null, 2) + "\n")
console.log(`Prepared ${files.length} files for ${provenance.platform} in ${output}`)
