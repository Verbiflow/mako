import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { access, readdir, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { LocalBrowser } from "./browser-discovery.js"

const execute = promisify(execFile)
const applicationInfo = z.object({
  CFBundleDisplayName: z.string().optional(),
  CFBundleName: z.string().optional(),
  ElectronAsarIntegrity: z.unknown().optional(),
  CFBundleURLTypes: z
    .array(
      z.object({
        CFBundleURLSchemes: z.array(z.string()).optional(),
      })
    )
    .optional(),
})

async function directories(root: string): Promise<string[]> {
  return readdir(root, { withFileTypes: true })
    .then((entries) =>
      entries
        .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
        .slice(0, 512)
        .map((entry) => join(root, entry.name))
    )
    .catch(() => [])
}

/** A web URL handler with Chromium's browser resources, not an Electron app. */
export async function installedChromiumApplication(
  path: string
): Promise<LocalBrowser | undefined> {
  try {
    const applicationPath = await realpath(path)
    const plist = join(applicationPath, "Contents", "Info.plist")
    if ((await stat(plist)).size > 256 * 1024) return undefined
    const { stdout } = await execute(
      "/usr/bin/plutil",
      ["-convert", "json", "-o", "-", plist],
      {
        timeout: 1500,
        maxBuffer: 256 * 1024,
      }
    )
    const info = applicationInfo.parse(JSON.parse(stdout))
    if (info.ElectronAsarIntegrity) return undefined
    if (
      await access(
        join(applicationPath, "Contents", "Resources", "app.asar")
      ).then(
        () => true,
        () => false
      )
    )
      return undefined
    if (
      !info.CFBundleURLTypes?.some((type) =>
        type.CFBundleURLSchemes?.includes("https")
      )
    )
      return undefined
    const frameworks = await directories(
      join(applicationPath, "Contents", "Frameworks")
    )
    if (
      frameworks.some(
        (path) => basename(path) === "Electron Framework.framework"
      )
    )
      return undefined
    const chromium = await Promise.all(
      frameworks
        .filter((path) => path.endsWith(".framework"))
        .map(async (path) => {
          const resources = join(path, "Versions", "Current", "Resources")
          return Promise.all([
            access(join(resources, "chrome_100_percent.pak")),
            access(join(resources, "icudtl.dat")),
          ]).then(
            () => true,
            () => false
          )
        })
    )
    if (!chromium.some(Boolean)) return undefined
    const product = (
      info.CFBundleDisplayName ??
      info.CFBundleName ??
      basename(path, ".app")
    ).slice(0, 80)
    return {
      id: `chromium:installed:${createHash("sha256").update(applicationPath).digest("hex").slice(0, 24)}`,
      name: product,
      product,
      applicationPath,
      kind: "chromium",
      transport: "extension",
      setupRequired: true,
      endpoint: async () => {
        throw new Error(
          `Open ${product} and add the Mako Browser extension to use it.`
        )
      },
    }
  } catch {
    return undefined
  }
}

export async function discoverInstalledChromium(
  roots = ["/Applications", join(homedir(), "Applications")],
  extraPaths: string[] = []
): Promise<LocalBrowser[]> {
  const first = (await Promise.all(roots.map(directories))).flat()
  const nested = (
    await Promise.all(
      first.filter((path) => !path.endsWith(".app")).map(directories)
    )
  ).flat()
  const paths = [
    ...new Set(
      [...first, ...nested, ...extraPaths].filter((path) =>
        path.endsWith(".app")
      )
    ),
  ]
  // Bound process concurrency; Settings must not launch hundreds of plist readers.
  const found: LocalBrowser[] = []
  for (let offset = 0; offset < paths.length; offset += 8) {
    const batch = await Promise.all(
      paths.slice(offset, offset + 8).map(installedChromiumApplication)
    )
    for (const item of batch)
      if (item && !found.some((b) => b.id === item.id)) found.push(item)
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

let cached:
  | { key: string; expires: number; browsers: Promise<LocalBrowser[]> }
  | undefined
export function installedChromiumBrowsers(
  extraPaths: string[] = []
): Promise<LocalBrowser[]> {
  if (process.platform !== "darwin") return Promise.resolve([])
  const key = extraPaths.join("\n")
  if (!cached || cached.key !== key || cached.expires <= Date.now()) {
    cached = {
      key,
      expires: Date.now() + 10_000,
      browsers: discoverInstalledChromium(undefined, extraPaths),
    }
  }
  return cached.browsers
}

export function mergeInstalledBrowsers(
  installed: LocalBrowser[],
  connected: LocalBrowser[]
): LocalBrowser[] {
  return [
    ...connected,
    ...installed.filter(
      (app) =>
        !connected.some(
          (browser) =>
            browser.transport === "extension" &&
            browser.applicationPath === app.applicationPath
        )
    ),
  ]
}
