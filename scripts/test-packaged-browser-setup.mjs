import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

// Run under Electron with ELECTRON_RUN_AS_NODE=1. The optional module argument
// tests a candidate publisher against an existing signed ASAR without rebuilding it.
const [appArgument, moduleArgument] = process.argv.slice(2)
assert.ok(
  appArgument,
  "Pass Mako.app and optionally the candidate setup module"
)
assert.ok(
  process.versions.electron,
  "This regression requires Electron's real ASAR filesystem"
)
const app = resolve(appArgument)
const archive = join(app, "Contents/Resources/app.asar")
const modulePath = moduleArgument
  ? resolve(moduleArgument)
  : join(archive, "dist-electron/browser-extension-setup.js")
const { prepareBrowserExtension } = await import(pathToFileURL(modulePath).href)
const home = await mkdtemp(join(tmpdir(), "mako-packaged-browser-setup-"))
const executable = join(app, "Contents/MacOS/Mako")
const setup = await prepareBrowserExtension(archive, executable, home)
const files = []
async function verify(relative = "") {
  for (const entry of await readdir(
    join(archive, "dist-browser-extension", relative),
    { withFileTypes: true }
  )) {
    const path = join(relative, entry.name)
    if (entry.isDirectory()) await verify(path)
    else {
      assert.deepEqual(
        await readFile(join(setup.directory, path)),
        await readFile(join(archive, "dist-browser-extension", path))
      )
      files.push(path)
    }
  }
}
await verify()
assert.ok(files.includes("manifest.json") && files.includes("background.js"))
const helper = await readFile(join(home, ".mako/bin/mako-browser-host"), "utf8")
assert.ok(helper.includes(archive))
// Repeated setup repairs modified assets and retains the same extension identity.
await writeFile(join(setup.directory, "background.js"), "incomplete fixture")
assert.deepEqual(
  await prepareBrowserExtension(archive, executable, home),
  setup
)
await verify()
console.log(
  JSON.stringify({
    passed: true,
    home,
    archive,
    modulePath,
    files: [...new Set(files)],
  })
)
