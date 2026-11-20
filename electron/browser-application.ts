import { execFile } from "node:child_process"
import { realpath } from "node:fs/promises"
import { win32 } from "node:path"
import { promisify } from "node:util"

const execute = promisify(execFile)

/** Native Messaging's parent is the browser. Use its executable, not its brand. */
export async function nativeBrowserApplication(
  parent = process.ppid
): Promise<string | undefined> {
  if (process.platform === "linux") {
    // /proc resolves the running executable even for Chromium forks launched
    // through shell wrappers or alternatives symlinks.
    return realpath(`/proc/${String(parent)}/exe`).catch(() => undefined)
  }
  if (process.platform === "win32") {
    // Chromium starts a native host through cmd.exe, so the browser is the
    // grandparent, which Node can't name without a slow WMI query. Each brand
    // reads its own registry key, whose launcher names its executable
    // (`browser-extension-windows.ts`).
    const named = process.env.MAKO_BROWSER_APPLICATION
    return named && win32.isAbsolute(named)
      ? realpath(named).catch(() => undefined)
      : undefined
  }
  if (process.platform !== "darwin") return undefined
  try {
    const { stdout } = await execute(
      "/bin/ps",
      ["-p", String(parent), "-o", "comm="],
      {
        timeout: 1500,
        maxBuffer: 8192,
      }
    )
    const bundle = macApplicationBundle(stdout.trim())
    return bundle ? await realpath(bundle) : undefined
  } catch {
    return undefined
  }
}

export function macApplicationBundle(executable: string): string | undefined {
  if (!executable.startsWith("/") || executable.includes("\n")) return undefined
  const end = executable.indexOf(".app/Contents/")
  return end < 0 ? undefined : executable.slice(0, end + 4)
}
