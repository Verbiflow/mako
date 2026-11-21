import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { createRequire } from "node:module"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { z } from "zod"
import { hostCommand } from "../../../base/host-command.js"
import { resolveExecutable } from "../../../base/executable.js"
import { nodePlatform } from "../../../base/platform.js"
import { publishFile } from "../../../base/published-files.js"
import { CURSOR_SDK_PINS } from "./pins.js"

/**
 * Cursor's sessions run on `@cursor/sdk`, in a child of the host's (`child.ts`). The host carries the SDK with its own
 * install, patched as it's installed (`scripts/patch-cursor-sdk.mjs`); a host made without Cursor among its harnesses
 * carries none, and Settings' install of Cursor puts the same build, patched the same way, in a folder of Mako's
 * beside the CLI its installer brings. The child finds that copy through `installed-sdk.ts`.
 *
 * What lands there is code the host's child runs, so it is only ever the bytes this Mako pins (`pins.ts`): the two
 * tarballs npm serves, each refused unless it hashes to what Mako's lockfile records, unpacked with no script of
 * theirs run and no dependency fetched (the SDK's own come from the host's install, as they do when the host carries
 * it); then Mako's patches, each rewritten file refused unless it hashes to what the same patch makes of the same
 * bytes in Mako's build. The folder is usable only once marked, and the mark is written last.
 */

/** Where Mako installs the SDK when the host has none. */
export function cursorSdkInstallRoot(): string {
  return join(homedir(), ".local", "share", "mako", "cursor-sdk")
}

/** The SDK's packages a machine runs: the SDK and its platform's build. */
function sdkPackages(): string[] {
  return ["@cursor/sdk", `@cursor/sdk-${nodePlatform()}-${process.arch}`]
}

const PackageVersion = z.object({ name: z.string(), version: z.string() }).loose()
const PATCHED_MARK = ".mako-patched"
/** What the mark holds: the pins the copy was checked against, so a Mako that pins another build installs its own. */
const pinsMark = () => createHash("sha256").update(JSON.stringify(CURSOR_SDK_PINS)).digest("hex")

/** The host's own `@cursor/sdk`, when its install has one. */
function carriedSdk(): boolean {
  try {
    createRequire(import.meta.url).resolve("@cursor/sdk")
    return true
  } catch {
    return false
  }
}

/** Whether `root` holds the copy `installCursorSdkAt` put in place: the pinned version, marked as checked against these pins. */
export function cursorSdkInstalledAt(root: string): boolean {
  try {
    const manifest = PackageVersion.parse(JSON.parse(readFileSync(join(root, "node_modules", "@cursor", "sdk", "package.json"), "utf8")))
    if (manifest.name !== "@cursor/sdk" || manifest.version !== CURSOR_SDK_PINS.version) return false
    return readFileSync(join(root, PATCHED_MARK), "utf8").trim() === pinsMark()
  } catch {
    return false
  }
}

/**
 * Where the child loads the SDK from when the host carries none: the root of the copy Settings installed. Undefined
 * when the host carries its own, which the child resolves as any module, or when there is none at all.
 */
export function installedCursorSdkRoot(): string | undefined {
  return carriedSdk() || !cursorSdkInstalledAt(cursorSdkInstallRoot()) ? undefined : cursorSdkInstallRoot()
}

/** Whether a Cursor session can run here: the host carries the SDK, or Settings installed it. */
export function cursorSdkAvailable(): boolean {
  return carriedSdk() || cursorSdkInstalledAt(cursorSdkInstallRoot())
}

/** A tarball or a patched file that isn't the one Mako pins: nothing of it is used. */
export class CursorSdkMismatch extends Error {}

export interface CursorSdkInstall {
  /** Where the copy goes (`cursorSdkInstallRoot`). */
  readonly root: string
  /** The app's files, whose `scripts/patch-cursor-sdk.mjs` patches the copy. */
  readonly appRoot: string
  readonly env: NodeJS.ProcessEnv
  /** Brings `name`'s pinned version's tarball into `folder` and answers its path; npm's own fetch unless a test gives another. */
  readonly fetch?: (name: string, version: string, folder: string) => Promise<string>
}

const PackedTarball = z.array(z.object({ filename: z.string() }).loose()).min(1)

/**
 * The tarball as the person's npm serves it, registry and sign-in theirs: `npm pack` downloads and runs nothing of
 * the package's. Whatever registry answered, the bytes are checked against Mako's pin before anything reads them.
 */
async function npmTarball(name: string, version: string, folder: string, env: NodeJS.ProcessEnv): Promise<string> {
  const npm = resolveExecutable("npm", env)
  if (!npm) throw new Error("Mako installs Cursor's SDK with npm, which isn't installed")
  const { stdout } = await hostCommand(npm, ["pack", `${name}@${version}`, "--pack-destination", folder, "--ignore-scripts", "--json"], { env, cwd: folder, timeout: 10 * 60_000, maxBuffer: 8 * 1024 * 1024 })
  const [packed] = PackedTarball.parse(JSON.parse(stdout))
  if (!packed) throw new Error(`npm packed no ${name}`)
  return join(folder, packed.filename)
}

/** `name`'s tarball, unpacked into `root`'s `node_modules` only if it hashes to Mako's pin. */
async function unpackPinned(name: string, install: CursorSdkInstall, downloads: string): Promise<void> {
  const pin = Object.entries(CURSOR_SDK_PINS.tarballs).find(([pinned]) => pinned === name)?.[1]
  if (!pin) throw new Error(`This Mako pins no ${name}: Cursor's SDK has no build for this machine`)
  const tarball = await (install.fetch ?? ((packageName, version, folder) => npmTarball(packageName, version, folder, install.env)))(name, CURSOR_SDK_PINS.version, downloads)
  const found = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`
  if (found !== pin)
    throw new CursorSdkMismatch(`${name} ${CURSOR_SDK_PINS.version} as npm served it isn't the build this Mako pins (its hash is ${found.slice(0, 22)}…, not ${pin.slice(0, 22)}…). Mako didn't install it.`)
  const folder = join(install.root, "node_modules", ...name.split("/"))
  mkdirSync(folder, { recursive: true })
  // An npm tarball holds one folder, `package/`.
  await hostCommand("tar", ["-xzf", tarball, "-C", folder, "--strip-components=1"], { env: install.env, timeout: 5 * 60_000 })
}

/**
 * Puts the SDK in place where the host carries none, or throws with nothing usable left: the pinned tarballs, then
 * Mako's patches by the script the app carries, then each patched file against its pin, then the mark.
 */
export async function installCursorSdkAt(install: CursorSdkInstall): Promise<void> {
  const script = join(install.appRoot, "scripts", "patch-cursor-sdk.mjs")
  if (!existsSync(script)) throw new Error(`Mako can't install Cursor's SDK here: its patches (${script}) aren't with this app`)
  // The script runs only as the program Node was given, which it tells by its own real path.
  const patch = realpathSync(script)
  // Whatever an earlier try left is not built on: the mark first, so nothing half-made is usable.
  rmSync(join(install.root, PATCHED_MARK), { force: true })
  rmSync(join(install.root, "node_modules"), { recursive: true, force: true })
  mkdirSync(install.root, { recursive: true })
  const downloads = mkdtempSync(join(install.root, "download-"))
  try {
    for (const name of sdkPackages()) await unpackPinned(name, install, downloads)
    const folder = join(install.root, "node_modules", "@cursor", "sdk")
    for (const mode of [[], ["--check"]])
      await hostCommand(process.execPath, [patch, ...mode, `--root=${folder}`], { env: { ...install.env, ELECTRON_RUN_AS_NODE: "1" }, cwd: dirname(patch), timeout: 5 * 60_000, maxBuffer: 8 * 1024 * 1024 })
    for (const [file, pin] of Object.entries(CURSOR_SDK_PINS.patched)) {
      const found = createHash("sha256").update(readFileSync(join(folder, file))).digest("hex")
      if (found !== pin) throw new CursorSdkMismatch(`Cursor's SDK as patched here isn't the build this Mako pins: ${file} hashes to ${found.slice(0, 16)}…, not ${pin.slice(0, 16)}…. Mako didn't install it.`)
    }
    await publishFile(join(install.root, PATCHED_MARK), `${pinsMark()}\n`)
  } catch (error) {
    rmSync(join(install.root, "node_modules"), { recursive: true, force: true })
    throw error
  } finally {
    rmSync(downloads, { recursive: true, force: true })
  }
}

/** Settings' install of Cursor, once its CLI is in place: the SDK too, where the host has none and no checked copy is there. */
export async function installCursorSdk(appRoot: string, env: NodeJS.ProcessEnv): Promise<void> {
  if (cursorSdkAvailable()) return
  await installCursorSdkAt({ root: cursorSdkInstallRoot(), appRoot, env })
}
