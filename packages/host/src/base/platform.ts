import { readFileSync } from "node:fs"
import { release } from "node:os"
import type { ProcessPlatform } from "../contracts/platform.js"

/**
 * The one place the host asks which operating system it runs on. Domains
 * are given capabilities (`machine.ts`, `keychain.ts`) instead of branching
 * on the platform themselves; what still needs the answer reads it here, so
 * a test can see every such place and `check-host-platform.mjs` keeps the
 * list of files that read `process.platform` themselves from growing.
 */
export type HostPlatform = "darwin" | "linux" | "win32" | "other"

export function hostPlatform(): HostPlatform {
  const platform = process.platform
  return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other"
}

/** Node's own name for the platform, for what takes one: a path such as `darwin-arm64`, or a default a test overrides. */
export function nodePlatform(): ProcessPlatform {
  return process.platform
}

export const onMac = (): boolean => hostPlatform() === "darwin"
export const onLinux = (): boolean => hostPlatform() === "linux"
export const onWindows = (): boolean => hostPlatform() === "win32"

/** The operating system's name as people say it. */
export function systemName(): "macOS" | "Windows" | "Linux" | "other" {
  const platform = hostPlatform()
  return platform === "darwin" ? "macOS" : platform === "win32" ? "Windows" : platform === "linux" ? "Linux" : "other"
}

/**
 * The operating system's own version, such as "26.6.2" on macOS, the same
 * under Electron and plain Node. Electron's `process.getSystemVersion` only
 * exists under Electron; the kernel's release is the fallback elsewhere.
 */
export function systemVersion(): string {
  // SAFETY: Electron's main process adds `getSystemVersion` to `process`; elsewhere it is absent, which the optional call allows.
  const electron = (process as { getSystemVersion?: () => string }).getSystemVersion?.()
  return electron || (onMac() ? macProductVersion() : undefined) || release()
}

/**
 * The system as a device list shows it: "macOS 26.0" on a Mac; on Linux its architecture and distribution, such as
 * "Linux x64 · Ubuntu 24.04" (`/etc/os-release`), else its kernel's release.
 */
export function devicePlatform(): string {
  if (!onLinux()) return `${systemName()} ${systemVersion()}`.trim()
  let osRelease: string | undefined
  try {
    osRelease = readFileSync("/etc/os-release", "utf8")
  } catch {
    osRelease = undefined
  }
  return linuxPlatform(process.arch, osRelease, release())
}

/** `devicePlatform` on Linux, from `/etc/os-release`'s text (none when it can't be read) and the kernel's release. */
export function linuxPlatform(arch: string, osRelease: string | undefined, kernel: string): string {
  return `Linux ${arch} · ${(osRelease && linuxDistribution(osRelease)) || kernel}`
}

function linuxDistribution(text: string): string | undefined {
  const field = (name: string) => new RegExp(`^${name}=(?:"([^"\\n]*)"|(\\S*))$`, "m").exec(text)?.slice(1).find((value) => value !== undefined)
  const name = field("NAME")
  const version = field("VERSION_ID")
  return name ? (version ? `${name} ${version}` : name) : field("PRETTY_NAME")
}

function macProductVersion(): string | undefined {
  try {
    return /<key>ProductVersion<\/key>\s*<string>([^<]{1,32})<\/string>/.exec(readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8"))?.[1]
  } catch {
    return undefined
  }
}
