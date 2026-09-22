import { browserProfileName } from "./browser-profile-name.js"
import { closeSync, openSync, readSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
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
