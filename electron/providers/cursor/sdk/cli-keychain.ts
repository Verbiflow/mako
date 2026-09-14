import { execFile } from "node:child_process"

/**
 * The key `cursor-agent login` leaves behind.
 *
 * Verified 2026-09-13 on macOS: a signed-in `cursor-agent` keeps a Cursor API
 * key in the login keychain as the generic password with service
 * `cursor-api-key` and account `cursor-user`, written through
 * `/usr/bin/security`, and that key authenticates `@cursor/sdk`'s own
 * requests (`Cursor.me()` named the account and `Cursor.models.list()`
 * answered). So a machine already signed into the CLI needs no second
 * sign-in: when Mako holds no key of its own, the SDK runs under the CLI's.
 * The item was stored by the same `security` tool this reads with, so the
 * read raises no keychain prompt; were the item ever written another way,
 * macOS would ask once and the answer is remembered by the keychain.
 *
 * The key never leaves the host process except as `CURSOR_API_KEY` in an SDK
 * child's environment. It is read, not copied: a CLI that rotates its key is
 * followed on the next spawn, and `cursor-agent logout` signs Mako out too.
 */
export const CURSOR_CLI_KEYCHAIN_SERVICE = "cursor-api-key"
export const CURSOR_CLI_KEYCHAIN_ACCOUNT = "cursor-user"

/** `security` exits 44 (errSecItemNotFound) when there is no such item. */
const NOT_FOUND_EXIT = 44
const CLI_KEY_PATTERN = /^[\x21-\x7e]{16,4096}$/

export interface CliKeychainOptions {
  platform?: NodeJS.Platform
  /** Test hook: the `security` invocation. */
  run?(args: readonly string[]): Promise<{ stdout: string; code: number }>
  timeoutMs?: number
}

function runSecurity(args: readonly string[], timeoutMs: number): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    execFile("/usr/bin/security", [...args], { timeout: timeoutMs, encoding: "utf8", maxBuffer: 64 * 1024 }, (error, stdout) => {
      if (!error) {
        resolve({ stdout, code: 0 })
        return
      }
      const code = "code" in error && Number.isInteger(error.code) ? Number(error.code) : 1
      resolve({ stdout: "", code })
    })
  })
}

/**
 * The CLI's key, or `null` when the CLI is not signed in or this is not
 * macOS. A read that fails for another reason (a locked keychain, a timeout)
 * is also `null`: the caller falls through to "signed out", and the row in
 * Settings then offers the other ways in.
 */
export async function readCursorCliApiKey(options: CliKeychainOptions = {}): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "darwin") return null
  const run = options.run ?? ((args) => runSecurity(args, options.timeoutMs ?? 5_000))
  const result = await run([
    "find-generic-password",
    "-s",
    CURSOR_CLI_KEYCHAIN_SERVICE,
    "-a",
    CURSOR_CLI_KEYCHAIN_ACCOUNT,
    "-w",
  ])
  if (result.code === NOT_FOUND_EXIT || result.code !== 0) return null
  const key = result.stdout.trim()
  return CLI_KEY_PATTERN.test(key) ? key : null
}
