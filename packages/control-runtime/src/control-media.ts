import { existsSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { resolveExecutable } from "./executable.js"

/** Packaged recording always uses its reviewed binary, independent of shell PATH. */
export function mediaExecutable(name: "ffmpeg" | "ffprobe") {
  const platform = `${process.platform}-${process.arch}`
  const moduleDirectory = dirname(fileURLToPath(import.meta.url))
  const archive = moduleDirectory.indexOf("/app.asar/")
  const resources = archive < 0 ? undefined : moduleDirectory.slice(0, archive)
  if (resources) {
    const packaged = join(resources, "control-media", platform, name)
    if (!existsSync(packaged))
      throw new Error("This Mako build is missing its recording encoder. Reinstall a complete build.")
    return packaged
  }
  const mediaRoot = process.env.MAKO_CONTROL_MEDIA_ROOT
  if (mediaRoot) {
    if (!isAbsolute(mediaRoot)) throw new Error("MAKO_CONTROL_MEDIA_ROOT must be absolute")
    const configured = join(mediaRoot, name)
    if (!existsSync(configured)) throw new Error(`Configured recording tool is missing: ${name}`)
    return configured
  }
  const executable = resolveExecutable(name)
  if (!executable)
    throw new Error(`${name} is required for recording. Install it on PATH or set MAKO_CONTROL_MEDIA_ROOT to the directory containing ffmpeg and ffprobe.`)
  return executable
}
