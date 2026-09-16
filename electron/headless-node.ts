import { existsSync } from "node:fs"
import { basename, dirname, join } from "node:path"

/**
 * Electron's main app executable registers with LaunchServices even in Node
 * mode, which gives every long-lived child its own Dock icon. The bundled
 * Helper has the same Node runtime and is declared LSUIElement on macOS.
 */
export function headlessNodeExecutable(
  executable = process.execPath,
  platform = process.platform
): string {
  if (platform !== "darwin") return executable
  const macos = dirname(executable)
  if (basename(macos) !== "MacOS") return executable
  const name = basename(executable)
  if (name.endsWith(" Helper")) return executable
  const helperName = `${name} Helper`
  const helper = join(
    dirname(macos),
    "Frameworks",
    `${helperName}.app`,
    "Contents",
    "MacOS",
    helperName
  )
  return existsSync(helper) ? helper : executable
}
