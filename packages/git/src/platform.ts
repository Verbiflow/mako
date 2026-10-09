/**
 * The one place this package asks which operating system it runs on, as
 * electron/platform.ts is the host's (`scripts/check-host-platform.mjs`).
 */
export function nodePlatform(): NodeJS.Platform {
  return process.platform
}

export const onMac = (): boolean => process.platform === "darwin"
export const onLinux = (): boolean => process.platform === "linux"
export const onWindows = (): boolean => process.platform === "win32"
