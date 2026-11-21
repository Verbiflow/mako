import { command } from "./processes.js"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { lstat, readdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, join, win32 } from "node:path"
import type { LocalBrowser } from "./browser-discovery.js"
import { browserProfiles } from "./browser-profile-name.js"

/**
 * A Chromium browser as Windows installs it. Each has an executable a machine-wide installer puts under Program Files
 * and a per-user one under `%LOCALAPPDATA%` (Chrome, Brave, Chromium and Vivaldi offer both), registers it under the
 * registry's App Paths by its file name, keeps its profiles under one user-data folder in `%LOCALAPPDATA%`, and reads
 * native messaging hosts from `HKCU\Software\<vendor>\NativeMessagingHosts`, its brand's own key.
 */
export interface WindowsChromium {
  product: string
  /** The executable's file name, as App Paths names it. */
  executable: string
  /** Its install folders, under Program Files, Program Files (x86) or `%LOCALAPPDATA%`. */
  folders: readonly string[]
  /** Its user-data folder under `%LOCALAPPDATA%`, whose `Local State` names its profiles. */
  userData: string
  /** The registry key, under `HKCU\Software`, whose `NativeMessagingHosts` it reads. */
  vendor: string
}

export const WINDOWS_CHROMIUM: readonly WindowsChromium[] = [
  { product: "Google Chrome", executable: "chrome.exe", folders: ["Google\\Chrome\\Application"], userData: "Google\\Chrome\\User Data", vendor: "Google\\Chrome" },
  { product: "Microsoft Edge", executable: "msedge.exe", folders: ["Microsoft\\Edge\\Application"], userData: "Microsoft\\Edge\\User Data", vendor: "Microsoft\\Edge" },
  { product: "Brave Browser", executable: "brave.exe", folders: ["BraveSoftware\\Brave-Browser\\Application"], userData: "BraveSoftware\\Brave-Browser\\User Data", vendor: "BraveSoftware\\Brave-Browser" },
  // Arc ships as an MSIX package: its executable is reachable through its App Paths entry or its execution alias, and
  // its user data is under the package's own folder (`windowsUserData`).
  { product: "Arc", executable: "Arc.exe", folders: ["Microsoft\\WindowsApps"], userData: "Arc\\User Data", vendor: "TheBrowserCompany\\Arc" },
  { product: "Chromium", executable: "chrome.exe", folders: ["Chromium\\Application"], userData: "Chromium\\User Data", vendor: "Chromium" },
  { product: "Vivaldi", executable: "vivaldi.exe", folders: ["Vivaldi\\Application"], userData: "Vivaldi\\User Data", vendor: "Vivaldi" },
]

/** One installed browser: where it runs from, its version, and its user data with the profiles it holds. */
export interface WindowsInstalledChromium {
  browser: WindowsChromium
  /** The executable, as the file system names it (`realpath`). */
  executable: string
  /** The newest version folder beside it, as Chromium's installers lay them out; none for Arc's package. */
  version?: string
  /** Its user-data folder, when it has one. */
  userData?: string
  /** Its profiles' folders and names, from `Local State`. */
  profiles: { directory: string; name?: string }[]
}

/** The environment's variables Windows names in any case (`LocalAppData`, `ProgramFiles`). */
function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (env[name] !== undefined) return env[name] || undefined
  const key = Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase())
  return (key && env[key]) || undefined
}

const APP_PATHS = "SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths"

/** `reg.exe` from the system folder, never one first on PATH. */
export function windowsRegistryTool(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(variable(env, "SystemRoot") ?? "C:\\Windows", "System32", "reg.exe")
}

/**
 * Every App Paths entry's executable, from the machine's 64- and 32-bit views and the person's own: `reg query /s /ve`
 * prints each key with its default value, which names the executable (quoted, or with variables, as some installers
 * write it). Three short reads instead of one per browser and view.
 */
export async function windowsAppPaths(env: NodeJS.ProcessEnv = process.env): Promise<Map<string, string[]>> {
  const keys = [`HKLM\\${APP_PATHS}`, `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\App Paths`, `HKCU\\${APP_PATHS}`]
  const outputs = await Promise.all(
    keys.map((key) =>
      command(windowsRegistryTool(env), ["query", key, "/s", "/ve"], { timeout: 3000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }).then(
        ({ stdout }) => stdout,
        // A view the machine doesn't have exits 1; its entries are simply none.
        () => ""
      )
    )
  )
  return parseAppPaths(outputs.join("\n"), env)
}

/** `reg query /s /ve`'s output as each executable name's paths, lowercased names, variables expanded. */
export function parseAppPaths(output: string, env: NodeJS.ProcessEnv = process.env): Map<string, string[]> {
  const found = new Map<string, string[]>()
  let name: string | undefined
  for (const line of output.split(/\r?\n/)) {
    if (/^HKEY_/i.test(line)) {
      name = line.slice(line.lastIndexOf("\\") + 1).toLowerCase()
      continue
    }
    const value = /^\s+.*?\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line)?.[1]
    if (!name || !value) continue
    const path = expand(value.replace(/^"([^"]*)".*$/, "$1"), env)
    if (!win32.isAbsolute(path)) continue
    found.set(name, [...(found.get(name) ?? []), path])
    name = undefined
  }
  return found
}

function expand(value: string, env: NodeJS.ProcessEnv): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => variable(env, name) ?? whole)
}

/** The browser an executable path belongs to: by its install folder, else its file name (chrome.exe is Chrome's). */
export function windowsBrowserFor(path: string): WindowsChromium | undefined {
  const lower = path.toLowerCase()
  const file = win32.basename(lower)
  const byFolder = WINDOWS_CHROMIUM.find((browser) =>
    file === browser.executable.toLowerCase() && browser.folders.some((folder) => lower.endsWith(`\\${folder.toLowerCase()}\\${file}`))
  )
  if (byFolder) return byFolder
  if (/[\\/]thebrowsercompany\.arc_/i.test(lower) && file === "arc.exe") return WINDOWS_CHROMIUM.find((browser) => browser.product === "Arc")
  if (file === "chrome.exe" && /chromium/i.test(lower)) return WINDOWS_CHROMIUM.find((browser) => browser.product === "Chromium")
  return WINDOWS_CHROMIUM.find((browser) => browser.executable.toLowerCase() === file)
}

/** A browser's user-data folder: under `%LOCALAPPDATA%`, or for Arc's package, under its package folder there. */
export async function windowsUserData(browser: WindowsChromium, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const local = variable(env, "LOCALAPPDATA")
  if (!local) return undefined
  const candidates = [join(local, browser.userData)]
  if (browser.product === "Arc") {
    const packages = await readdir(join(local, "Packages")).catch(() => [])
    for (const name of packages.filter((name) => /^TheBrowserCompany\.Arc_/i.test(name)))
      candidates.push(join(local, "Packages", name, "LocalCache", "Local", browser.userData))
  }
  for (const candidate of candidates)
    if (await stat(join(candidate, "Local State")).then((info) => info.isFile(), () => false)) return candidate
  return undefined
}

async function newestVersion(folder: string): Promise<string | undefined> {
  const names = await readdir(folder).catch(() => [])
  const versions = names.filter((name) => /^\d+(\.\d+){3}$/.test(name))
  const parts = (version: string) => version.split(".").map(Number)
  return versions.sort((a, b) => {
    const [left, right] = [parts(a), parts(b)]
    for (let at = 0; at < 4; at++) if (left[at] !== right[at]) return left[at]! - right[at]!
    return 0
  }).at(-1)
}

/**
 * The Chromium browsers installed on this Windows machine: each App Paths entry for a browser's executable, and each
 * browser's standard install folders, machine-wide and the person's own, read for their version and their profiles.
 * `extraPaths` adds executables found elsewhere, such as the default browser's.
 */
export async function windowsInstalledChromium(
  env: NodeJS.ProcessEnv = process.env,
  extraPaths: readonly string[] = []
): Promise<WindowsInstalledChromium[]> {
  const roots = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "LOCALAPPDATA"].map((name) => variable(env, name)).filter((root): root is string => Boolean(root))
  const appPaths = await windowsAppPaths(env)
  const candidates = [
    ...WINDOWS_CHROMIUM.flatMap((browser) => [
      ...(appPaths.get(browser.executable.toLowerCase()) ?? []),
      ...roots.flatMap((root) => browser.folders.map((folder) => join(root, folder, browser.executable))),
    ]),
    ...extraPaths.filter((path) => /\.exe$/i.test(path)),
  ]
  const found = new Map<string, WindowsInstalledChromium>()
  for (const candidate of candidates) {
    // An MSIX app's execution alias (Arc's) is a reparse point that neither resolves nor stats as a file; it runs.
    const executable = await realpath(candidate).then(
      async (path) => ((await stat(path)).isFile() ? path : undefined),
      () => lstat(candidate).then(() => candidate, () => undefined)
    ).catch(() => undefined)
    if (!executable || found.has(executable.toLowerCase())) continue
    const browser = windowsBrowserFor(executable)
    if (!browser) continue
    const userData = await windowsUserData(browser, env)
    found.set(executable.toLowerCase(), {
      browser,
      executable,
      version: await newestVersion(dirname(executable)),
      userData,
      profiles: userData ? await browserProfiles(userData) : [],
    })
  }
  return [...found.values()]
}

/** Each installed browser as a browser to set up: the person adds the extension, which then connects it. */
export function windowsLocalBrowsers(installed: readonly WindowsInstalledChromium[]): LocalBrowser[] {
  return installed
    .map(({ browser, executable }): LocalBrowser => ({
      id: `chromium:installed:${createHash("sha256").update(executable.toLowerCase()).digest("hex").slice(0, 24)}`,
      name: browser.product,
      product: browser.product,
      applicationPath: executable,
      kind: "chromium",
      transport: "extension",
      setupRequired: true,
      endpoint: async () => {
        throw new Error(`Open ${browser.product} and add the Mako Browser extension to use it.`)
      },
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || basename(a.applicationPath!).localeCompare(basename(b.applicationPath!)))
}

/**
 * The browser a Windows machine runs as its own (`MachineBrowser`), in Mako's profile: Chrome, else Edge, which every
 * Windows 10 and 11 has, else Chromium or Brave, from their standard install folders.
 */
export function windowsMachineChromium(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const roots = ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"].map((name) => variable(env, name)).filter((root): root is string => Boolean(root))
  const order = ["Google Chrome", "Microsoft Edge", "Chromium", "Brave Browser"]
  const browsers = WINDOWS_CHROMIUM.filter(({ product }) => order.includes(product)).sort((a, b) => order.indexOf(a.product) - order.indexOf(b.product))
  return browsers
    .flatMap((browser) => roots.flatMap((root) => browser.folders.map((folder) => join(root, folder, browser.executable))))
    .find((path) => existsSync(path))
}
