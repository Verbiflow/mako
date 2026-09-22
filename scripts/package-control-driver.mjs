import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { cp, mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join, resolve } from "node:path"
import { resolveLocalIdentity } from "./mac-local-signing.mjs"

// Package an explicitly built, pinned source checkout. No upstream application,
// PATH entry, permissions or running process is changed by packaging.
const run = promisify(execFile)
const source = process.argv[2]
assert.ok(
  source,
  "Usage: node scripts/package-control-driver.mjs <source checkout>"
)
const root = resolve(source),
  vendor = resolve("vendor/cua-driver")
const manifest = JSON.parse(
  await readFile(join(vendor, "release.json"), "utf8")
)
const { stdout: head } = await run("git", ["-C", root, "rev-parse", "HEAD"])
assert.equal(
  head.trim(),
  manifest.base,
  "Driver source release must match the pinned base"
)
const { stdout: diff } = await run(
  "git",
  ["-C", root, "diff", "HEAD", "--", "libs/cua-driver/rust"],
  { maxBuffer: 8 * 1024 * 1024 }
)
const patch = await readFile(join(vendor, manifest.patch), "utf8")
assert.equal(
  diff,
  patch,
  "Source changes must match the reviewed release patch exactly"
)
const workspace = join(root, "libs/cua-driver/rust")
await run("cargo", ["build", "--release", "--locked", "-p", "cua-driver"], {
  cwd: workspace,
  timeout: 1800000,
  maxBuffer: 8 * 1024 * 1024,
  env: {
    ...process.env,
    CARGO_BUILD_JOBS: "2",
    CUA_DRIVER_SOURCE_SHA: manifest.base + "-" + manifest.version,
  },
})
const binary = join(workspace, "target/release/cua-driver")
await stat(binary)
const identity = await resolveLocalIdentity(
  process.env.MAKO_LOCAL_SIGNING_IDENTITY
)
const output = resolve("release/control-driver", manifest.version)
const app = join(output, "CuaDriverLocal.app")
await mkdir(output, { recursive: true })
// Fail instead of silently replacing an already reviewed build artifact.
await mkdir(app)
await cp(
  join(workspace, "scripts/CuaDriverBundle/Contents"),
  join(app, "Contents"),
  { recursive: true, filter: (source) => !source.endsWith("/.gitkeep") }
)
await mkdir(join(app, "Contents/MacOS"), { recursive: true })
await cp(join(root, "LICENSE.md"), join(output, "LICENSE.md"))
await mkdir(join(app, "Contents/Resources"), { recursive: true })
await cp(
  join(root, "LICENSE.md"),
  join(app, "Contents/Resources/LICENSE-Cua.md")
)
await cp(binary, join(app, "Contents/MacOS/cua-driver"))
const plist = join(app, "Contents/Info.plist")
for (const [key, value] of Object.entries({
  CFBundleIdentifier: "com.trycua.driver.local",
  CFBundleName: "Cua Driver Local",
  CFBundleDisplayName: "Cua Driver Local",
  CFBundleExecutable: "cua-driver",
  CFBundleShortVersionString: manifest.version,
  CFBundleVersion: manifest.version,
})) {
  await run("/usr/bin/plutil", ["-replace", key, "-string", value, plist])
}
await run(
  "/usr/bin/codesign",
  [
    "--force",
    "--sign",
    identity,
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    join(workspace, "scripts/CuaDriver.entitlements"),
    app,
  ],
  { timeout: 60000 }
)
await run(
  "/usr/bin/codesign",
  [
    "--verify",
    "--deep",
    "--strict",
    "--test-requirement",
    `=identifier "com.trycua.driver.local" and certificate leaf = H"${identity}"`,
    app,
  ],
  { timeout: 60000 }
)
const { stdout: version } = await run(
  join(app, "Contents/MacOS/cua-driver"),
  ["--version"],
  { timeout: 10000 }
)
assert.equal(version.trim(), `cua-driver ${manifest.version}`)
const sha256 = (data) => createHash("sha256").update(data).digest("hex")
await writeFile(
  join(output, "provenance.json"),
  JSON.stringify(
    {
      ...manifest,
      identity,
      patchSha256: sha256(patch),
      binarySha256: sha256(
        await readFile(join(app, "Contents/MacOS/cua-driver"))
      ),
      distribution: "local-certificate-signed",
      notarized: false,
    },
    null,
    2
  )
)
console.log(app)
