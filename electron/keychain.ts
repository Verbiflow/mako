import type * as Keyring from "@napi-rs/keyring"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"

/**
 * One generic password in the login keychain. A read without an account
 * finds the service's first item, as `security find-generic-password` does.
 */
export interface KeychainItem {
  service: string
  account: string
}

export type KeychainRead =
  | { kind: "found"; value: string }
  | { kind: "missing" }
  /** The keychain answered with an error: locked, refused by the person, or out of reach. Never the value. */
  | { kind: "failed"; reason: string }

/**
 * The macOS login keychain, through one of two doors. macOS keeps an access
 * list on every item and asks the person before a binary not on it reads the
 * value; "Always Allow" adds that binary. The door decides which binary asks:
 *
 * - {@link processKeychain} asks as this process: Mako, or Mako Helper for a
 *   host in Node mode. Mako's own items go through it, so the prompt names
 *   Mako and "Always Allow" trusts Mako only.
 * - {@link securityKeychain} asks as `/usr/bin/security`, found on `PATH`.
 *   Items made with `security` (Claude Code's sign-in, and the scoped Claude
 *   items Mako writes for the harness) trust `security`, so harness items go
 *   through it; read in-process, they'd be asked for on every new build.
 */
export interface Keychain {
  read(item: Omit<KeychainItem, "account"> & { account?: string }): Promise<KeychainRead>
  /** Adds the item, or replaces its value. A failure never carries the value. */
  write(item: KeychainItem, value: string): Promise<void>
  /** False when there was no item. */
  delete(item: KeychainItem): Promise<boolean>
}

/**
 * The keychain asked from this process, through `@napi-rs/keyring`, off the
 * event loop. A prompt from macOS keeps the read waiting until the person
 * answers, without holding up anything else. The host hands in
 * `heavy.keyring`, so the addon loads with the first keychain call.
 */
export function processKeychain(keyring: () => Promise<typeof Keyring>): Keychain {
  return {
    async read(item) {
      try {
        const { AsyncEntry, findCredentialsAsync } = await keyring()
        if (item.account === undefined) {
          const [first] = await findCredentialsAsync(item.service)
          return first ? { kind: "found", value: first.password } : { kind: "missing" }
        }
        const value = await new AsyncEntry(item.service, item.account).getPassword()
        return value === undefined ? { kind: "missing" } : { kind: "found", value }
      } catch (error) {
        return { kind: "failed", reason: error instanceof Error ? error.message : String(error) }
      }
    },
    async write(item, value) {
      const { AsyncEntry } = await keyring()
      try {
        await new AsyncEntry(item.service, item.account).setPassword(value)
      } catch (error) {
        throw new Error(`Couldn't save "${item.service}" to the keychain`, { cause: error })
      }
    },
    async delete(item) {
      const { AsyncEntry } = await keyring()
      return new AsyncEntry(item.service, item.account).deleteCredential()
    },
  }
}

const SECURITY = "security"
/** `errSecItemNotFound`, as `security`'s exit status. */
const NOT_FOUND = 44
const ExitSchema = z.object({ code: z.number() })
const run = promisify(execFile)

/**
 * The value in `security find-generic-password -g`'s report: `password:
 * "…"` for plain printable text, `password: 0x<hex>  "…"` for anything else.
 * `-w` prints the second kind as bare hex, which can't be told from a value
 * that is hex.
 */
export function securityValue(report: string): string | null {
  const hex = /^password: 0x([0-9A-Fa-f]*)/m.exec(report)
  if (hex) return Buffer.from(hex[1], "hex").toString("utf8")
  const plain = /^password: "(.*)"$/m.exec(report)
  return plain ? plain[1] : null
}

/** A word in a `security -i` command, quoted as its reader splits them. */
function securityWord(text: string): string {
  if (/[\n\r\0]/.test(text)) throw new Error("A keychain service or account name is one line")
  return `"${text.replace(/[\\"]/g, (character) => `\\${character}`)}"`
}

/**
 * Runs one `security -i` command given on stdin, so the value never sits in
 * an argument list another process can read. Its output and errors are
 * dropped: `security` echoes a failed command, value and all.
 */
function securityCommand(command: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(SECURITY, ["-i"], { stdio: ["pipe", "ignore", "ignore"] })
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
    // A `security` that exits before reading closes the pipe; its status says what happened.
    child.stdin.on("error", () => undefined)
    child.stdin.end(`${command}\n`)
  })
}

/** The keychain asked as `security`, for items a harness made that way. */
export function securityKeychain(): Keychain {
  return {
    async read(item) {
      try {
        const { stderr } = await run(SECURITY, [
          "find-generic-password",
          "-s",
          item.service,
          ...(item.account === undefined ? [] : ["-a", item.account]),
          "-g",
        ])
        const value = securityValue(stderr)
        return value === null ? { kind: "failed", reason: "security's report had no password" } : { kind: "found", value }
      } catch (error) {
        const exit = ExitSchema.safeParse(error)
        if (exit.success && exit.data.code === NOT_FOUND) return { kind: "missing" }
        // The error holds the output, which can hold the value: only the status leaves.
        return { kind: "failed", reason: exit.success ? `security exited ${exit.data.code}` : "security didn't run" }
      }
    },
    async write(item, value) {
      const hex = Buffer.from(value, "utf8").toString("hex")
      const status = await securityCommand(`add-generic-password -U -s ${securityWord(item.service)} -a ${securityWord(item.account)} -X ${hex}`)
        .catch(() => -1)
      if (status !== 0) throw new Error(`Couldn't save "${item.service}" to the keychain (security exited ${status})`)
    },
    async delete(item) {
      try {
        await run(SECURITY, ["delete-generic-password", "-s", item.service, "-a", item.account])
        return true
      } catch (error) {
        const exit = ExitSchema.safeParse(error)
        if (exit.success && exit.data.code === NOT_FOUND) return false
        throw new Error(`Couldn't remove "${item.service}" from the keychain${exit.success ? ` (security exited ${exit.data.code})` : ""}`, { cause: error })
      }
    },
  }
}
