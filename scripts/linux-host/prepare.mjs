import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"

/**
 * The build context of runtime/host/Dockerfile, from a built checkout:
 *
 *   app/    the root manifest and lockfile, the postinstall it runs, and each
 *           workspace package as npm would publish it (its `files`), so the
 *           image installs the host from the same lockfile the Mac app ships
 *   proof/  the kit in scripts/linux-host that installs the harnesses and proves the host,
 *           and in proof/measure, scripts/measure-host.mjs with the fixtures it runs
 *
 * No source, test, environment file or .git enters it. `manifest.json`
 * records every file with its hash and the commit it was built from.
 *
 *   node scripts/linux-host/prepare.mjs --output <new directory>
 */
const { values } = parseArgs({ options: { output: { type: "string" } } })
assert.ok(values.output, "Use --output=<new directory>")
const output = resolve(values.output)
await mkdir(output)
const run = promisify(execFile)
const files = []

async function copy(source, destination) {
  const info = await lstat(source)
  assert.ok(info.isFile(), `Only files enter the image's context: ${source}`)
  const data = await readFile(source)
  await mkdir(dirname(join(output, destination)), { recursive: true })
  await writeFile(join(output, destination), data, { mode: info.mode & 0o777 })
  files.push({ path: destination, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") })
}

for (const file of ["package.json", "package-lock.json", "LICENSE", "scripts/patch-cursor-sdk.mjs"]) await copy(file, join("app", file))
const folders = new Map()
for (const entry of await readdir("packages", { withFileTypes: true }))
  if (entry.isDirectory()) folders.set(JSON.parse(await readFile(join("packages", entry.name, "package.json"), "utf8")).name, join("packages", entry.name))
const packed = JSON.parse((await run("npm", ["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts"], { maxBuffer: 64 * 1024 * 1024 })).stdout)
assert.deepEqual(packed.map(({ name }) => name).sort(), [...folders.keys()].sort(), "every workspace is packed")
for (const { name, files: published } of packed) {
  assert.ok(published.some((file) => file.path.startsWith("dist/")), `${name} isn't built: run npm run build:control-runtime first`)
  for (const file of published) await copy(join(folders.get(name), file.path), join("app", folders.get(name), file.path))
}
for (const file of ["host-process.mjs", "install-harnesses.mjs", "prove.mjs"]) await copy(join("scripts/linux-host", file), join("proof", file))
for (const file of ["measure-host.mjs", "lib/scratch-git.mjs", "fixtures/acp-stream-agent.mjs", "fixtures/host-measure-preload.cjs"])
  await copy(join("scripts", file), join("proof/measure/scripts", file))

const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim()
const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== ""
await writeFile(join(output, "manifest.json"), `${JSON.stringify({ commit, dirty, files }, null, 2)}\n`)
console.log(JSON.stringify({ output, commit, dirty, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }))
