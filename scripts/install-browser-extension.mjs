import assert from "node:assert/strict"
import { extractAll, extractFile } from "@electron/asar"
import { createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { prepareBrowserExtension } from "../dist-electron/browser-extension-setup.js"
import { resolveLocalIdentity, verifyLocalSignature } from "./mac-local-signing.mjs"

// Update the existing extension without tying its helper to a mutable checkout
// or to the app updater's temporary staging directory. Does not reload a browser.
assert.equal(process.platform, "darwin")
assert.equal(process.argv.length, 3, "Pass the verified candidate Mako.app")
const candidate = resolve(process.argv[2])
const identity = await resolveLocalIdentity()
await verifyLocalSignature(candidate, identity)
const archive = join(candidate, "Contents/Resources/app.asar")
const metadata = JSON.parse(extractFile(archive, "package.json").toString())
const build = metadata.makoBuild
assert.match(build.id, /^[a-f0-9]{16}$/)
const base = join(homedir(), ".mako/browser-host-releases")
await mkdir(base, {recursive: true, mode: 0o700})
const root = join(base, build.id)
const receiptPath = join(root, "browser-release-receipt.json")
const hash = createHash("sha256")
for await (const chunk of createReadStream(archive)) hash.update(chunk)
const archiveHash = hash.digest("hex")
const previous = await readFile(receiptPath, "utf8").catch(error => {
  if (error.code !== "ENOENT") throw error
  return null
})
if (previous) {
  assert.equal(JSON.parse(previous).archiveSha256, archiveHash, "Release identity changed; nothing replaced")
} else {
  const stage = root + ".staging"
  await mkdir(stage, {mode: 0o700})
  extractAll(archive, stage)
  await rename(stage, root)
}
const backup = join(base, "before-" + build.id)
if (!previous) {
  await mkdir(backup, {mode: 0o700})
  for (const name of ["bin", "browser-extension-package"])
    await cp(join(homedir(), ".mako", name), join(backup, name), {recursive:true})
}
const setup = await prepareBrowserExtension(root, "/Applications/Mako.app/Contents/MacOS/Mako")
const extension = JSON.parse(await readFile(join(setup.directory, "manifest.json"), "utf8"))
const receipt = { build, identity, root, backup, setup, extensionVersion: extension.version, archiveSha256: archiveHash,
  hostSha256: createHash("sha256").update(await readFile(join(root,"dist-electron/browser-native-host.js"))).digest("hex") }
await writeFile(receiptPath, JSON.stringify(receipt,null,2), {mode:0o600})
console.log(JSON.stringify(receipt,null,2))
console.log("Reload Mako Browser in the browser's extension settings, then verify its registration before running tasks.")
