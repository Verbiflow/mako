import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const run = promisify(execFile)
const source = process.argv[2]
const options = process.argv.slice(3)
assert.ok(options.every((arg) => /^--(?:arch|image)=.+$/.test(arg)), "Use --arch=arm64|x64 and --image=<build-image>")
const arch = options.find((arg) => arg.startsWith("--arch="))?.slice(7)
assert.ok(arch === "arm64" || arch === "x64", "Specify the release target explicitly: --arch=arm64 or --arch=x64")
const image = options.find((arg) => arg.startsWith("--image="))?.slice(8) ?? "mako-control-linux:platform-v2"
const dockerPlatform = arch === "arm64" ? "linux/arm64" : "linux/amd64"
const platform = `linux-${arch}`
assert.ok(
  source,
  "Usage: node scripts/package-control-driver-linux.mjs <pinned source checkout> --arch=arm64|x64 [--image=<build-image>]"
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
  const actualPatch = (
      await run(
        "git",
        [
          "-C",
          root,
          "diff",
          "HEAD",
          "--",
          "libs/cua-driver/rust",
          "libs/cua-driver/wayland-helper",
        ],
        { maxBuffer: 8 * 1024 * 1024 }
      )
    ).stdout
  const digest = value => createHash("sha256").update(value).digest("hex")
  assert.equal(digest(actualPatch), digest(patch), "Native source changed during packaging; rebuild from the reviewed patch")
}
await verifySource()
// Build an immutable archive reconstructed from the pinned base and reviewed
// patch. Live bind-mounted source can change (or expose partial reads) mid-build.
const snapshot = await mkdtemp(join(tmpdir(), "mako-linux-driver-source-"))
const sourceArchive = join(snapshot, "source.tar")
try {
  await run("git", [
    "-C",
    root,
    "archive",
    "--format=tar",
    `--output=${join(snapshot, "base.tar")}`,
    manifest.base,
    "libs/cua-driver",
  ])
  await run("tar", ["-xf", join(snapshot, "base.tar"), "-C", snapshot])
  await writeFile(join(snapshot, "release.patch"), patch)
  await run("git", ["apply", join(snapshot, "release.patch")], {
    cwd: snapshot,
  })
  await run("tar", [
    "-cf",
    sourceArchive,
    "-C",
    join(snapshot, "libs/cua-driver"),
    "rust",
    "wayland-helper",
  ])
  await run("docker", ["image", "inspect", image])
  const architecture = (
    await run("docker", ["run", "--rm", "--platform", dockerPlatform, image, "uname", "-m"])
  ).stdout.trim()
  assert.equal(architecture, arch === "arm64" ? "aarch64" : "x86_64", "Build image does not match requested release target")
  // Preserve the established ARM cache; x64 never shares architecture artifacts.
  const volume = arch === "arm64" ? "mako-control-linux-target" : "mako-control-linux-target-x64"
  const mounts = ["--platform", dockerPlatform, "--mount", `type=volume,source=${volume},target=/target`]
  await run(
    "docker",
    [
      "run",
      "--rm",
      ...mounts,
      "--mount",
      `type=bind,source=${sourceArchive},target=/source.tar,readonly`,
      "--mount",
      "type=volume,source=mako-control-linux-cargo,target=/usr/local/cargo/registry",
      "-e",
      "CARGO_TARGET_DIR=/target",
      "-e",
      "CARGO_BUILD_JOBS=4",
      image,
      "sh",
      "-c",
      "mkdir -p /build && tar -xf /source.tar -C /build && cd /build/rust && cargo build --release --locked -p cua-driver --features portal-input",
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
  const runtimeManifest = JSON.parse((await run("docker", ["run", "--rm", ...mounts, image,
    "/target/release/cua-driver", "manifest"])).stdout)
  assert.equal(runtimeManifest.features?.portal_input, true, "Linux releases must include the GNOME/KDE portal input backend")
  const elf = (await run("docker", ["run", "--rm", ...mounts, image, "readelf", "-h", "/target/release/cua-driver"])).stdout
  assert.match(elf, arch === "arm64" ? /Machine:\s+AArch64/ : /Machine:\s+Advanced Micro Devices X86-64/, "Executable architecture differs from release target")
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
  await cp(
    join(snapshot, "libs/cua-driver/wayland-helper"),
    join(output, "wayland-helper"),
    { recursive: true }
  )
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
  assert.ok(!libraries.includes("not found"), "Native runtime is missing a shared library")
  await writeFile(
    join(output, "provenance.json"),
    JSON.stringify(
      {
        base: manifest.base,
        version: manifest.version,
        platform,
        features: runtimeManifest.features,
        elf,
        imageId,
        patchSha256: hash(patch),
        sourceArchiveSha256: hash(await readFile(sourceArchive)),
        binarySha256: hash(await readFile(join(output, "cua-driver"))),
        gnomeHelper: {
          api: 10,
          files: Object.fromEntries(
            await Promise.all(
              ["extension.js", "metadata.json"].map(async (file) => [
                file,
                hash(
                  await readFile(
                    join(output, "wayland-helper/winrects@cua", file)
                  )
                ),
              ])
            )
          ),
        },
        libraries,
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ) + "\n"
  )
  console.log(output)
} finally {
  await rm(snapshot, { recursive: true, force: true })
}
