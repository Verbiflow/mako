import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { promisify } from "node:util"
const run = promisify(execFile)
const builder = resolve("scripts/package-control-runtime.mjs")
const temporary = await realpath(await mkdtemp(join(tmpdir(), "mako-runtime-package-")))
const root = join(temporary, "source")
await mkdir(root)
async function put(path, text) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text) }
async function build(output) { return run(process.execPath, [builder, `--output=${join(temporary, output)}`, "--platform=linux-x64"], { cwd: root }) }
try {
  await put("dist-electron/cloud-control-main.js", "import './dependency.js';")
  await put("dist-electron/dependency.js", "export const value = 1;")
  await put("dist-electron/cloud-control-worker.js", "export const worker = true;")
  await put("dist-electron/control-cli.js", "export const cli = true;")
  await put("packages/control/dist/program/worker.js", "export const dynamicWorker = true;")
  await put("packages/control/package.json", '{"name":"@mako/control","type":"module"}')
  await put("runtime/control/package.json", '{"name":"@mako/control-runtime","type":"module"}')
  const lock = { packages: { "": {}, "packages/control": {}, "node_modules/zod": { resolved: "https://registry.npmjs.org/zod/-/zod.tgz", integrity: "sha512-fixture" } } }
  await put("runtime/control/package-lock.json", JSON.stringify(lock))
  await put("docs/local-control-runtime.md", "Fixture documentation")
  await put("LICENSE", "Fixture license")
  for (const path of [".env", ".git/config", "node_modules/private-token", "dist-electron/unreferenced.js"]) await put(path, "CREDENTIAL_CANARY_DO_NOT_COPY")
  await build("release")
  const manifest = JSON.parse(await readFile(join(temporary,"release/manifest.json")))
  assert.ok(manifest.files.some(file => file.path === "dist-electron/cloud-control-worker.js"))
  assert.ok(manifest.files.some(file => file.path === "dist-electron/control-cli.js"))
  assert.ok(manifest.files.some(file => file.path === "packages/control/dist/program/worker.js"))
  for (const file of manifest.files) {
    const bytes = await readFile(join(temporary,"release",file.path))
    assert.ok(!bytes.includes("CREDENTIAL_CANARY_DO_NOT_COPY"))
    assert.equal(createHash("sha256").update(bytes).digest("hex"),file.sha256)
  }
  await assert.rejects(build("release"), /EEXIST/)
  await rm(join(root,"dist-electron/dependency.js"))
  await writeFile(join(temporary,"outside.js"), "export const secret = 1;")
  await symlink(join(temporary,"outside.js"),join(root,"dist-electron/dependency.js"))
  await assert.rejects(build("symlink"))
  await rm(join(root,"dist-electron/dependency.js"))
  await put("dist-electron/dependency.js", "import 'electron';")
  await assert.rejects(build("electron"), /must not import Electron/)
  lock.packages["node_modules/zod"].resolved = "https://private.example/zod.tgz"
  await put("runtime/control/package-lock.json",JSON.stringify(lock))
  await assert.rejects(build("private-registry"), /public npm/)
  console.log("Cloud package: exact hashes, both workers, secret canary exclusion, overwrite/symlink/Electron/private-registry refusal passed")
} finally { await rm(temporary,{recursive:true,force:true}) }
