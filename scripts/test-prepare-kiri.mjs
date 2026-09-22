import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

const run = promisify(execFile)
const root = await mkdtemp(join(tmpdir(), "mako-kiri-provenance-"))
const project = join(root, "mako")
const source = join(root, "source")
const target = join(root, "target")
const bin = join(root, "bin")
const vendor = join(project, "vendor/kiri", `${process.platform}-${process.arch}`)
const schema = { version: 1, schema_hash: "fixture-schema" }
const env = { ...process.env, KIRI_SOURCE_DIR: source, CARGO_TARGET_DIR: target, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" }
const git = (...args) => run("git", args, { cwd: source, env })
const prepare = () => run(process.execPath, [join(project, "scripts/prepare-kiri.mjs")], { env })
try {
  for (const path of [source, bin, vendor, join(target, "release"), join(project, "scripts"), join(project, "node_modules/@kiri/client/dist")]) await mkdir(path, { recursive: true })
  await copyFile(resolve("scripts/prepare-kiri.mjs"), join(project, "scripts/prepare-kiri.mjs"))
  await writeFile(join(source, "Cargo.toml"), "# committed fixture\n")
  await git("init", "-q")
  await git("add", "Cargo.toml")
  await git("commit", "-qm", "Fixture source")
  const revision = (await git("rev-parse", "HEAD")).stdout.trim()
  await writeFile(join(bin, "cargo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
  const candidate = join(target, "release/kiri-engine")
  await writeFile(candidate, `#!${process.execPath}\nconsole.log(${JSON.stringify(JSON.stringify(schema))})\n`, { mode: 0o755 })
  const destination = join(vendor, "kiri-engine")
  await writeFile(destination, "previous engine")
  const sdk = join(project, "node_modules/@kiri/client/dist/schema.json")
  await writeFile(sdk, JSON.stringify({ ...schema, schema_hash: "different" }))
  await assert.rejects(prepare(), /different protocol versions/)
  assert.equal(await readFile(destination, "utf8"), "previous engine", "A refused engine must not replace the working vendor binary")
  await writeFile(sdk, JSON.stringify(schema))
  await prepare()
  const manifest = JSON.parse(await readFile(join(vendor, "manifest.json"), "utf8"))
  assert.equal(manifest.sourceRevision, revision)
  assert.equal(manifest.schema, schema.schema_hash)
  assert.match(manifest.sha256, /^[a-f0-9]{64}$/)
  await writeFile(join(source, "Cargo.toml"), "# uncommitted edit\n")
  await assert.rejects(prepare(), /uncommitted changes/)
  env.KIRI_SOURCE_DIR = join(root, "missing")
  await chmod(destination, 0o755)
  await prepare()
  assert.equal(JSON.parse(await readFile(join(vendor, "manifest.json"), "utf8")).sourceRevision, revision)
  console.log("Kiri packaging: mismatch preserves the prior engine; dirty sources are refused; committed provenance survives vendor-only builds")
} finally {
  await rm(root, { recursive: true, force: true })
}
