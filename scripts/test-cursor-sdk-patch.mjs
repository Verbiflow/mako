import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { extractFile, listPackage } from "@electron/asar"
import { packArchive } from "./lib/pack-archive.mjs"
import { applyAnchored, locate } from "./lib/anchored-patch.mjs"
import { assertCursorSdkPatched, CURSOR_SDK_PATCHES, folderFiles, installedPatch, npmCacheCursorSdk, patchCursorSdk, PRISTINE_FOLDER, pristineStore } from "./patch-cursor-sdk.mjs"

// Nothing here reaches npm: the unpatched bytes come from the installed package itself, the files no patch touches as
// they are and the patched ones from what the install kept of them (`.mako-pristine`).
const installed = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "../..")
const { version } = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
const kept = pristineStore(installed, version)
const original = (target) => {
  const text = readFileSync(join(installed, target), "utf8")
  if (!text.includes("/*mako:patched") && !CURSOR_SDK_PATCHES.some((patch) => patch.sites.some((site) => locate(text, site.to).count === 1))) return text
  const saved = kept.get(target)
  assert.ok(saved.text !== undefined, `the installed ${target} is patched and its unpatched bytes aren't kept (${saved.why}); reinstall @cursor/sdk`)
  return saved.text
}
const root = mkdtempSync(join(tmpdir(), "mako-cursor-patch-"))
const sdk = join(root, "app/node_modules/@cursor/sdk")
const read = (file) => readFileSync(join(sdk, file), "utf8")
const files = folderFiles(sdk)
const builds = ["esm", "cjs"]
const targets = () => builds.flatMap((build) => files(build).map((file) => `dist/${build}/${file}`))
const snapshot = () => new Map(targets().map((target) => [target, read(target)]))
/** The SDK files of a build inside an archive. */
const archived = (archive) => {
  const all = listPackage(archive, { isPack: false }).map((path) => path.replaceAll("\\", "/"))
  return (build) => all.filter((path) => dirname(path) === `/node_modules/@cursor/sdk/dist/${build}` && path.endsWith(".js")).map((path) => path.split("/").pop())
}
const fromArchive = (archive) => (target) => extractFile(archive, `node_modules/@cursor/sdk/${target}`).toString("utf8")
/** npm's cache as a machine without the package in it has it: every read fails. */
const noCache = { read: () => { throw new Error("npm's cache holds no tarball: no cached package") } }
/** A cache that must not be needed. */
const untouched = { read: (target) => assert.fail(`npm's cache was read for ${target}`) }
try {
  writeFileSync(join(root, "package.json"), "{}")
  mkdirSync(sdk, { recursive: true })
  writeFileSync(join(sdk, "package.json"), readFileSync(join(installed, "package.json")))
  for (const build of builds) {
    mkdirSync(join(sdk, "dist", build), { recursive: true })
    for (const file of readdirSync(join(installed, "dist", build)).filter((name) => name.endsWith(".js")))
      writeFileSync(join(sdk, "dist", build, file), original(`dist/${build}/${file}`))
  }
  assert.throws(() => assertCursorSdkPatched(read, files), /lacks Mako's complete/)
  // A fresh install: patched from its own bytes, which it keeps before the first write.
  patchCursorSdk(sdk, untouched)
  const first = snapshot()
  for (const [target, source] of first) assert.equal(source, readFileSync(join(installed, target), "utf8"), `${target}: the installed SDK carries this patch exactly`)
  const store = pristineStore(sdk, version)
  for (const [target, source] of first) if (source.includes("/*mako:patched") || source !== original(target)) assert.equal(store.get(target).text, original(target), `${target}: its unpatched bytes are kept beside the package`)
  patchCursorSdk(sdk, untouched)
  assert.deepEqual(snapshot(), first, "repeated builds leave patched bytes unchanged")

  const archive = join(root, "app.asar")
  await packArchive(join(root, "app"), archive)
  assertCursorSdkPatched(fromArchive(archive), archived(archive))

  // One site taken back to its unpatched bytes: the marker the rest of the file carries can't hide it.
  const { file, sites } = installedPatch(read, files, "checkpoint-blobs", "esm")
  const site = locate(original(file), sites[1].from)
  const partial = read(file).slice(0, sites[1].index) + original(file).slice(site.index, site.index + site.length) + read(file).slice(sites[1].index + sites[1].length)
  writeFileSync(join(sdk, file), partial)
  assert.throws(() => assertCursorSdkPatched(read, files), /lacks Mako's complete read-through checkpoint blobs \(esm\)/, "the marker alone cannot hide a partial patch")
  const incompleteArchive = join(root, "incomplete.asar")
  await packArchive(join(root, "app"), incompleteArchive)
  assert.throws(() => assertCursorSdkPatched(fromArchive(incompleteArchive), archived(incompleteArchive)), /lacks Mako's complete/, "the package gate checks the archive, not development dependencies")
  // An incomplete patch, or one an older Mako left: patched again from the bytes kept beside the package, never over
  // the old patch, and with no npm.
  patchCursorSdk(sdk, untouched)
  assert.deepEqual(snapshot(), first, "an incomplete patch is redone from the kept bytes")
  const older = /\/\*mako:patched:\d+\*\//
  assert.match(read(file), older)
  writeFileSync(join(sdk, file), read(file).replace(older, () => "/*mako:patched:1*/"))
  patchCursorSdk(sdk, untouched)
  assert.deepEqual(snapshot(), first, "an older patch is replaced by this one")

  // Kept bytes that don't count: another version's, or ones that no longer hash to what was kept.
  const manifestFile = join(sdk, PRISTINE_FOLDER, "manifest.json")
  const manifest = readFileSync(manifestFile, "utf8")
  assert.match(pristineStore(sdk, "0.0.1").get(file).why, /holds @cursor\/sdk .* bytes, not 0\.0\.1's/)
  writeFileSync(join(sdk, PRISTINE_FOLDER, `${file}.gz`), readFileSync(join(sdk, PRISTINE_FOLDER, `dist/cjs/${file.split("/").pop()}.gz`)))
  assert.match(pristineStore(sdk, version).get(file).why, /doesn't hash to what was kept/)
  // Modules an earlier Mako patched, with nothing kept (a local update's `npm install` leaves them as they were): npm's
  // own cache on this machine, which is no network, gives the bytes back, and they're kept from then on.
  rmSync(join(sdk, PRISTINE_FOLDER), { recursive: true })
  writeFileSync(join(sdk, file), read(file).replace(older, () => "/*mako:patched:1*/"))
  const cached = { reads: 0, read(target) { this.reads++; return original(target) } }
  patchCursorSdk(sdk, cached)
  assert.deepEqual(snapshot(), first, "an earlier patch with nothing kept is redone from npm's cache")
  assert.ok(cached.reads > 0)
  assert.equal(pristineStore(sdk, version).get(file).text, original(file), "and what the cache gave is kept, so the next patch needs nothing")
  // Neither kept nor cached: the patch refuses, saying why and how to get the bytes back.
  rmSync(join(sdk, PRISTINE_FOLDER), { recursive: true })
  writeFileSync(join(sdk, file), read(file).replace(older, () => "/*mako:patched:1*/"))
  assert.throws(() => patchCursorSdk(sdk, noCache), (error) =>
    error.message.includes(`${file} carries an earlier Mako patch`) && error.message.includes("nothing is kept in .mako-pristine") &&
    error.message.includes("no cached package") && error.message.includes("rm -rf node_modules/@cursor/sdk && npm install"))
  // npm's cache as it is on disk, read by the integrity the install recorded, with no npm request: here a cache holding
  // a tarball of the kept bytes, and one holding nothing, and one whose tarball doesn't match.
  {
    const cacheDir = join(root, "npm-cache")
    const packed = join(root, "packed")
    mkdirSync(join(packed, "package/dist/esm"), { recursive: true })
    writeFileSync(join(packed, "package/dist/esm", file.split("/").pop()), original(file))
    execFileSync("tar", ["-czf", join(root, "sdk.tgz"), "-C", packed, "package"])
    const tgz = readFileSync(join(root, "sdk.tgz"))
    const digest = createHash("sha512").update(tgz).digest()
    const integrity = `sha512-${digest.toString("base64")}`
    writeFileSync(join(root, "app/node_modules/.package-lock.json"), JSON.stringify({ packages: { "node_modules/@cursor/sdk": { version, integrity } } }))
    const hex = digest.toString("hex")
    const at = join(cacheDir, "_cacache/content-v2/sha512", hex.slice(0, 2), hex.slice(2, 4), hex.slice(4))
    const previous = process.env.npm_config_cache
    process.env.npm_config_cache = cacheDir
    try {
      assert.throws(() => npmCacheCursorSdk(sdk, version).read(file), /holds no tarball with @cursor\/sdk .* integrity sha512-/)
      mkdirSync(dirname(at), { recursive: true })
      writeFileSync(at, Buffer.concat([tgz, Buffer.from("x")]))
      assert.throws(() => npmCacheCursorSdk(sdk, version).read(file), /doesn't match its integrity/)
      writeFileSync(at, tgz)
      const cache = npmCacheCursorSdk(sdk, version)
      assert.equal(cache.read(file), original(file), "the cached tarball gives the shipped bytes back")
      cache.close()
      assert.throws(() => npmCacheCursorSdk(sdk, "0.0.1").read(file), /records no @cursor\/sdk 0\.0\.1/)
    } finally {
      if (previous === undefined) delete process.env.npm_config_cache
      else process.env.npm_config_cache = previous
    }
  }
  // Taking the package back as npm installs it (here: its own bytes) patches with nothing else needed.
  for (const target of targets()) writeFileSync(join(sdk, target), original(target))
  patchCursorSdk(sdk, untouched)
  assert.deepEqual(snapshot(), first)
  assert.ok(existsSync(manifestFile) && readFileSync(manifestFile, "utf8") === manifest, "the reinstalled package keeps the same bytes")

  // A release that only renames: the same patches land, under its names.
  const transcripts = installedPatch(read, files, "transcripts", "esm")
  const writer = transcripts.sites.at(-1).names.get("Ij")
  const storeClass = transcripts.sites.at(-6).names.get("rO")
  const renamed = (text) => text.replace(new RegExp(`(?<![\\w$.])(${writer}|${storeClass})(?![\\w$])`, "g"), (name) => (name === writer ? "Zq9" : "Zr9"))
  const shipped = original(transcripts.file)
  assert.ok(!shipped.includes("Zq9") && !shipped.includes("Zr9"))
  writeFileSync(join(sdk, transcripts.file), renamed(shipped))
  patchCursorSdk(sdk, untouched)
  assert.equal(read(transcripts.file), renamed(first.get(transcripts.file)), "a release that renames takes the same patches under its names")
  assertCursorSdkPatched(read, files)

  // A release whose code changed: the failure names the patch and the anchor that is gone.
  writeFileSync(join(sdk, transcripts.file), shipped.replace(/([\w$]+)=\{log\(\)\{\}\}/, "$1=globalThis.cursorLogger"))
  assert.throws(() => patchCursorSdk(sdk, untouched), (error) => /the run log \(esm/.test(error.message) && /gone: oB=\{log\(\)\{\}\}/.test(error.message) && !/incremental, locked transcript writes \(esm/.test(error.message))
  writeFileSync(join(sdk, transcripts.file), first.get(transcripts.file))

  // The retry loop as 1.4.1 has it: the attempt moved off `y`, and the action took its place. Without the probes the
  // resume account would read the action as the attempt; the patch refuses rather than guess.
  const [resume] = CURSOR_SDK_PATCHES.find((patch) => patch.id === "resume-account" && patch.build === "esm").sites
  const loop = 'for(;;){s.beginAttempt?.({attempt:v,originalRequestId:c}),x=new i.QFf({action:{case:"resumeAction",value:1}});try{return await s.runAttempt({state:w,action:y,checkpointHandler:1})}catch(e){}}'
  const moved = applyAnchored(loop, [resume]).source
  assert.match(moved, /action:v>0\?/)
  assert.match(moved, /\{attempt:v,action:y\.action\.case,requestId:c\}/)
  assert.throws(() => applyAnchored(loop, [{ ...resume, binds: undefined }]), /uses y, which neither its anchor nor a probe binds, and in this release y is what w was/)
  // A replacement's own locals are mako$ names: any other unbound name is refused.
  assert.throws(() => applyAnchored("a.b=f(x)", [{ from: "a.b=f(x)", to: "a.b=f(x,q)", label: "x" }]), /uses q, which neither/)
  console.log(`Cursor SDK patch (@cursor/sdk ${version}): patched with no network from the install's own bytes, kept beside it; repeat build idempotent; an incomplete or older patch redone from what was kept, else npm's local cache, else refused naming the reinstall; another version's or a corrupt copy ignored; actual ASAR checked; a renaming release patched under its names, a changed one refused naming the patch and its anchor, and the retry loop's moved counter caught`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
