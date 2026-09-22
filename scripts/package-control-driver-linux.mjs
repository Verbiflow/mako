import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

const run = promisify(execFile)
const source = process.argv[2]
assert.ok(
  source,
  "Usage: node scripts/package-control-driver-linux.mjs <pinned source checkout>"
)
const root = resolve(source)
const manifest = JSON.parse(
  await readFile("vendor/cua-driver/release.json", "utf8")
)
const patch = await readFile(join("vendor/cua-driver", manifest.patch), "utf8")
async function verifySource() {
  assert.equal(
    (await run("git", ["-C", root, "rev-parse", "HEAD"])).stdout.trim(),
    manifest.base
  )
  assert.equal(
    (
      await run(
        "git",
        ["-C", root, "diff", "HEAD", "--", "libs/cua-driver/rust"],
        { maxBuffer: 8 * 1024 * 1024 }
      )
    ).stdout,
    patch
  )
}
await verifySource()
const image = "mako-control-linux:platform-v2"
await run("docker", ["image", "inspect", image])
const architecture = (
  await run("docker", ["run", "--rm", image, "uname", "-m"])
).stdout.trim()
assert.ok(["aarch64", "x86_64"].includes(architecture))
const platform = architecture === "aarch64" ? "linux-arm64" : "linux-x64"
const volume = "mako-control-linux-target"
const mounts = ["--mount", `type=volume,source=${volume},target=/target`]
await run(
  "docker",
  [
    "run",
    "--rm",
    ...mounts,
    "--mount",
    `type=bind,source=${join(root, "libs/cua-driver")},target=/source,readonly`,
    "--mount",
    "type=volume,source=mako-control-linux-cargo,target=/usr/local/cargo/registry",
    "-e",
    "CARGO_TARGET_DIR=/target",
    "-e",
    "CARGO_BUILD_JOBS=4",
    "-w",
    "/source/rust",
    image,
    "cargo",
    "build",
    "--release",
    "--locked",
    "-p",
    "cua-driver",
  ],
  { timeout: 1800000, maxBuffer: 16 * 1024 * 1024 }
)
await verifySource()
const version = (
  await run("docker", [
    "run",
    "--rm",
    ...mounts,
    image,
    "/target/release/cua-driver",
    "--version",
  ])
).stdout.trim()
assert.equal(version, `cua-driver ${manifest.version}`)
const output = resolve("release/control-driver", manifest.version, platform)
await mkdir(resolve(output, ".."), { recursive: true })
await mkdir(output)
const container = (
  await run("docker", ["create", ...mounts, image, "true"])
).stdout.trim()
try {
  await run("docker", [
    "cp",
    `${container}:/target/release/cua-driver`,
    join(output, "cua-driver"),
  ])
} finally {
  await run("docker", ["rm", container])
}
await cp(join(root, "LICENSE.md"), join(output, "LICENSE-Cua.md"))
const hash = (data) => createHash("sha256").update(data).digest("hex")
const imageId = (
  await run("docker", ["image", "inspect", "--format", "{{.Id}}", image])
).stdout.trim()
const libraries = (
  await run("docker", [
    "run",
    "--rm",
    ...mounts,
    image,
    "ldd",
    "/target/release/cua-driver",
  ])
).stdout
await writeFile(
  join(output, "provenance.json"),
  JSON.stringify(
    {
      base: manifest.base,
      version: manifest.version,
      platform,
      imageId,
      patchSha256: hash(patch),
      binarySha256: hash(await readFile(join(output, "cua-driver"))),
      libraries,
      builtAt: new Date().toISOString(),
    },
    null,
    2
  ) + "\n"
)
console.log(output)
