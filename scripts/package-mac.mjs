import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { constants, createReadStream } from "node:fs"
import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { build, Platform, Arch } from "electron-builder"
import { extractFile } from "@electron/asar"
import { assertPackagedImports } from "./test-packaged-imports.mjs"
import { localMacConfig, resolveLocalIdentity, verifyLocalSignature } from "./mac-local-signing.mjs"

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
assert.ok(
  args.every((arg) => arg === "--dir" || arg === "--local" || arg.startsWith("--output=")),
  "Use --dir, --local, and/or --output=<directory>"
)
assert.ok(!args.includes("--local") || args.includes("--dir"), "Local signing produces an app directory, not public release archives")
const localIdentity = args.includes("--local")
  ? await resolveLocalIdentity(process.env.MAKO_LOCAL_SIGNING_IDENTITY)
  : null
const output = resolve(
  args.find((arg) => arg.startsWith("--output="))?.slice(9) ??
    join(project, "release", localIdentity ? "local" : ".")
)
const stage = await mkdtemp(join(tmpdir(), "mako-package-inputs-"))
const inputs = [
  "dist",
  "dist-electron",
  "dist-browser-extension",
  "package.json",
  "packages/sessions/package.json",
  "packages/sessions/dist",
  "packages/relay/package.json",
  "packages/relay/dist",
  "packages/control/package.json",
  "packages/control/dist",
  "mako-icons/_masters/desktop-light.png",
  "mako-icons/_masters/desktop-dark.png",
  "build/Mako.icns",
  "build/entitlements.mac.plist",
  "build/mako-notification-status",
  "vendor/kiri",
]
async function digest(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
async function manifest(root) {
  const files = []
  async function visit(path) {
    const entries = await readdir(join(root, path), {
      withFileTypes: true,
    }).catch((error) => {
      if (error.code === "ENOTDIR") return null
      throw error
    })
    if (!entries) {
      files.push(path)
      return
    }
    for (const entry of entries) await visit(join(path, entry.name))
  }
  for (const path of inputs) await visit(path)
  const paths = files.sort()
  const result = Array.from({ length: paths.length })
  let next = 0
  await Promise.all(
    Array.from({ length: 16 }, async () => {
      while (next < paths.length) {
        const index = next++
        result[index] = { path: paths[index], sha256: await digest(join(root, paths[index])) }
      }
    })
  )
  return result
}
try {
  // The notification authorization helper ships beside the executable; see
  // electron/notification-authorization.ts for why it must live there.
  execFileSync(process.execPath, [join(project, "scripts/build-notification-status.mjs"), "--require", "--if-fresh"], { cwd: project, stdio: "inherit" })
  const before = await manifest(project)
  await Promise.all(inputs.map(async (path) => {
    await mkdir(dirname(join(stage, path)), { recursive: true })
    await cp(join(project, path), join(stage, path), {
      recursive: true,
      mode: constants.COPYFILE_FICLONE,
    })
  }))
  assert.deepEqual(
    await manifest(stage),
    before,
    "Build output changed while being copied; finish compilation and retry packaging"
  )
  assert.deepEqual(
    await manifest(project),
    before,
    "Build output changed while being copied; finish compilation and retry packaging"
  )
  const pkg = JSON.parse(await readFile(join(stage, "package.json"), "utf8"))
  const revision = process.env.MAKO_BUILD_REVISION ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim()
  assert.match(revision, /^[a-f0-9]{40}$/)
  const dirty = process.env.MAKO_BUILD_DIRTY === undefined
    ? Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: project, encoding: "utf8" }).trim())
    : process.env.MAKO_BUILD_DIRTY === "1"
  const makoBuild = { id: createHash("sha256").update(JSON.stringify(before)).digest("hex").slice(0, 16), builtAt: new Date().toISOString(), revision, dirty }
  const configuration = { ...pkg.build, extraMetadata: { ...pkg.build.extraMetadata, makoBuild } }
  const buildConfig = localIdentity ? localMacConfig(configuration, localIdentity) : configuration
  const packagedMetadata = { ...pkg, ...buildConfig.extraMetadata }
  await writeFile(join(stage, "package.json"), JSON.stringify(packagedMetadata))
  const config = join(stage, "electron-builder.json")
  await writeFile(
    config,
    JSON.stringify({
      ...buildConfig,
      // Every native module we ship is a prebuilt platform package, so the
      // @electron/rebuild pass only walks the dependency graph for nothing.
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      directories: {
        ...buildConfig.directories,
        output,
        buildResources: join(stage, "build"),
      },
      files: [
        {
          from: stage,
          to: ".",
          filter: [
            "dist/**",
            "dist-electron/**",
            "dist-browser-extension/**",
            "mako-icons/_masters/*.png",
            "package.json",
            "!**/*.map",
          ],
        },
        ...["sessions", "relay", "control"].map((name) => ({
          from: join(stage, "packages", name),
          to: `node_modules/@mako/${name}`,
          filter: ["package.json", "dist/**", "!**/*.map"],
        })),
      ],
      extraResources: [...(buildConfig.extraResources ?? []), { from: join(stage, "vendor/kiri"), to: "kiri" }],
      extraFiles: [...(buildConfig.extraFiles ?? []), { from: join(stage, "build/mako-notification-status"), to: "MacOS/mako-notification-status" }],
      mac: {
        ...buildConfig.mac,
        binaries: [
          ...(buildConfig.mac?.binaries ?? []),
          "Contents/Resources/kiri/darwin-arm64/kiri-engine",
          "Contents/MacOS/mako-notification-status",
        ],
        icon: join(stage, "build/Mako.icns"),
        entitlements: join(stage, "build/entitlements.mac.plist"),
        entitlementsInherit: join(stage, "build/entitlements.mac.plist"),
      },
    })
  )
  await build({
    projectDir: project,
    targets: Platform.MAC.createTarget(
      args.includes("--dir") ? ["dir"] : ["dmg", "zip"],
      Arch.arm64
    ),
    publish: "never",
    config,
  })
  const app = join(output, "mac-arm64", `${pkg.build.productName}.app`)
  const archive = join(app, "Contents/Resources/app.asar")
  const metadata = JSON.parse(extractFile(archive, "package.json").toString("utf8"))
  for (const [key, value] of Object.entries(buildConfig.extraMetadata ?? {}))
    assert.deepEqual(metadata[key], value, `Packaged metadata differs from the frozen configuration: ${key}`)
  const verified = []
  for (const file of before) {
    if (file.path.startsWith("vendor/kiri/")) {
      const target = join(app, "Contents/Resources", file.path.slice("vendor/".length))
      if (file.path.endsWith("/kiri-engine")) {
        const schema = JSON.parse(execFileSync(target, ["--schema"], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }))
        const expected = JSON.parse(await readFile(join(stage, "vendor/kiri/darwin-arm64/manifest.json"), "utf8"))
        assert.equal(schema.version, expected.protocol, "Packaged Kiri protocol differs from the client build")
      } else assert.equal(await digest(target), file.sha256, `Packaged Kiri resource differs: ${file.path}`)
      verified.push({ path: target, sha256: await digest(target) })
      continue
    }
    if (
      file.path === "package.json" ||
      file.path.startsWith("build/") ||
      file.path.endsWith(".map")
    )
      continue
    const target = file.path.replace(
      /^packages\/(sessions|relay|control)\//,
      "node_modules/@mako/$1/"
    )
    assert.equal(
      createHash("sha256").update(extractFile(archive, target)).digest("hex"),
      file.sha256,
      `Packaged bytes differ from the frozen build: ${target}`
    )
    verified.push({ path: target, sha256: file.sha256 })
  }
  const imports = assertPackagedImports(app)
  const signature = localIdentity ? await verifyLocalSignature(app, localIdentity) : null
  execFileSync(process.execPath, [join(project, "scripts/test-packaged-startup.mjs"), app], { cwd: project, stdio: "inherit", timeout: 180_000 })
  execFileSync(process.execPath, [join(project, "scripts/test-packaged-startup.mjs"), app, "--launch-services"], { cwd: project, stdio: "inherit", timeout: 180_000 })
  await writeFile(
    join(output, "package-inputs.json"),
    JSON.stringify({ app, imports, signature, files: verified }, null, 2)
  )
  console.log(
    `Packaged ${verified.length} verified build files with ${imports} resolved host imports`
  )
} finally {
  await rm(stage, { recursive: true, force: true })
}
