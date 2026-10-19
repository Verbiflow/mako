import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { headlessNodeExecutable } from "../base/headless-node.js"
import { onMac, onWindows } from "../base/platform.js"
import { chromiumProfileRoots } from "../base/chromium-profiles.js"
import type { BrowserExtensionSetup } from "../contracts/browser-extension.js"

const manifestSchema = z.object({ key: z.string().min(1) })

/** Electron can read ASAR entries, but fs.cp cannot traverse virtual directories. */
async function extensionFiles(source: string) {
  const files: { path: string; body: Buffer }[] = []
  async function collect(relative: string) {
    for (const entry of await readdir(join(source, relative), {
      withFileTypes: true,
    })) {
      const path = join(relative, entry.name)
      if (entry.isDirectory()) await collect(path)
      else if (entry.isFile())
        files.push({ path, body: await readFile(join(source, path)) })
      else throw new Error(`Unsupported browser extension resource: ${path}`)
    }
  }
  await collect("")
  // Publish the version last: the idle updater must not reload partial assets.
  files.sort(
    (left, right) =>
      Number(left.path === "manifest.json") -
      Number(right.path === "manifest.json")
  )
  return files
}

async function publishExtension(
  files: Awaited<ReturnType<typeof extensionFiles>>,
  directory: string
) {
  for (const { path, body } of files) {
    const target = join(directory, path)
    await mkdir(dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    await writeFile(temporary, body, { mode: 0o600 })
    await rename(temporary, target)
  }
}
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

/** Register the native helper only for this extension, and materialize its reviewable files. */
export async function prepareBrowserExtension(
  appPath: string,
  executable: string,
  home = homedir()
): Promise<BrowserExtensionSetup> {
  if (onWindows())
    throw new Error("Browser extension setup is not yet available on Windows")
  const source = join(appPath, "dist-browser-extension")
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(source, "manifest.json"), "utf8"))
  )
  // Read every packaged asset before changing the live helper or extension.
  const files = await extensionFiles(source)
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
    onMac()
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
  await publishExtension(files, directory)
  return { directory, extensionId }
}
