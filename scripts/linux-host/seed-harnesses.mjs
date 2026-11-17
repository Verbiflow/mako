import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"

/**
 * The harness builds Mako keeps itself (`vendor/harness-builds/sources.json`,
 * scripts/lib/harness-builds.mjs), laid out under this user's home as the
 * vendor's installer lays them, before the host installs the rest: a harness
 * whose vendor withdraws each build as it ships the next is then present at
 * exactly the version Mako tested, and `install-harnesses.mjs` finds it there.
 * Each archive is checked by its sha256 first. Only this machine's target is
 * laid out, and with `only` named, only those harnesses.
 *
 *   node seed-harnesses.mjs <folder holding sources.json and the archives> [<harness>...]
 */
const [folder, ...only] = process.argv.slice(2)
assert.ok(folder, "Pass the folder holding sources.json and the archives")
const target = { x64: "x86_64-unknown-linux", arm64: "aarch64-unknown-linux" }[process.arch]
assert.ok(target, `No kept builds for ${process.arch}`)
const home = homedir()
const at = (path) => join(home, path)
const { builds } = JSON.parse(readFileSync(join(folder, "sources.json"), "utf8"))
for (const build of builds) {
  if (build.target !== target || (only.length && !only.includes(build.harness))) continue
  const archive = join(folder, build.archive)
  const bytes = readFileSync(archive)
  assert.equal(createHash("sha256").update(bytes).digest("hex"), build.sha256, `${build.archive} isn't the pinned build`)
  const unpack = at(build.unpack)
  rmSync(unpack, { recursive: true, force: true })
  mkdirSync(unpack, { recursive: true })
  execFileSync("tar", ["xzf", archive, "-C", unpack])
  for (const [path, content] of Object.entries(build.files ?? {})) writeFileSync(at(path), content)
  for (const [path, to] of Object.entries(build.links ?? {})) {
    const link = at(path)
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { force: true })
    symlinkSync(to.startsWith("~/") ? at(to.slice(2)) : to, link)
  }
  for (const path of Object.keys(build.links ?? {})) assert.ok(existsSync(at(path)), `${path} resolves`)
  console.log(`${build.harness} ${build.version} laid out from ${build.archive}`)
}
