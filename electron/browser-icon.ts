import { execFile } from "node:child_process"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)
const icons = new Map<
  string,
  { stamp: number; value: Promise<string | undefined> }
>()

/** Decode the bundle's actual icon; getFileIcon(.app) can return a generic tile. */
export async function browserApplicationIcon(
  applicationPath: string
): Promise<string | undefined> {
  if (process.platform !== "darwin" || !applicationPath.endsWith(".app"))
    return undefined
  try {
    const plist = join(applicationPath, "Contents", "Info.plist")
    const stamp = (await stat(plist)).mtimeMs
    const cached = icons.get(applicationPath)
    if (cached?.stamp === stamp) return cached.value
    const value = readIcon(applicationPath, plist)
    icons.set(applicationPath, { stamp, value })
    return value
  } catch {
    return undefined
  }
}

async function readIcon(
  applicationPath: string,
  plist: string
): Promise<string | undefined> {
  let directory: string | undefined
  try {
    const { stdout } = await execute(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIconFile", "raw", "-o", "-", plist],
      { timeout: 1500, maxBuffer: 1024 }
    )
    const name = stdout.trim()
    if (!name || basename(name) !== name || name === "." || name === "..")
      return undefined
    const path = join(
      applicationPath,
      "Contents",
      "Resources",
      name.endsWith(".icns") ? name : `${name}.icns`
    )
    if ((await stat(path)).size > 8 * 1024 * 1024) return undefined
    directory = await mkdtemp(join(tmpdir(), "mako-browser-icon-"))
    const output = join(directory, "icon.png")
    await execute(
      "/usr/bin/sips",
      ["-s", "format", "png", "-Z", "64", path, "--out", output],
      { timeout: 2000, maxBuffer: 4096 }
    )
    const bytes = await readFile(output)
    if (bytes.length > 64 * 1024) return undefined
    return `data:image/png;base64,${bytes.toString("base64")}`
  } catch {
    return undefined
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true })
  }
}
