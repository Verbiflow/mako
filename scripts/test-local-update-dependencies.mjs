import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import { readFileSync, statSync } from "node:fs"
import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import { DependencyInstallError, installDependencies, uninstalledPackages } from "@mako/host/application/local-update-dependencies"
import { LocalUpdates } from "@mako/host/application/local-updates"
import { prepareDependencies } from "./update-local.mjs"

/**
 * A fast-forward that changes package-lock.json leaves node_modules behind
 * it. Settings › Updates and `npm run update:local` install what the
 * lockfile lists before they build, against real repositories, a local bare
 * remote and packages from local tarballs (no registry): a bumped version
 * and a new workspace package, the way `@mako/web-client` once stopped a
 * build. package.json and package-lock.json are never written, uncommitted
 * changes to them are refused, and a failure or a hang is stopped and says
 * what to run by hand.
 */

const project = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), "mako-update-dependencies-"))
const home = join(root, "home")
await mkdir(home)
// npm reads the fixture's own home: no registry, no cache or config of the person's.
await writeFile(join(home, ".npmrc"), "offline=true\nupdate-notifier=false\n")
const globalConfig = join(root, "gitconfig")
await writeFile(globalConfig, "")
for (const name of Object.keys(process.env)) if (/^npm_/i.test(name)) delete process.env[name]
Object.assign(process.env, {
  HOME: home,
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
})
const git = new Git()
const run = (cwd, command, ...args) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const json = async (path) => JSON.parse(await readFile(path, "utf8"))
const write = (path, text) => mkdir(dirname(path), { recursive: true }).then(() => writeFile(path, text))
const writeJson = (path, value) => write(path, `${JSON.stringify(value, null, 2)}\n`)
const scripts = Object.fromEntries(["build", "lint", "package:mac:local", "test:performance", "test:application", "test:renderer-assets"].map((name) => [name, "node -e 0"]))
const manifest = (dep) => ({ name: "mako", version: "0.0.1", private: true, workspaces: ["packages/*"], scripts, dependencies: { dep: `file:vendor/dep-${dep}.tgz` } })
/** Commit what the writer changed and push it. */
const push = (writer, subject) => {
  run(writer, "git", "add", "-A")
  run(writer, "git", "commit", "-qm", subject)
  run(writer, "git", "push", "-q", "origin", "main")
  return run(writer, "git", "rev-parse", "HEAD")
}
/** The same, with package-lock.json as npm resolves it. */
const land = (writer, subject) => {
  run(writer, "npm", "install", "--package-lock-only", "--no-audit", "--no-fund")
  return push(writer, subject)
}
const identity = (revision) => ({ id: "c".repeat(16), builtAt: new Date().toISOString(), revision, dirty: false })
const roomy = { statfs: async () => ({ bavail: 1e12, bsize: 1 }) }
const finished = (updates) => new Promise((resolve) => {
  const poll = () => (updates.building ? setTimeout(poll, 20) : resolve())
  poll()
})
let builds = 0
/** A Settings build of `source`; its states as they were drawn, and how it ended. */
async function settingsBuild(source, installed, options = {}) {
  const states = []
  let lockfile = null
  const updates = new LocalUpdates(git, join(root, `updates-${++builds}`), "A".repeat(40), () => {
    const state = updates.snapshot().local
    states.push(state)
    // package-lock.json as the install began, to compare with after it.
    if (state.kind === "building" && state.phase === "installing" && !lockfile)
      lockfile = { text: readFileSync(join(source, "package-lock.json"), "utf8"), mtime: statSync(join(source, "package-lock.json")).mtimeMs }
  }, identity(installed), { ...roomy, ...options })
  await updates.load()
  await updates.select(source)
  updates.start()
  await finished(updates)
  return { states, ended: updates.snapshot().local, lockfile }
}
/** The folder a by-hand command's `cd` lands in, as a shell runs it. */
const landsIn = (command) => execFileSync("sh", ["-c", `${command.replace(/ && npm install$/, "")} && pwd -P`], { encoding: "utf8" }).trim()
const phases = (states) => [...new Set(states.flatMap((state) => (state.kind === "building" ? [state.phase] : [])))]
const version = async (source) => (await json(join(source, "node_modules/dep/package.json"))).version

try {
  // Two versions of one package, packed to tarballs the repository carries.
  const packages = join(root, "packages")
  for (const v of ["1.0.0", "1.1.0", "1.2.0"]) {
    const folder = join(packages, v)
    await writeJson(join(folder, "package.json"), { name: "dep", version: v, main: "index.js" })
    await write(join(folder, "index.js"), `module.exports = ${JSON.stringify(v)}\n`)
    run(folder, "npm", "pack", "--silent", "--pack-destination", packages)
  }
  const remote = join(root, "remote.git")
  const writer = join(root, "writer")
  const source = join(root, "source with 'quotes'")
  run(root, "git", "init", "-q", "--bare", "-b", "main", remote)
  run(root, "git", "clone", "-q", remote, writer)
  run(writer, "git", "checkout", "-q", "-b", "main")
  await write(join(writer, ".gitignore"), "node_modules\n")
  await writeJson(join(writer, "package.json"), manifest("1.0.0"))
  await mkdir(join(writer, "vendor"))
  for (const v of ["1.0.0", "1.1.0"]) await writeFile(join(writer, `vendor/dep-${v}.tgz`), await readFile(join(packages, `dep-${v}.tgz`)))
  const first = land(writer, "First (#1)")
  run(root, "git", "clone", "-q", remote, source)
  run(source, "npm", "install", "--no-audit", "--no-fund")
  assert.equal(await version(source), "1.0.0")
  assert.deepEqual(await uninstalledPackages(source), [], "a checkout npm just installed holds what its lockfile lists")

  // Upstream bumps the package and adds a workspace package: the fast-forward changes package-lock.json.
  await writeJson(join(writer, "package.json"), manifest("1.1.0"))
  await writeJson(join(writer, "packages/web-client/package.json"), { name: "@fixture/web-client", version: "0.0.0", main: "index.js" })
  await write(join(writer, "packages/web-client/index.js"), "module.exports = 'web'\n")
  const second = land(writer, "Second (#2)")

  // Settings › Updates: fetch, fast-forward, install, then copy and build.
  const forward = await settingsBuild(source, first)
  assert.equal(run(source, "git", "rev-parse", "HEAD"), second, "the source was fast-forwarded")
  assert.deepEqual(phases(forward.states), ["copying", "installing", "compiling", "checking", "packaging"], "installing comes before the copy; the fixture has no packaging script, so packaging is where it stops")
  const installing = forward.states.find((state) => state.kind === "building" && state.phase === "installing")
  assert.deepEqual(installing, { kind: "building", phase: "installing", revision: second, dependencies: { count: 2, names: ["@fixture/web-client", "dep"] } })
  assert.ok(forward.states.some((state) => state.kind === "building" && state.phase === "compiling" && state.revision === second && !("dependencies" in state)), "the packages are said only while they install")
  assert.equal(forward.ended.kind, "error")
  assert.match(forward.ended.message, /failed during packaging/)
  assert.equal(await version(source), "1.1.0", "the bumped version is installed")
  assert.equal(await readlink(join(source, "node_modules/@fixture/web-client")), "../../packages/web-client", "the new workspace package is linked")
  assert.deepEqual(await uninstalledPackages(source), [])
  assert.equal(run(source, "git", "status", "--porcelain"), "", "npm wrote no tracked file")
  assert.equal(await readFile(join(source, "package-lock.json"), "utf8"), forward.lockfile.text)
  assert.equal(statSync(join(source, "package-lock.json")).mtimeMs, forward.lockfile.mtime, "package-lock.json wasn't even rewritten")

  // Level again: a second build installs nothing.
  const level = await settingsBuild(source, first)
  assert.ok(!phases(level.states).includes("installing"))

  // Uncommitted changes to package-lock.json: the person's, so no install, and the checkout says what to run.
  const edited = (await readFile(join(source, "package-lock.json"), "utf8")).replaceAll("dep-1.1.0.tgz", "dep-1.0.0.tgz").replace(/"version": "1\.1\.0"/, '"version": "1.0.0"')
  await writeFile(join(source, "package-lock.json"), edited)
  const ran = []
  const recorder = { run: async (args) => { ran.push(args) } }
  assert.deepEqual(await uninstalledPackages(source), ["dep"], "a version the lockfile names differently counts")
  await assert.rejects(installDependencies(git, source, ["dep"], recorder), (error) => {
    assert.ok(error instanceof DependencyInstallError)
    assert.equal(error.message, "package-lock.json lists a package the checkout hasn't installed: dep. The checkout has uncommitted changes to package-lock.json, so Mako won't run npm install there for you. Commit or discard them, or run npm install yourself, then build again.")
    // Quoted for a shell, the quotes in the folder's name too.
    assert.equal(error.command, `cd '${source.replaceAll("'", "'\\''")}' && npm install`)
    assert.equal(landsIn(error.command), landsIn(`cd ${JSON.stringify(source)} && npm install`), "and cd lands in the checkout")
    return true
  })
  const refused = await settingsBuild(source, first)
  assert.equal(refused.ended.kind, "error")
  assert.equal(refused.ended.message, "The update couldn't install dependencies: package-lock.json lists a package the checkout hasn't installed: dep. The checkout has uncommitted changes to package-lock.json, so Mako won't run npm install there for you. Commit or discard them, or run npm install yourself, then build again. Your installed app and agents were not changed.")
  assert.equal(landsIn(refused.ended.command), landsIn(`cd ${JSON.stringify(source)} && npm install`), "the command to run by hand is carried apart, and lands in the checkout")
  const said = []
  await assert.rejects(prepareDependencies({ project: source, say: (line) => said.push(line), run: recorder.run }), /won't run npm install there/)
  assert.deepEqual(said, [], "the CLI doesn't say it's installing what it refuses to install")
  assert.deepEqual(ran, [], "npm never ran")
  assert.equal(await readFile(join(source, "package-lock.json"), "utf8"), edited, "the edit is untouched")
  assert.equal(await version(source), "1.1.0")
  // A new package.json counts too: a workspace not committed yet.
  run(source, "git", "checkout", "--", "package-lock.json")
  await writeJson(join(source, "packages/draft/package.json"), { name: "draft", version: "0.0.0" })
  await assert.rejects(installDependencies(git, source, ["dep"], recorder), /uncommitted changes to packages\/draft\/package\.json/)
  await rm(join(source, "packages/draft"), { recursive: true })

  // npm that fails: a lockfile naming a tarball the checkout doesn't have. Its error and the command to run are said.
  await writeJson(join(writer, "package.json"), manifest("1.2.0"))
  await writeFile(join(writer, "vendor/dep-1.2.0.tgz"), await readFile(join(packages, "dep-1.2.0.tgz")))
  run(writer, "npm", "install", "--package-lock-only", "--no-audit", "--no-fund")
  await rm(join(writer, "vendor/dep-1.2.0.tgz"))
  push(writer, "Third (#3)")

  // npm that hangs is stopped at the limit, its whole process group with it.
  const fake = join(root, "fake-bin")
  const child = join(root, "fake-npm-child.pid")
  await write(join(fake, "npm"), `#!/bin/sh\nsleep 120 &\necho $! > '${child}'\nwait\n`)
  await chmod(join(fake, "npm"), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${fake}:${path}`
  const hung = await settingsBuild(source, first, { installTimeoutMs: 2000 }).finally(() => { process.env.PATH = path })
  assert.equal(hung.ended.kind, "error")
  assert.equal(hung.ended.message, "The update couldn't install dependencies: npm install didn't finish within 2 seconds, so Mako stopped it. Run npm install yourself to see the whole error, then build again. Your installed app and agents were not changed.")
  assert.match(hung.ended.command, / && npm install$/)
  // npm's own children go with it; the orphaned sleeper is reaped by the system, so allow it a moment.
  const sleeper = Number(await readFile(child, "utf8"))
  const gone = () => { try { process.kill(sleeper, 0); return false } catch (error) { return error.code === "ESRCH" } }
  for (const deadline = Date.now() + 5000; !gone() && Date.now() < deadline; ) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(gone(), "npm's own children were stopped with it")
  assert.ok(!phases(hung.states).includes("compiling"), "nothing was built")

  // npm would take the tarball from its cache, where writing the lockfile put it.
  await rm(join(home, ".npm"), { recursive: true, force: true })
  const broken = await settingsBuild(source, first)
  assert.equal(broken.ended.kind, "error")
  assert.match(broken.ended.message, /^The update couldn't install dependencies: npm install --no-audit --no-fund --no-save exited with \d+\. [^]*dep-1\.2\.0\.tgz[^]* Run npm install yourself to see the whole error, then build again\. Your installed app and agents were not changed\.$/)
  assert.match(broken.ended.command, / && npm install$/)
  assert.equal(await version(source), "1.1.0", "a failed install leaves what was there")
  assert.equal(run(source, "git", "status", "--porcelain"), "")

  // The tarball lands; `npm run update:local` installs it the same way, and says so first.
  await writeFile(join(writer, "vendor/dep-1.2.0.tgz"), await readFile(join(packages, "dep-1.2.0.tgz")))
  push(writer, "Fourth (#4)")
  run(source, "git", "pull", "-q", "--ff-only")
  const lines = []
  await prepareDependencies({
    project: source,
    say: (line) => lines.push(line),
    run: (args, signal) => new Promise((resolve, reject) => {
      const npm = spawn("npm", args, { cwd: source, stdio: "ignore", signal })
      npm.once("error", reject)
      npm.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`npm exited with ${code}`))))
    }),
  })
  assert.deepEqual(lines, ["Installing dependencies… package-lock.json lists a package the checkout hasn't installed: dep."])
  assert.equal(await version(source), "1.2.0")
  assert.equal(run(source, "git", "status", "--porcelain"), "")
  await prepareDependencies({ project: source, say: (line) => lines.push(line), run: recorder.run })
  assert.equal(lines.length, 1, "nothing to install, nothing said")
  assert.ok((await lstat(join(source, "node_modules"))).isDirectory())

  // A checkout with no node_modules at all installs everything its lockfile lists.
  await rm(join(source, "node_modules"), { recursive: true })
  assert.deepEqual(await uninstalledPackages(source), ["@fixture/web-client", "dep"])

  // Install scripts: npm's allowScripts lets unreviewed ones run with a notice and holds them back on newer
  // releases. Mako's build needs none of these, so the updater approves none; a new one is decided here.
  const lock = await json(join(project, "package-lock.json"))
  // The project's own postinstall isn't a dependency's: allowScripts never holds it back.
  const scripted = Object.entries(lock.packages).flatMap(([path, entry]) => (path.includes("node_modules/") && entry.hasInstallScript && !entry.optional ? [path.slice(path.lastIndexOf("node_modules/") + 13)] : [])).sort()
  const notNeeded = {
    // Builds the native watcher from source only when npm_config_build_from_source is set; the prebuilt @parcel/watcher-<platform> package is used otherwise.
    "@parcel/watcher": true,
    // Copies 7-Zip for the Windows installer (electron-builder-squirrel-windows); the macOS build never packages for Windows.
    "electron-winstaller": true,
    // Swaps bin/esbuild's JavaScript shim for the native binary, a startup speedup; the shim and the JS API find @esbuild/<platform> without it.
    esbuild: true,
  }
  assert.deepEqual(scripted, Object.keys(notNeeded).sort(), "a dependency with an install script arrived or left: decide whether the build needs its script; if it does, approve it pinned with npm approve-scripts <name>")

  console.log("Update dependencies: a lockfile the fast-forward changed is installed before the build (bumped version, new workspace package), package files are never written, uncommitted changes to them are refused, a hang is stopped with its process group and a failure says what to run, the CLI installs the same way, and no install script the build needs is held back")
} finally {
  git.close()
  await rm(root, { recursive: true, force: true })
}
