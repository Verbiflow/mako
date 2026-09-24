import assert from "node:assert/strict"
import { execFile, spawn } from "node:child_process"
import { createRequire } from "node:module"
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { browserFixture } from "./browser-control-fixture.ts"
import { controlSessionBuild } from "@mako/control-runtime/session"
const run = promisify(execFile)
const directory = await mkdtemp(join(tmpdir(), "mako-control-consumer-"))
const fixture = await browserFixture()
const npm = process.platform === "win32" ? "npm.cmd" : "npm"
const packs = []
let runtime, shell
try {
  for (const name of ["control", "control-runtime"]) {
    const result = await run(npm, ["pack", `./packages/${name}`, "--ignore-scripts", "--json", "--pack-destination", directory])
    const [pack] = JSON.parse(result.stdout)
    assert.ok(pack.files.some(file => file.path === "LICENSE"))
    assert.ok(!pack.files.some(file => /computer-tools-main/.test(file.path)), "Removed public adapter cannot ship")
    assert.ok(pack.files.some(file => file.path === "README.md"))
    assert.ok(pack.files.some(file => file.path === "dist/index.d.ts"))
    assert.ok(!pack.files.some(file => /(?:\.map$|\.pyc$|\.env|\.tsbuildinfo|node_modules|^src\/|^test\/)/.test(file.path)))
    packs.push(pack)
  }
  await writeFile(join(directory, "package.json"), JSON.stringify({ private: true, type: "module" }))
  const npmConfig = join(directory, "public-npmrc")
  await writeFile(npmConfig, "", {mode:0o600})
  // Fresh contributor caches lack npm packuments after npm ci. Default to the
  // public registry with no user config; --offline is available for a warm cache.
  await run(npm, ["install", ...(process.argv.includes("--offline") ? ["--offline"] : []), "--ignore-scripts", "--no-audit", "--no-fund", "--registry=https://registry.npmjs.org", `--userconfig=${npmConfig}`, ...packs.map(pack => join(directory, pack.filename)), "@types/node@24"], { cwd: directory })
  for (const name of ["control", "control-runtime"])
    assert.equal((await lstat(join(directory, "node_modules/@mako", name))).isSymbolicLink(), false)
  const binHelp = await run(join(directory, "node_modules/.bin/mako-control"), ["--help"], { cwd: directory })
  assert.match(binHelp.stdout, /browser and computer use/)
  const require = createRequire(join(directory, "package.json"))
  const load = name => import(pathToFileURL(require.resolve(name)).href)
  const { createControlRuntime } = await load("@mako/control-runtime")
  const { serveControlSession, controlSessionBuild: installedBuild } = await load("@mako/control-runtime/session")
  assert.equal(await installedBuild(), await controlSessionBuild(), "Identity survives archive installation and relocation")
  assert.throws(() => require.resolve("@mako/control-runtime/dist/control-session.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  assert.throws(() => require.resolve("@mako/control-runtime/mcp"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  const output = join(directory, "output")
  await mkdir(output)
  const empty = createControlRuntime({ artifacts: output })
  const emptyBrowsers = await empty.call({action:"targets",kind:"browsers"}, AbortSignal.timeout(1000))
  assert.deepEqual(emptyBrowsers, {kind:"browsers",available:true,browsers:[]})
  assert.equal(fixture.connections(), 0)
  await empty.close()
  runtime = createControlRuntime({ artifacts: output, browsers: [fixture.definition] })
  shell = await serveControlSession(runtime)
  const cli = require.resolve("@mako/control-runtime/cli")
  async function command(args, input = "", expectedExit = 0) {
    const child = spawn(process.execPath, [cli, ...args, "--session-file", shell.file], { cwd: directory, stdio: ["pipe", "pipe", "pipe"] })
    let stdout = "", stderr = ""
    child.stdout.on("data", bytes => { stdout += bytes })
    child.stderr.on("data", bytes => { stderr += bytes })
    child.stdin.end(input)
    const exit = await new Promise((done, reject) => { child.once("error", reject); child.once("exit", done) })
    assert.equal(exit, expectedExit, stderr + stdout)
    assert.equal(expectedExit ? stdout : stderr, "")
    return JSON.parse(expectedExit ? stderr : stdout)
  }
  await command(["connect", "--browser", "fixture"])
  const target = await command(["open", "--browser", "fixture"])
  assert.equal(target.kind, "page")
  const code = `state.tab = control.tab(${JSON.stringify(target)}); state.count = 41; return (await state.tab.observe()).select({text:'Proof'})`
  await command(["exec", "--source-file", "-"], code)
  const before = fixture.calls.length
  const invalid = await command(["exec", "--source-file", "-"], "return await state.tab.observe({max:'wrong'})", 2)
  assert.equal(invalid.outcome, "not-dispatched")
  assert.equal(fixture.calls.length, before)
  const resumed = await command(["exec", "--source-file", "-"], "return ++state.count")
  assert.equal(resumed.at(-1).value, 42)
  assert.equal(fixture.calls.some(call => call.method === "Page.captureScreenshot"), false)
  const shot = await command(["shot", "--target-file", "-", "--output", join(output, "proof.png")], JSON.stringify(target))
  assert.ok(shot.width > 0 && shot.height > 0)
  assert.ok((await readFile(shot.path)).length > 100)
  const help = await command(["api", "--input", "-"], JSON.stringify({ domain: "Page", method: "navigate" }))
  assert.ok(JSON.stringify(help).includes("navigate"), "Pinned protocol JSON resolves from a declared dependency")
  const spilled = await command(["exec", "--source-file", "-"], "return 'x'.repeat(50000)")
  const artifact = spilled.find(block => block.value?.artifact)?.value
  assert.ok(artifact)
  assert.equal(JSON.parse(await readFile(artifact.path, "utf8")), "x".repeat(50000))
  // Compile against installed declarations, including the public method results.
  await writeFile(join(directory, "consumer.ts"), `
import { createControlRuntime, type ControlRuntimeOptions } from '@mako/control-runtime';
import { serveControlSession } from '@mako/control-runtime/session';
import { BrowserService } from '@mako/control-runtime/browser';
import { startDesktopControlSession } from '@mako/control-runtime/session';
import { controlClient } from '@mako/control/control';
const options: ControlRuntimeOptions = {artifacts:'/tmp/example'};
const runtime = createControlRuntime(options);
const host = new BrowserService([]);
const client = controlClient((action, args) => runtime.call({action, ...args}, new AbortController().signal));
const page = client.tab({kind:'page',browser:'job',tab:'one',lease:'lease',generation:'one'});
void page; void startDesktopControlSession; void host;
const shell = await serveControlSession(runtime);
await shell.close(); await runtime.close();
`)
  await run(process.execPath, [resolve("node_modules/@typescript/native-preview/bin/tsgo"), "--noEmit", "--strict", "--module", "NodeNext", "--moduleResolution", "NodeNext", "--target", "ES2022", "--types", "node", "consumer.ts"], { cwd: directory, maxBuffer: 1024 * 1024 })
  const entry = require.resolve("@mako/control-runtime")
  const original = await readFile(entry)
  try {
    await writeFile(entry, Buffer.concat([original, Buffer.from("\n// changed engine build\n")]))
    const mismatch = await command(["status"], "", 3)
    assert.equal(mismatch.outcome, "not-dispatched")
    assert.match(mismatch.message, /builds differ/)
  } finally { await writeFile(entry, original) }
  await command(["status"])
  await shell.close()
  await Promise.all([runtime.close(), runtime.close()])
  await assert.rejects(runtime.execute({ source: "return 1" }, AbortSignal.timeout(1000)))
  console.log(JSON.stringify({ packages: packs.map(({ name, size, unpackedSize, files }) => ({ name, archiveBytes: size, unpackedBytes: unpackedSize, files: files.length })), passed: "Packed public API/types, relocated identity, shared worker state, invalid input, explicit screenshot, protocol help, artifact spill, idempotent close" }))
} finally {
  await shell?.close()
  await runtime?.close()
  await fixture.close()
  await rm(directory, { recursive: true, force: true })
}
