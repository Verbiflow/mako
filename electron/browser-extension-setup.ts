import { createHash } from "node:crypto"
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join } from "node:path"
import { z } from "zod"
import { headlessNodeExecutable } from "./headless-node.js"

export interface BrowserExtensionSetup {
  directory: string
  extensionId: string
}

const manifestSchema = z.object({ key: z.string().min(1) })
const chromiumLocalStateSchema = z
  .object({
    browser: z
      .object({
        first_run_finished: z.literal(true),
      })
      .loose(),
    profile: z
      .object({
        info_cache: z.record(z.string(), z.json()),
      })
      .loose(),
  })
  .loose()
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function chromiumProductName(profile: string): string {
  return basename(profile)
    .split(/[-_. ]+/)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ")
    .slice(0, 80)
}

async function childDirectories(
  directory: string,
  limit: number
): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(directory, entry.name))
      .sort()
      .slice(0, limit)
  } catch {
    return []
  }
}

async function isChromiumProfileRoot(directory: string): Promise<boolean> {
  try {
    const path = join(directory, "Local State")
    const metadata = await lstat(path)
    if (!metadata.isFile() || metadata.size > 8 * 1024 * 1024) return false
    const state = chromiumLocalStateSchema.parse(
      JSON.parse(await readFile(path, "utf8"))
    )
    return Object.keys(state.profile.info_cache).length > 0
  } catch {
    return false
  }
}

/**
 * Chromium products keep `Local State` at their user-data root. Discovering
 * that capability supports branded forks without a product-name allowlist.
 */
export async function chromiumProfileRoots(base: string): Promise<string[]> {
  const firstLevel = await childDirectories(base, 512)
  const nested = await Promise.all(
    firstLevel.map(async (directory) => ({
      directory,
      children: await childDirectories(directory, 32),
    }))
  )
  const candidates = [
    ...firstLevel,
    ...nested.flatMap(({ children }) => children).slice(0, 2048),
  ]
  const checks = await Promise.all(
    candidates.map(async (directory) => ({
      directory,
      matches: await isChromiumProfileRoot(directory),
    }))
  )
  return checks
    .filter(({ matches }) => matches)
    .map(({ directory }) => directory)
    .sort()
}

/** Register the native helper only for this extension, and materialize its reviewable files. */
export async function prepareBrowserExtension(
  appPath: string,
  executable: string,
  home = homedir()
): Promise<BrowserExtensionSetup> {
  if (process.platform === "win32")
    throw new Error("Browser extension setup is not yet available on Windows")
  const source = join(appPath, "dist-browser-extension")
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(source, "manifest.json"), "utf8"))
  )
  const extensionId = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (value) =>
      String.fromCharCode(97 + parseInt(value, 16))
    )
  const directory = join(home, ".mako", "browser-extension-package")
  const bin = join(home, ".mako", "bin")
  await mkdir(bin, { recursive: true, mode: 0o700 })
  await cp(source, directory, { recursive: true })
  const helper = join(bin, "mako-browser-host")
  const temporary = `${helper}.${process.pid}.tmp`
  const nodeExecutable = headlessNodeExecutable(executable)
  await writeFile(
    temporary,
    `#!/bin/sh\nexec /usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quote(nodeExecutable)} ${quote(join(appPath, "dist-electron", "browser-native-host-entry.js"))} "$@"\n`,
    { mode: 0o700 }
  )
  await chmod(temporary, 0o700)
  await rename(temporary, helper)
  const base =
    process.platform === "darwin"
      ? join(home, "Library", "Application Support")
      : join(home, ".config")
  const profiles = await chromiumProfileRoots(base)
  for (const profile of profiles) {
    const product = chromiumProductName(profile)
    const profileKey = createHash("sha256")
      .update(profile)
      .digest("hex")
      .slice(0, 16)
    const profileHelper = join(bin, `mako-browser-host-${profileKey}`)
    const profileTemporary = `${profileHelper}.${process.pid}.tmp`
    await writeFile(
      profileTemporary,
      `#!/bin/sh\nexport MAKO_BROWSER_PRODUCT=${quote(product)}\nexport MAKO_BROWSER_ROOT=${quote(profile)}\nexec ${quote(helper)} "$@"\n`,
      { mode: 0o700 }
    )
    await chmod(profileTemporary, 0o700)
    await rename(profileTemporary, profileHelper)
    const hosts = join(profile, "NativeMessagingHosts")
    await mkdir(hosts, { recursive: true })
    const manifest = join(hosts, "dev.mako.browser.json")
    const manifestTemporary = `${manifest}.${process.pid}.tmp`
    await writeFile(
      manifestTemporary,
      JSON.stringify(
        {
          name: "dev.mako.browser",
          description: "Mako Browser",
          path: profileHelper,
          type: "stdio",
          allowed_origins: [`chrome-extension://${extensionId}/`],
        },
        null,
        2
      ),
      { mode: 0o600 }
    )
    await rename(manifestTemporary, manifest)
  }
  return { directory, extensionId }
}
