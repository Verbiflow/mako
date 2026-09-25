import assert from "node:assert/strict"
import { build } from "esbuild"
import { createHash } from "node:crypto"
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join, relative, resolve } from "node:path"
import { parseArgs } from "node:util"
const { values } = parseArgs({ options: { output: { type: "string" }, platform: { type: "string" }, driver: { type: "string" } } })
assert.ok(values.output && ["linux-x64", "linux-arm64"].includes(values.platform), "Use --output=<new directory> --platform=linux-x64|linux-arm64 [--driver=<reviewed package>]")
const output = resolve(values.output)
const root = await realpath(process.cwd())
await mkdir(output, { mode: 0o755 })
const lock = JSON.parse(await readFile("runtime/control/package-lock.json", "utf8"))
for (const [path, dependency] of Object.entries(lock.packages)) {
  assert.ok(path === "" || ["packages/control", "packages/control-runtime"].includes(path) || path.startsWith("node_modules/"))
  assert.ok(!path.split("/").includes(".."), "Dependency path leaves the package")
  if (dependency.resolved && !["packages/control", "packages/control-runtime"].includes(dependency.resolved)) {
    const url = new URL(dependency.resolved)
    assert.equal(url.origin, "https://registry.npmjs.org", "Only public npm dependencies enter the release")
    assert.equal(url.username + url.password + url.search + url.hash, "", "Dependency URL contains credentials or parameters")
    assert.match(dependency.integrity, /^sha512-/)
  }
}
const files = []
const hash = bytes => createHash("sha256").update(bytes).digest("hex")
async function copy(source, destination, allowedRoot = root) {
  const path = resolve(source)
  const physical = await realpath(path)
  assert.equal(physical, path, `Symlinks do not enter the release: ${source}`)
  assert.ok(!relative(allowedRoot, physical).startsWith(".."))
  const info = await lstat(path)
  assert.ok(info.isFile())
  const data = await readFile(path)
  await mkdir(dirname(join(output, destination)), { recursive: true })
  await writeFile(join(output, destination), data, { mode: info.mode & 0o777 })
  files.push({ path: destination, bytes: data.length, sha256: hash(data) })
}
// Trace dependencies, then copy original modules unchanged. The worker entry is
// explicit because fork() isn't part of an import graph. No source maps, profiles,
// build caches, .git, environment files or provider code enter this package.
const graph = await build({ entryPoints: ["packages/control-runtime/dist/cloud-control-main.js", "packages/control-runtime/dist/cloud-control-worker.js", "packages/control-runtime/dist/control-cli.js", "packages/control-runtime/dist/recording-encoder-worker.js"], outdir: "/unused", platform: "node", format: "esm", bundle: true, packages: "external", metafile: true, write: false, logLevel: "silent" })
for (const [file, entry] of Object.entries(graph.metafile.inputs)) {
  assert.match(file, /^packages\/control-runtime\/dist\/[\w./-]+\.js$/)
  assert.ok(!entry.imports.some(item => item.path === "electron"), "Cloud release must not import Electron")

}
async function packageFiles(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await packageFiles(path)
    else if (entry.name.endsWith(".js") || entry.name.endsWith(".d.ts")) await copy(path, path)
  }
}
for (const name of ["control", "control-runtime"]) {
  await packageFiles(`packages/${name}/dist`)
  for (const file of ["package.json", "README.md", "LICENSE"])
    await copy(`packages/${name}/${file}`, `packages/${name}/${file}`)
}
await copy("runtime/control/package.json", "package.json")
await copy("runtime/control/package-lock.json", "package-lock.json")
await copy("docs/local-control-runtime.md", "README.md")
await copy("LICENSE", "LICENSE")
if (values.driver) {
  const driver = await realpath(resolve(values.driver))
  const provenance = JSON.parse(await readFile(join(driver, "provenance.json"), "utf8"))
  const release = JSON.parse(await readFile("vendor/cua-driver/release.json", "utf8"))
  assert.equal(provenance.platform, values.platform)
  assert.equal(provenance.version, release.version)
  assert.equal(provenance.base, release.base)
  assert.equal(provenance.patchSha256, hash(await readFile(join("vendor/cua-driver", release.patch))))
  assert.equal(provenance.binarySha256, hash(await readFile(join(driver, "cua-driver"))))
  for (const file of ["cua-driver", "provenance.json", "LICENSE-Cua.md"]) await copy(join(driver, file), join("native", file), driver)
}
await writeFile(join(output, "manifest.json"), JSON.stringify({ version: 1, platform: values.platform, files }, null, 2) + "\n")
console.log(JSON.stringify({ output, platform: values.platform, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }))
