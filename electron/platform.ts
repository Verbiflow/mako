import { readFileSync } from "node:fs"
import { release } from "node:os"

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
export function nodePlatform(): NodeJS.Platform {
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

let version: string | undefined

/**
 * The operating system's own version, such as "26.6.2" on macOS, the same
 * under Electron and plain Node. Electron's `process.getSystemVersion` only
 * exists under Electron; the kernel's release is the fallback elsewhere.
 */
export function systemVersion(): string {
  if (version !== undefined) return version
  // SAFETY: Electron's main process adds `getSystemVersion` to `process`; elsewhere it is absent, which the optional call allows.
  const electron = (process as { getSystemVersion?: () => string }).getSystemVersion?.()
  version = electron || (onMac() ? macProductVersion() : undefined) || release()
  return version
}

function macProductVersion(): string | undefined {
  try {
    return /<key>ProductVersion<\/key>\s*<string>([^<]{1,32})<\/string>/.exec(readFileSync("/System/Library/CoreServices/SystemVersion.plist", "utf8"))?.[1]
  } catch {
    return undefined
  }
}
