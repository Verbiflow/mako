import { createHash } from "node:crypto"
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, win32 } from "node:path"
import {
  WINDOWS_CHROMIUM,
  windowsInstalledChromium,
  windowsRegistryTool,
  type WindowsInstalledChromium,
} from "@mako/control-runtime/desktop"
import { hostCommand } from "../base/host-command.js"

/**
 * The browser extension's native host on Windows. Chromium reads a native host's manifest from the registry, not
 * from a profile folder: `HKCU\Software\<vendor>\NativeMessagingHosts\dev.mako.browser` names it, each brand under its
 * own vendor key (`WINDOWS_CHROMIUM`). The manifest names a launcher, which the browser always starts through
 * `cmd.exe /d /s /c` with its pipes as stdin and stdout and no window. A `.cmd` therefore costs no extra process: cmd
 * runs it in place and starts Mako's own executable as Node (`ELECTRON_RUN_AS_NODE`), a GUI-subsystem program, so no
 * console window opens. Each brand gets its own launcher naming the browser, its executable and its user data, as a
 * Mac's profile helper does.
 */

const HOST = "dev.mako.browser"
const hostKey = (vendor: string) => `HKCU\\Software\\${vendor}\\NativeMessagingHosts\\${HOST}`

/** A value inside a `.cmd`'s `set "NAME=value"` or a quoted path: cmd expands `%`, so each is doubled. */
function batchValue(value: string): string {
  if (/["\r\n]/.test(value)) throw new Error(`A browser launcher can't name ${JSON.stringify(value)}`)
  return value.replaceAll("%", "%%")
}

/**
 * A launcher's text. cmd reads a batch file in the console's code page, so one naming a path outside ASCII (a user
 * folder with an accented name) switches the code page to UTF-8 first; its output goes nowhere, since stdout is the
 * browser's pipe. Nothing else may write to stdout: `@echo off` keeps cmd from echoing commands into the pipe.
 */
export function windowsLauncher(options: {
  node: string
  entry: string
  product: string
  userData?: string
  application: string
}): string {
  const lines = [
    "@echo off",
    "setlocal DisableDelayedExpansion",
    `set "ELECTRON_RUN_AS_NODE=1"`,
    `set "MAKO_BROWSER_PRODUCT=${batchValue(options.product)}"`,
    `set "MAKO_BROWSER_APPLICATION=${batchValue(options.application)}"`,
    ...(options.userData ? [`set "MAKO_BROWSER_ROOT=${batchValue(options.userData)}"`] : []),
    `"${batchValue(options.node)}" "${batchValue(options.entry)}" %*`,
  ]
  if (lines.some((line) => Buffer.byteLength(line) !== line.length)) lines.splice(1, 0, "chcp 65001 >nul")
  return `${lines.join("\r\n")}\r\n`
}

async function replace(path: string, body: string) {
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, body, { mode: 0o600 })
  await rename(temporary, path)
}

const reg = (args: string[]) => hostCommand(windowsRegistryTool(), args, { timeout: 5000, windowsHide: true })

/** The manifest path a vendor's key names now, if any. */
async function registered(vendor: string): Promise<string | undefined> {
  try {
    const { stdout } = await reg(["query", hostKey(vendor), "/ve"])
    return /REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m.exec(stdout)?.[1]
  } catch {
    return undefined
  }
}

/**
 * Writes a launcher and manifest for each installed browser and points its vendor key at them. `bin` holds both, so
 * removal (`removeWindowsNativeHosts`) finds what is Mako's by where it is.
 */
export async function registerWindowsNativeHosts(options: {
  bin: string
  node: string
  entry: string
  extensionId: string
  installed?: WindowsInstalledChromium[]
}): Promise<WindowsInstalledChromium[]> {
  const { bin, node, entry, extensionId } = options
  const installed = options.installed ?? (await windowsInstalledChromium())
  // One launcher per vendor key: two installs of one brand (machine-wide and the person's) share its key, so the one
  // with user data speaks for it.
  const byVendor = new Map<string, WindowsInstalledChromium>()
  for (const browser of installed) {
    const kept = byVendor.get(browser.browser.vendor)
    if (!kept || (!kept.userData && browser.userData)) byVendor.set(browser.browser.vendor, browser)
  }
  await mkdir(bin, { recursive: true, mode: 0o700 })
  for (const [vendor, browser] of byVendor) {
    const key = createHash("sha256").update(vendor).digest("hex").slice(0, 16)
    const launcher = join(bin, `mako-browser-host-${key}.cmd`)
    await replace(
      launcher,
      windowsLauncher({ node, entry, product: browser.browser.product, userData: browser.userData, application: browser.executable })
    )
    const manifest = join(bin, `${HOST}-${key}.json`)
    await replace(
      manifest,
      JSON.stringify(
        { name: HOST, description: "Mako Browser", path: launcher, type: "stdio", allowed_origins: [`chrome-extension://${extensionId}/`] },
        null,
        2
      )
    )
    await reg(["add", hostKey(vendor), "/ve", "/t", "REG_SZ", "/d", manifest, "/f"])
  }
  return [...byVendor.values()]
}

/**
 * Removes every vendor key that names a manifest in `bin`, then the launchers and manifests there. A key another
 * install of Mako wrote (another home's `bin`) is left alone.
 */
export async function removeWindowsNativeHosts(bin: string): Promise<string[]> {
  const removed: string[] = []
  const inside = (path: string) => win32.resolve(path).toLowerCase().startsWith(`${win32.resolve(bin).toLowerCase()}\\`)
  for (const { vendor } of WINDOWS_CHROMIUM) {
    const manifest = await registered(vendor)
    if (!manifest || !inside(manifest)) continue
    await reg(["delete", hostKey(vendor), "/f"])
    removed.push(hostKey(vendor))
  }
  for (const name of await readdir(bin).catch(() => []))
    if (/^mako-browser-host-[a-f0-9]{16}\.cmd$/.test(name) || /^dev\.mako\.browser-[a-f0-9]{16}\.json$/.test(name))
      await rm(join(bin, name), { force: true })
  return removed
}
