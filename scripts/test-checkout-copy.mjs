import { spawn } from "node:child_process"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import { resolveLocalIdentity } from "./mac-local-signing.mjs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"
import { createPackage } from "@electron/asar"
import { copyBuildSource, verifyLocalCandidate } from "../dist-electron/local-updates.js"
import { physicalFiles } from "../dist-electron/physical-files.js"

async function check() {
  const root = process.env.MAKO_COPY_TEST_ROOT
  const source = process.env.MAKO_COPY_TEST_SOURCE
  const checkout = join(root, "source")
  await mkdir(checkout)
  try {
    const files = await physicalFiles()
    if (process.env.MAKO_COPY_TEST_APP) {
      const candidate = join(checkout, "Mako.app")
      await files.cp(source, candidate, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
      const build = await verifyLocalCandidate(candidate, process.env.MAKO_COPY_TEST_IDENTITY)
      const installer = await readFile(join(candidate, "Contents/Resources/app.asar/dist-electron/local-update-installer.js"))
      await writeFile(join(checkout, "installer.mjs"), installer)
      assert.ok(installer.length)
      console.log(`Electron signed-app staging and installer extraction passed: ${build.id}`)
      return
    }
    await copyBuildSource(source, checkout)
    const archive = "node_modules/electron/dist/Electron.app/Contents/Resources/default_app.asar"
    assert.equal((await files.lstat(join(checkout, archive))).isFile(), true)
    assert.deepEqual(await files.readFile(join(checkout, archive)), await files.readFile(join(source, archive)))
    for (const omitted of ["packages/site/.env.local", "packages/site/.next", "packages/site/.eve", "packages/site/.output"]) await assert.rejects(files.lstat(join(checkout, omitted)), { code: "ENOENT" })
    console.log("Electron checkout copy preserves exact ASAR bytes and excludes nested environment files and build caches")
  } catch (error) {
    console.error(JSON.stringify({ message: error.message, code: error.code, syscall: error.syscall, path: error.path, dest: error.dest }, null, 2))
    process.exitCode = 1
  } finally {
    await (await physicalFiles()).rm(checkout, { recursive: true, force: true })
  }
}
if (process.versions.electron) {
  const { app } = await import("electron")
  app.setPath("userData", join(process.env.MAKO_COPY_TEST_ROOT, "profile"))
  void check().then(() => app.exit(process.exitCode === undefined ? 0 : Number(process.exitCode))).catch((error) => { console.error(error); app.exit(1) })
} else {
  const root = await mkdtemp(join(tmpdir(), "mako-checkout-copy-"))
  const stagedApp = process.argv[2] === "--app"
  const sourceArgument = stagedApp ? process.argv[3] : process.argv[2]
  assert.ok(!stagedApp || sourceArgument, "Pass --app <Mako.app> to verify signed staging")
  const source = sourceArgument ? resolve(sourceArgument) : join(root, "fixture")
  if (!sourceArgument) {
    const payload = join(root, "payload")
    await mkdir(payload)
    await writeFile(join(payload, "package.json"), JSON.stringify({ name: "archive-fixture" }))
    const resources = join(source, "node_modules/electron/dist/Electron.app/Contents/Resources")
    await mkdir(resources, { recursive: true })
    await createPackage(payload, join(resources, "default_app.asar"))
    await mkdir(join(source, "packages/site"), { recursive: true })
    await writeFile(join(source, "packages/site/.env.local"), "fixture=not-for-build")
    for (const directory of [".next", ".eve", ".output"]) {
      await mkdir(join(source, "packages/site", directory))
      await writeFile(join(source, "packages/site", directory, "cache"), "generated")
    }
  }
  await mkdir(join(root, "profile"))
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-copy-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_COPY_TEST_ROOT: root, MAKO_COPY_TEST_SOURCE: source, MAKO_COPY_TEST_APP: stagedApp ? "1" : "", MAKO_COPY_TEST_IDENTITY: stagedApp ? await resolveLocalIdentity(undefined, source) : "" }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
  process.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => resolve(code ?? 1)) })
}
