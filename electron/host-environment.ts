import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

/**
 * Where the host runs and what it is, from its files and environment alone, so
 * the answer is the same under Electron, under Electron's Helper in Node mode
 * and under Node on Linux. Electron's `app.getPath`, `getAppPath`,
 * `getVersion` and `isPackaged` gave these before; the host reads them here.
 */
export interface HostEnvironment {
  /** This host's data: every store, log and lock. Electron called it `userData`. */
  readonly dataRoot: string
  /** The installed app's data root, which a profile's host is told apart from. */
  readonly defaultDataRoot: string
  /** The folder every profile's data root sits in. Electron called it `appData`. */
  readonly appData: string
  /** The app's own files: a checkout's root, or the bundle's `app.asar`. */
  readonly appRoot: string
  /**
   * The name Electron gives the app: the manifest's productName, else its
   * name. Its data folder and its `safeStorage` keychain item are named after it.
   */
  readonly appName: string
  readonly version: string
  /** Running from an installed bundle rather than a checkout. */
  readonly packaged: boolean
  /** A checkout's host, unless `MAKO_PROD` asks it to behave as installed. */
  readonly development: boolean
  /** The named profile; empty for the installed app's own data. */
  readonly profile: string
  /** What every host of this user shares, like saved keys: see {@link userRootFor}. */
  readonly userRoot: string
}

/**
 * `~/.mako` for a profile's host, whose data root sits in `appData`; the data
 * root itself for a host isolated anywhere else, so a test never reads,
 * writes or deletes the user's real state. Where the root is decides it, not
 * `MAKO_DATA_ROOT`: the launcher hands every host its root that way.
 */
export function userRootFor({ dataRoot, appData, home }: { dataRoot: string; appData: string; home: string }): string {
  const root = resolve(dataRoot)
  const applications = resolve(appData)
  return root === applications || root.startsWith(applications + sep) ? join(home, ".mako") : root
}

export interface HostEnvironmentInput {
  env: NodeJS.ProcessEnv
  appRoot: string
  platform: NodeJS.Platform
  home: string
}

const ManifestSchema = z.object({ name: z.string().min(1), productName: z.string().min(1).optional(), version: z.string().min(1) })
const ProfileSchema = z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/, "A Mako profile name is letters, digits, dots, dashes and underscores, up to 80")

/** Electron's `appData`: the per-user folder applications keep their data in. */
export function appDataFor(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string {
  if (platform === "darwin") return join(home, "Library", "Application Support")
  if (platform === "win32") return env.APPDATA ?? join(home, "AppData", "Roaming")
  return env.XDG_CONFIG_HOME ?? join(home, ".config")
}

/** A bundle keeps the app in `Contents/Resources/app.asar`, or `app` when unpacked. */
function bundled(appRoot: string): boolean {
  return basename(dirname(appRoot)) === "Resources" && /^app(\.asar)?$/.test(basename(appRoot))
}

export function resolveHostEnvironment({ env, appRoot, platform, home }: HostEnvironmentInput): HostEnvironment {
  const manifest = ManifestSchema.parse(JSON.parse(readFileSync(join(appRoot, "package.json"), "utf8")))
  const packaged = bundled(appRoot)
  const development = !packaged && !env.MAKO_PROD
  const profile = env.MAKO_PROFILE ? ProfileSchema.parse(env.MAKO_PROFILE) : development ? "dev" : ""
  const appData = appDataFor(platform, home, env)
  const appName = manifest.productName ?? manifest.name
  const defaultDataRoot = join(appData, appName)
  const dataRoot = env.MAKO_DATA_ROOT
    ? resolve(env.MAKO_DATA_ROOT)
    : profile ? `${defaultDataRoot}-${profile}` : defaultDataRoot
  const userRoot = userRootFor({ dataRoot, appData, home })
  return { dataRoot, defaultDataRoot, appData, appRoot, appName, version: manifest.version, packaged, development, profile, userRoot }
}

/** The app this module was built into: the nearest folder above it with a `package.json`, as Node looks a package up. */
export function appRootOf(moduleDirectory: string): string {
  for (let directory = resolve(moduleDirectory); ; directory = dirname(directory)) {
    if (existsSync(join(directory, "package.json"))) return directory
    if (dirname(directory) === directory) throw new Error(`No package.json above ${moduleDirectory}`)
  }
}

let resolved: HostEnvironment | undefined

/** This process's environment, resolved on first use; the host's start-up decides it once. */
export function hostEnvironment(): HostEnvironment {
  resolved ??= Object.freeze(resolveHostEnvironment({
    env: process.env,
    appRoot: appRootOf(dirname(fileURLToPath(import.meta.url))),
    platform: process.platform,
    home: homedir(),
  }))
  return resolved
}
