import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveExecutable } from "./executable.js"

/** Packaged recording always uses its reviewed binary, independent of shell PATH. */
export function mediaExecutable(name: "ffmpeg" | "ffprobe") {
  const platform = `${process.platform}-${process.arch}`
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const resources = (process.resourcesPath && existsSync(join(process.resourcesPath, "app.asar")) ? process.resourcesPath : undefined) ??
    (moduleDirectory.includes("app.asar/") ? join(moduleDirectory, "../..") : undefined)
  if (resources) {
    const packaged = join(resources, "control-media", platform, name)
    if (!existsSync(packaged))
      throw new Error("This Mako build is missing its recording encoder. Reinstall a complete build.")
    return packaged
  }
  const local = join(moduleDirectory, "../vendor/control-media", platform, name)
  if (existsSync(local)) return local
  const executable = resolveExecutable(name)
  if (!executable)
    throw new Error(`${name} is required for development recording. Run npm run prepare:control-media.`)
  return executable
}
