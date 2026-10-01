import { browserProfileName } from "./browser-profile-name.js"
import { closeSync, openSync, readSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { ExtensionRegistrationSchema } from "./browser-extension-protocol.js"
import type { LocalBrowser } from "./browser-discovery.js"

export function browserExtensionRoot(): string {
  return join(homedir(), ".mako", "browser-extension")
}

function readRegistration(path: string) {
  const file = openSync(path, "r")
  try {
    const bytes = Buffer.alloc(4097)
    const count = readSync(file, bytes)
    if (count > 4096)
      throw new Error("Browser registration exceeds its size limit")
    const registration = ExtensionRegistrationSchema.parse(
      JSON.parse(bytes.subarray(0, count).toString("utf8"))
    )
    const url = new URL(registration.endpoint)
    if (
      url.protocol !== "ws:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      !/^\/mako-browser\/[A-Za-z0-9_-]{43}$/.test(url.pathname)
    )
      throw new Error("Invalid browser registration")
    process.kill(registration.pid, 0)
    return registration
  } finally {
    closeSync(file)
  }
}

// Linux reports the resolved executable, such as /opt/brave.com/brave/brave or
// Snap's .../chromium-browser/chrome, so the whole path decides. First match wins.
const LINUX_PRODUCTS = [
  [/brave/i, "Brave Browser"],
  [/msedge|microsoft-edge/i, "Microsoft Edge"],
  [/vivaldi/i, "Vivaldi"],
  [/opera/i, "Opera"],
  [/chromium/i, "Chromium"],
  [/google[-/]chrome/i, "Google Chrome"],
] as const

/**
 * The browser that launched the native host, named as installed discovery
 * names it. Brave reports Chrome's user agent and can launch Chrome's host
 * manifest, so neither the extension's guess nor the helper's is reliable.
 */
export function applicationProduct(
  applicationPath: string | undefined
): string | undefined {
  if (!applicationPath) return undefined
  if (applicationPath.endsWith(".app"))
    return basename(applicationPath, ".app").slice(0, 80) || undefined
  return LINUX_PRODUCTS.find(([pattern]) => pattern.test(applicationPath))?.[1]
}

export async function extensionBrowsers(
  root = browserExtensionRoot()
): Promise<LocalBrowser[]> {
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const browsers: LocalBrowser[] = []
  for (const name of names
    .filter((name) => /^chromium-[a-f0-9-]{36}\.json$/.test(name))
    .sort()
    .slice(0, 64)) {
    const path = join(root, name)
    try {
      const registration = readRegistration(path)
      const product =
        applicationProduct(registration.applicationPath) ??
        registration.product ??
        /^(.*?) profile [a-f0-9]{6}$/.exec(registration.name)?.[1]
      const profileName = registration.profileDirectory
        ? await browserProfileName(registration.profileDirectory)
        : registration.profileName
      browsers.push({
        id: registration.id,
        applicationPath: registration.applicationPath,
        name: (profileName && product
          ? `${product} · ${profileName}`
          : (product ?? registration.name)
        ).slice(0, 100),
        product,
        profileName,
        transport: "extension",
        requiresApproval: false,
        kind: "chromium",
        endpoint: async () => readRegistration(path).endpoint,
      })
    } catch {
      // A closed browser or malformed registration cannot trigger another transport.
    }
  }
  return browsers
}
