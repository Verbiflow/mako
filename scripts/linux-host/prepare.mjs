import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs, promisify } from "node:util"
import { buildsDirectory, buildsFile, fetchBuilds, readBuilds } from "../lib/harness-builds.mjs"

/**
 * The build context of runtime/host/Dockerfile, from a built checkout:
 *
 *   app/    the root manifest and lockfile, the postinstall it runs, what prunes the install, and each
 *           workspace package as npm would publish it (its `files`), so the
 *           image installs the host from the same lockfile the Mac app ships
 *   proof/  the kit in scripts/linux-host that installs the harnesses and proves the host,
 *           and in proof/measure, scripts/measure-host.mjs with the fixtures it runs
 *   video/  the video helper's source (native/video-linux), which the image compiles against Debian's libraries
 *   harnesses/  the harness builds Mako keeps (vendor/harness-builds/sources.json) and that list, each archive checked
 *           by its sha256, which the image lays out before the host installs the rest (proof/seed-harnesses.mjs)
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

for (const file of ["package.json", "package-lock.json", "LICENSE", "scripts/patch-cursor-sdk.mjs", "scripts/lib/anchored-patch.mjs", "scripts/patch-sdk-schemas.mjs", "scripts/linux-host/prune-install.mjs", "scripts/linux-host/keep-harnesses.mjs"]) await copy(file, join("app", file))
const folders = new Map()
for (const entry of await readdir("packages", { withFileTypes: true }))
  if (entry.isDirectory()) folders.set(JSON.parse(await readFile(join("packages", entry.name, "package.json"), "utf8")).name, join("packages", entry.name))
const packed = JSON.parse((await run("npm", ["pack", "--dry-run", "--json", "--workspaces", "--ignore-scripts"], { maxBuffer: 64 * 1024 * 1024 })).stdout)
assert.deepEqual(packed.map(({ name }) => name).sort(), [...folders.keys()].sort(), "every workspace is packed")
/** Workspaces the host never runs: the web client is a browser's, carried as its package files alone so the workspace resolves. */
const browserOnly = new Set(["@mako/web-client"])
for (const { name, files: published } of packed) {
  if (!browserOnly.has(name)) assert.ok(published.some((file) => file.path.startsWith("dist/")), `${name} isn't built: run npm run build:control-runtime first`)
  for (const file of published) await copy(join(folders.get(name), file.path), join("app", folders.get(name), file.path))
}
for (const file of ["host-process.mjs", "install-harnesses.mjs", "seed-harnesses.mjs", "prove.mjs"]) await copy(join("scripts/linux-host", file), join("proof", file))
for (const file of ["measure-host.mjs", "lib/scratch-git.mjs", "fixtures/acp-stream-agent.mjs", "fixtures/host-measure-preload.cjs"])
  await copy(join("scripts", file), join("proof/measure/scripts", file))
await copy("native/video-linux/mako-video.c", "video/mako-video.c")
const builds = await readBuilds(".")
await fetchBuilds(builds, buildsDirectory("."))
await copy(buildsFile("."), join("harnesses", "sources.json"))
for (const archive of new Set(builds.map((build) => build.archive))) await copy(join(buildsDirectory("."), archive), join("harnesses", archive))

const commit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim()
const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"])).stdout.trim() !== ""
await writeFile(join(output, "manifest.json"), `${JSON.stringify({ commit, dirty, files }, null, 2)}\n`)
console.log(JSON.stringify({ output, commit, dirty, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) }))
