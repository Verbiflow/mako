import assert from "node:assert/strict"
import { z } from "zod"
import { execFileSync } from "node:child_process"
import { createReadStream, existsSync } from "node:fs"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { build, Platform, Arch } from "electron-builder"
import { extractFile, listPackage } from "@electron/asar"
import { auditPackage } from "./audit-package.mjs"
import { assertPackagedImports } from "./test-packaged-imports.mjs"
import { assertCursorSdkPatched } from "./patch-cursor-sdk.mjs"

/**
 * Mako for Windows: the same frozen build `package-mac.mjs` ships (the desktop, its host and control runtime, the web
 * client), with Windows's helpers beside `Mako.exe`, as a per-user NSIS installer.
 *
 * NSIS, not MSIX: electron-updater installs updates through NSIS (an MSIX updates only through the Store or App
 * Installer), it installs into the person's own `%LOCALAPPDATA%\Programs` with no administrator, and it installs
 * unsigned, so a build without a certificate still installs and can be tested. An MSIX would also run Mako in a
 * package container whose redirected AppData and registry the host, its harnesses and the login item don't expect.
 *
 *   node scripts/package-windows.mjs [--dir] [--arch=x64|arm64] [--output=<directory>]
 *
 * `--dir` stops at the unpacked app (`win-unpacked`); otherwise the installer, its blockmap and `latest.yml`, the
 * update feed electron-updater reads from the GitHub release, are written too.
 *
 * Signing (Authenticode) follows the environment and never a guess:
 *
 *   Azure Trusted Signing  AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, MAKO_AZURE_SIGNING_ENDPOINT,
 *                          MAKO_AZURE_SIGNING_ACCOUNT, MAKO_AZURE_SIGNING_PROFILE, MAKO_WINDOWS_PUBLISHER
 *   A certificate          WIN_CSC_LINK (a .pfx, base64 or a path), WIN_CSC_KEY_PASSWORD, MAKO_WINDOWS_PUBLISHER
 *   neither                unsigned, `makoDistribution: "unsigned"`, which turns the updater off as on a Mac
 *
 * Half a set fails rather than shipping unsigned by accident. `MAKO_WINDOWS_PUBLISHER` is the certificate's subject
 * common name; the updater refuses an update not signed by it. Only a version tag's build signs (`GITHUB_REF`
 * `refs/tags/v…`): with credentials anywhere else this fails, unless `--sign-untagged` says signing a build no tag
 * names is meant.
 */
const project = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
assert.ok(
  args.every((arg) => arg === "--dir" || arg === "--sign-untagged" || arg.startsWith("--output=") || arg.startsWith("--arch=")),
  "Use --dir, --arch=x64|arm64, --sign-untagged and/or --output=<directory>"
)
assert.equal(process.platform, "win32", "Package Windows on Windows: the native modules installed are this machine's")
const arch = args.find((arg) => arg.startsWith("--arch="))?.slice(7) ?? process.arch
assert.ok(arch === "x64" || arch === "arm64", `Mako for Windows is x64 or arm64, not ${arch}`)
assert.equal(arch, process.arch, "Package on a machine of the target's architecture: its native modules are the ones installed")
const output = resolve(args.find((arg) => arg.startsWith("--output="))?.slice(9) ?? join(project, "release"))

const FileSetSchema = z.object({ from: z.string(), to: z.string(), filter: z.array(z.string()).optional() }).passthrough()
const NoticeSchema = z.enum(["LICENSE", "NOTICE"])
const signing = windowsSigning(process.env)
assert.ok(
  signing.kind === "unsigned" || process.env.GITHUB_REF?.startsWith("refs/tags/v") || args.includes("--sign-untagged"),
  "Signing credentials are set, but this build isn't a version tag's: only a release is signed. Pass --sign-untagged to sign it anyway."
)
const pkgSource = JSON.parse(await readFile(join(project, "package.json"), "utf8"))
/** Windows's helpers beside `Mako.exe`, as `build.win.extraFiles` declares them (the video helper, the control driver). */
/** The helpers built here, each by its script with `--require`: the host's native security helper, which it runs from beside `Mako.exe`. */
const HELPER_BUILDS = { "build/mako-windows.exe": "scripts/build-windows-helper.mjs" }
const helpers = z.array(z.object({ from: z.string(), to: z.string() })).parse(pkgSource.build.win?.extraFiles ?? [])
const inputs = [
  "dist",
  "dist-electron",
  "dist-browser-extension",
  "package.json",
  "LICENSE",
  "NOTICE",
  "packages/sessions/package.json",
  "packages/sessions/dist",
  "packages/lazy/package.json",
  "packages/lazy/dist",
  "packages/git/package.json",
  "packages/git/dist",
  "packages/protocol/package.json",
  "packages/protocol/dist",
  "packages/control/package.json",
  "packages/control/dist",
  "packages/control/LICENSE",
  "packages/control-runtime/package.json",
  "packages/control-runtime/dist",
  "packages/control-runtime/README.md",
  "packages/control-runtime/LICENSE",
  "packages/host/package.json",
  "packages/host/dist",
  "mako-icons/_masters/desktop-light.png",
  "mako-icons/_masters/desktop-dark.png",
  "public/icons/app-icon.png",
  "build/installer.nsh",
  ...helpers.map((helper) => helper.from),
]
/** Other platforms' and the other architecture's native builds, which npm leaves in packages that carry every one. */
const otherArch = arch === "x64" ? "arm64" : "x64"
const foreignBinaries = [
  `!**/node_modules/**/prebuilds/{darwin,linux,android,freebsd,openbsd,sunos,linuxmusl}-*{,/**}`,
  `!**/node_modules/**/prebuilds/win32-${otherArch}{,/**}`,
  `!**/node_modules/**/bin/{darwin,linux}-*{,/**}`,
  `!**/node_modules/**/bin/win32-${otherArch}{,/**}`,
]

async function digest(path) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}
async function manifest(root) {
  const files = []
  async function visit(path) {
    const entries = await readdir(join(root, path), { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOTDIR") return null
      throw error
    })
    if (!entries) {
      files.push(path.replaceAll("\\", "/"))
      return
    }
    for (const entry of entries) await visit(join(path, entry.name))
  }
  for (const path of inputs) await visit(path)
  const paths = files.sort()
  return Promise.all(paths.map(async (path) => ({ path, sha256: await digest(join(root, path)) })))
}

const stage = await mkdtemp(join(tmpdir(), "mako-package-windows-"))
try {
  // The video helper, when this checkout can build one for Windows (`scripts/build-video-helper.mjs`); a declared
  // helper that isn't there fails below rather than shipping an app without it.
  execFileSync(process.execPath, [join(project, "scripts/build-video-helper.mjs"), "--require", "--if-fresh"], { cwd: project, stdio: "inherit" })
  for (const helper of helpers) {
    const builder = HELPER_BUILDS[helper.from]
    if (builder) execFileSync(process.execPath, [join(project, builder), "--require"], { cwd: project, stdio: "inherit" })
  }
  // The control driver is built from its pinned source, which this script doesn't fetch: scripts/package-control-driver-windows.mjs
  // builds it (the release workflow reconstructs the source and copies the result into build/).
  for (const helper of helpers) assert.ok(existsSync(join(project, helper.from)), `build.win.extraFiles names ${helper.from}, which isn't built${/cua-driver|LICENSE-Cua/.test(helper.from) ? ": build the driver with scripts/package-control-driver-windows.mjs, copy cua-driver.exe and LICENSE-Cua.md into build/, and write its notices with scripts/driver-third-party-notices.mjs" : ""}`)
  const before = await manifest(project)
  for (const path of inputs) {
    await mkdir(dirname(join(stage, path)), { recursive: true })
    await cp(join(project, path), join(stage, path), { recursive: true })
  }
  assert.deepEqual(await manifest(stage), before, "Build output changed while being copied; finish compilation and retry packaging")
  assert.deepEqual(await manifest(project), before, "Build output changed while being copied; finish compilation and retry packaging")

  const pkg = JSON.parse(await readFile(join(stage, "package.json"), "utf8"))
  const revision = process.env.MAKO_BUILD_REVISION ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: project, encoding: "utf8" }).trim()
  assert.match(revision, /^[a-f0-9]{40}$/)
  const { buildUncommitted, readUncommitted } = await import("@mako/host/application/local-update-source")
  const { Git } = await import("@mako/git")
  const git = new Git()
  const taken = await buildUncommitted(process.env, () => readUncommitted(git, project)).finally(() => git.close())
  const makoBuild = { id: createHash("sha256").update(JSON.stringify(before)).digest("hex").slice(0, 16), builtAt: new Date().toISOString(), revision, ...taken }
  const makoCloud = process.env.MAKO_CLOUD_URL ? new URL(process.env.MAKO_CLOUD_URL).origin : undefined
  if (makoCloud) assert.match(makoCloud, /^https:\/\//, "MAKO_CLOUD_URL must be an https origin to bake into a package")
  else if (!args.includes("--dir")) console.warn("::warning::MAKO_CLOUD_URL is unset: this release can't sign in to the Mako cloud or send telemetry")
  const extraMetadata = { ...pkg.build.extraMetadata, makoDistribution: signing.kind === "unsigned" ? "unsigned" : "signed", makoBuild, ...(makoCloud && { makoCloud }) }
  const buildConfig = { ...pkg.build, extraMetadata }
  const workspaceFiles = buildConfig.files.flatMap((entry) => {
    const parsed = FileSetSchema.safeParse(entry)
    return parsed.success && parsed.data.from.startsWith("packages/") ? [parsed.data] : []
  })
  await writeFile(join(stage, "package.json"), JSON.stringify({ ...pkg, ...extraMetadata }))
  const artifactName = "${productName}-Setup-${arch}.${ext}"
  const config = join(stage, "electron-builder.json")
  await writeFile(
    config,
    JSON.stringify({
      ...buildConfig,
      // The app speaks English; Chromium's other 54 UI locales are 40 MB nothing reads.
      electronLanguages: ["en-US"],
      npmRebuild: false,
      nodeGypRebuild: false,
      buildDependenciesFromSource: false,
      directories: { ...buildConfig.directories, output, buildResources: join(stage, "build") },
      files: [
        "package.json",
        "!**/*.map",
        "!**/__pycache__/**",
        "!**/*.pyc",
        "!**/*.pyo",
        "!**/node_modules/**/*.{ts,mts,cts,tsx}",
        "!**/node_modules/**/{README,Readme,readme,CHANGELOG,changelog,CHANGES,HISTORY}{,.md,.markdown,.txt}",
        ...foreignBinaries,
        ...workspaceFiles.map((entry) => `!${entry.to}{,/**/*}`),
        {
          from: stage,
          to: ".",
          filter: ["dist/**", "dist-electron/**", "dist-browser-extension/**", "mako-icons/_masters/*.png", "package.json", "!**/*.map"],
        },
        ...workspaceFiles.map((entry) => ({ ...entry, from: join(stage, entry.from), filter: [...(entry.filter ?? []), "!**/*.map", "!**/*.d.ts"] })),
      ],
      extraResources: (buildConfig.extraResources ?? []).map((entry) => {
        const path = NoticeSchema.safeParse(entry)
        return path.success ? { from: join(stage, path.data), to: path.data } : entry
      }),
      win: {
        ...buildConfig.win,
        target: [{ target: args.includes("--dir") ? "dir" : "nsis", arch: [arch] }],
        icon: join(stage, "public/icons/app-icon.png"),
        executableName: buildConfig.productName,
        // A per-user install: no administrator, and none asked for at launch.
        requestedExecutionLevel: "asInvoker",
        extraFiles: helpers.map((helper) => ({ from: join(stage, helper.from), to: helper.to })),
        ...signing.win,
      },
      nsis: {
        oneClick: true,
        perMachine: false,
        allowElevation: false,
        runAfterFinish: true,
        shortcutName: buildConfig.productName,
        uninstallDisplayName: buildConfig.productName,
        deleteAppDataOnUninstall: false,
        // The login item and the `mako:` registration the app makes, removed with it (not on an update's reinstall).
        include: join(stage, "build/installer.nsh"),
        artifactName,
        differentialPackage: true,
      },
    })
  )
  await build({
    projectDir: project,
    targets: Platform.WINDOWS.createTarget(args.includes("--dir") ? ["dir"] : ["nsis"], arch === "x64" ? Arch.x64 : Arch.arm64),
    publish: "never",
    config,
  })

  const app = join(output, arch === "x64" ? "win-unpacked" : `win-${arch}-unpacked`)
  const resources = join(app, "resources")
  const archive = join(resources, "app.asar")
  assert.ok((await stat(join(app, `${pkg.build.productName}.exe`))).isFile(), `Missing ${pkg.build.productName}.exe`)
  // electron-updater reads its feed from here; without it a signed build can't update.
  const feed = await readFile(join(resources, "app-update.yml"), "utf8")
  assert.match(feed, /provider: github/, "app-update.yml must name the GitHub release feed the Mac app reads")
  // The archive's paths are looked up with the platform's separator.
  const extract = (path) => extractFile(archive, path.split("/").join(sep))
  const metadata = JSON.parse(extract("package.json").toString("utf8"))
  const sdkInArchive = listPackage(archive, { isPack: false }).map((entry) => entry.replaceAll("\\", "/"))
  assertCursorSdkPatched(
    (target) => extract(`node_modules/@cursor/sdk/${target}`).toString("utf8"),
    (sdkBuild) => sdkInArchive.filter((entry) => dirname(entry) === `/node_modules/@cursor/sdk/dist/${sdkBuild}` && entry.endsWith(".js")).map((entry) => basename(entry)),
  )
  for (const [key, value] of Object.entries(extraMetadata))
    assert.deepEqual(metadata[key], value, `Packaged metadata differs from the frozen configuration: ${key}`)
  let verified = 0
  for (const file of before) {
    if (["LICENSE", "NOTICE"].includes(file.path)) {
      assert.equal(await digest(join(resources, file.path)), file.sha256, `Packaged notice differs: ${file.path}`)
      verified++
      continue
    }
    const helper = helpers.find((entry) => entry.from === file.path)
    if (helper) {
      assert.equal(await digest(join(app, helper.to)), file.sha256, `Packaged helper differs: ${helper.to}`)
      verified++
      continue
    }
    if (
      file.path === "package.json" ||
      file.path.startsWith("build/") ||
      file.path.startsWith("public/") ||
      file.path.endsWith(".map") ||
      (file.path.startsWith("packages/") && file.path.endsWith(".d.ts")) ||
      (/^packages\/(?:control|control-runtime|host)\//.test(file.path) && file.path.endsWith("README.md"))
    )
      continue
    const target = file.path.replace(/^packages\/(sessions|lazy|git|protocol|control|control-runtime|host)\//, "node_modules/@mako/$1/")
    assert.equal(createHash("sha256").update(extract(target)).digest("hex"), file.sha256, `Packaged bytes differ from the frozen build: ${target}`)
    verified++
  }
  const report = await auditPackage(app, `win32-${arch}`, join(output, "package-size.json"))
  const imports = assertPackagedImports(app, resources)
  const installer = args.includes("--dir") ? undefined : join(output, artifactName.replace("${productName}", pkg.build.productName).replace("${arch}", arch).replace("${ext}", "exe"))
  if (installer) assert.ok((await readFile(join(output, "latest.yml"), "utf8")).includes(basename(installer)), "latest.yml must point at this installer")
  const installerBytes = installer ? (await stat(installer)).size : undefined
  await writeFile(
    join(output, "package-inputs.json"),
    JSON.stringify({ app, installer, installerBytes, appBytes: report.bytes, signing: signing.kind, imports, verified, helpers: helpers.map((helper) => helper.to) }, null, 2)
  )
  console.log(`Packaged ${verified} verified build files with ${imports} resolved host imports: ${(report.bytes / 2 ** 20).toFixed(1)} MB unpacked${installerBytes ? `, installer ${(installerBytes / 2 ** 20).toFixed(1)} MB` : ""}, ${signing.kind}`)
} finally {
  await rm(stage, { recursive: true, force: true })
}

/** How this build is signed, from the environment: all of one set, or nothing. */
function windowsSigning(env) {
  const azure = ["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "MAKO_AZURE_SIGNING_ENDPOINT", "MAKO_AZURE_SIGNING_ACCOUNT", "MAKO_AZURE_SIGNING_PROFILE"]
  const certificate = ["WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD"]
  const set = (names) => names.filter((name) => env[name])
  const publisher = env.MAKO_WINDOWS_PUBLISHER
  if (set(azure).length) {
    assert.equal(set(azure).length, azure.length, `Azure Trusted Signing needs every one of ${azure.join(", ")}`)
    assert.ok(publisher, "MAKO_WINDOWS_PUBLISHER names the signing certificate's subject; the updater checks updates against it")
    return {
      kind: "azure-trusted-signing",
      win: {
        azureSignOptions: {
          publisherName: publisher,
          endpoint: env.MAKO_AZURE_SIGNING_ENDPOINT,
          codeSigningAccountName: env.MAKO_AZURE_SIGNING_ACCOUNT,
          certificateProfileName: env.MAKO_AZURE_SIGNING_PROFILE,
        },
      },
    }
  }
  if (set(certificate).length) {
    assert.equal(set(certificate).length, certificate.length, `Certificate signing needs both ${certificate.join(" and ")}`)
    assert.ok(publisher, "MAKO_WINDOWS_PUBLISHER names the signing certificate's subject; the updater checks updates against it")
    return { kind: "certificate", win: { signtoolOptions: { publisherName: publisher, signingHashAlgorithms: ["sha256"] } } }
  }
  return { kind: "unsigned", win: {} }
}
