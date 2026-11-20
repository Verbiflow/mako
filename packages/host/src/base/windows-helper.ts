import { execFile, execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, join, win32 } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * `mako-windows.exe` (`native/windows-helper/mako-windows.c`): the Win32 Mako's host needs and Node doesn't expose,
 * one small static program run by its whole path. It ships beside the app's executable, in its read-only install
 * folder; a checkout builds it into `build/` (`scripts/build-windows-helper.mjs`). Where it's missing each caller
 * says what it does without it.
 */
export function windowsHelper(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const installed = env.MAKO_HOST_EXECUTABLE ? join(dirname(env.MAKO_HOST_EXECUTABLE), "mako-windows.exe") : undefined
  const checkout = fileURLToPath(new URL("../../../../build/mako-windows.exe", import.meta.url))
  return [installed, checkout].find((path): path is string => path !== undefined && win32.isAbsolute(path) && existsSync(path))
}

/** The helper's lines for `args`, waiting for it (a few milliseconds); undefined where it's missing or failed. */
export function windowsHelperSync(args: readonly string[]): string[] | undefined {
  const helper = windowsHelper()
  if (!helper) return undefined
  try {
    return execFileSync(helper, args, { encoding: "utf8", timeout: 5_000, windowsHide: true }).trim().split(/\r?\n/)
  } catch {
    return undefined
  }
}

/** `windowsHelperSync`, off the thread. */
export function windowsHelperLines(args: readonly string[]): Promise<string[] | undefined> {
  const helper = windowsHelper()
  if (!helper) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    execFile(helper, args, { encoding: "utf8", timeout: 15_000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim().split(/\r?\n/)))
  })
}

/** This user's SID (`S-1-5-21-…`), by the helper, or Windows' own `whoami /user` by its whole path. */
export async function windowsUserSid(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const said = (await windowsHelperLines(["sid"]))?.[0]
  if (said && /^S-1-[0-9-]+$/.test(said)) return said
  const whoami = win32.join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "whoami.exe")
  return new Promise((resolve) => {
    execFile(whoami, ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", timeout: 10_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : /"(S-1-[0-9-]+)"/.exec(stdout)?.[1]))
  })
}
