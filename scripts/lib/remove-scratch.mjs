// Removes a test's scratch folder. On Windows, Node's own removal refuses a tree that holds a read-only file (every
// object Git writes is one), so there the system's `rd` removes what it couldn't; a folder something still has open
// is left for the temporary folder's own cleanup, never a test's failure.
import { execFileSync } from "node:child_process"
import { rmSync } from "node:fs"

/** @param {string} path */
export function removeScratch(path) {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  } catch (error) {
    if (process.platform !== "win32") throw error
    try {
      execFileSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/c", "rd", "/s", "/q", path], { stdio: "ignore", windowsHide: true })
    } catch {
      // Still open somewhere.
    }
  }
}
