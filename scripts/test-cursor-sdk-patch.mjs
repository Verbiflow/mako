import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { createRequire } from "node:module"
import { extractFile, listPackage } from "@electron/asar"
import { packArchive } from "./lib/pack-archive.mjs"
import { applyAnchored, locate } from "./lib/anchored-patch.mjs"
import { assertCursorSdkPatched, CURSOR_SDK_PATCHES, folderFiles, installedPatch, patchCursorSdk, shippedCursorSdk } from "./patch-cursor-sdk.mjs"

const installed = join(dirname(createRequire(import.meta.url).resolve("@cursor/sdk")), "../..")
const { version } = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"))
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
// npm's bytes of the installed version: what a checkout's cached, unpatched dependency tree holds.
const npm = shippedCursorSdk(version)
const shipped = { read: (target) => npm.read(target) }
try {
  writeFileSync(join(root, "package.json"), "{}")
  mkdirSync(sdk, { recursive: true })
  writeFileSync(join(sdk, "package.json"), readFileSync(join(installed, "package.json")))
  for (const build of builds) {
    mkdirSync(join(sdk, "dist", build), { recursive: true })
    for (const file of readdirSync(join(installed, "dist", build)).filter((name) => name.endsWith(".js")))
      writeFileSync(join(sdk, "dist", build, file), npm.read(`dist/${build}/${file}`))
  }
  assert.throws(() => assertCursorSdkPatched(read, files), /lacks Mako's complete/)
  patchCursorSdk(sdk, shipped)
  const first = snapshot()
  for (const [target, source] of first) assert.equal(source, readFileSync(join(installed, target), "utf8"), `${target}: the installed SDK carries this patch exactly`)
  patchCursorSdk(sdk, shipped)
  assert.deepEqual(snapshot(), first, "repeated builds leave patched bytes unchanged")

  const archive = join(root, "app.asar")
  await packArchive(join(root, "app"), archive)
  assertCursorSdkPatched(fromArchive(archive), archived(archive))

  // One site taken back to npm's bytes: the marker the rest of the file carries can't hide it.
  const { file, sites } = installedPatch(read, files, "checkpoint-blobs", "esm")
  const original = locate(npm.read(file), sites[1].from)
  const partial = read(file).slice(0, sites[1].index) + npm.read(file).slice(original.index, original.index + original.length) + read(file).slice(sites[1].index + sites[1].length)
  writeFileSync(join(sdk, file), partial)
  assert.throws(() => assertCursorSdkPatched(read, files), /lacks Mako's complete read-through checkpoint blobs \(esm\)/, "the marker alone cannot hide a partial patch")
  const incompleteArchive = join(root, "incomplete.asar")
  await packArchive(join(root, "app"), incompleteArchive)
  assert.throws(() => assertCursorSdkPatched(fromArchive(incompleteArchive), archived(incompleteArchive)), /lacks Mako's complete/, "the package gate checks the archive, not development dependencies")
  // An incomplete patch, or one an older Mako left (what the updater's copy of a person's modules holds): patched
  // again from the shipped bytes, never over the old patch.
  patchCursorSdk(sdk, shipped)
  assert.deepEqual(snapshot(), first, "an incomplete patch is redone")
  const older = /\/\*mako:patched:\d+\*\//
  assert.match(read(file), older)
  writeFileSync(join(sdk, file), read(file).replace(older, () => "/*mako:patched:1*/"))
  patchCursorSdk(sdk, shipped)
  assert.deepEqual(snapshot(), first, "an older patch is replaced by this one")

  // A release that only renames: the same patches land, under its names.
  const transcripts = installedPatch(read, files, "transcripts", "esm")
  const writer = transcripts.sites.at(-1).names.get("Ij")
  const store = transcripts.sites.at(-6).names.get("rO")
  const renamed = (text) => text.replace(new RegExp(`(?<![\\w$.])(${writer}|${store})(?![\\w$])`, "g"), (name) => (name === writer ? "Zq9" : "Zr9"))
  assert.ok(!npm.read(transcripts.file).includes("Zq9") && !npm.read(transcripts.file).includes("Zr9"))
  writeFileSync(join(sdk, transcripts.file), renamed(npm.read(transcripts.file)))
  patchCursorSdk(sdk, shipped)
  assert.equal(read(transcripts.file), renamed(first.get(transcripts.file)), "a release that renames takes the same patches under its names")
  assertCursorSdkPatched(read, files)

  // A release whose code changed: the failure names the patch and the anchor that is gone.
  writeFileSync(join(sdk, transcripts.file), npm.read(transcripts.file).replace(/([\w$]+)=\{log\(\)\{\}\}/, "$1=globalThis.cursorLogger"))
  assert.throws(() => patchCursorSdk(sdk, shipped), (error) => /the run log \(esm/.test(error.message) && /gone: oB=\{log\(\)\{\}\}/.test(error.message) && !/incremental, locked transcript writes \(esm/.test(error.message))
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
  console.log(`Cursor SDK patch (@cursor/sdk ${version}): npm's tree patched to the installed bytes, repeat build idempotent, incomplete or older patch redone from the shipped bytes, actual ASAR checked; a renaming release patched under its names, a changed one refused naming the patch and its anchor, and the retry loop's moved counter caught`)
} finally {
  npm.close()
  rmSync(root, { recursive: true, force: true })
}
