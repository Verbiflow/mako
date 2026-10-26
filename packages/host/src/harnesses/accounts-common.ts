import { lock } from "proper-lockfile"
import { z } from "zod"
import { execFile } from "node:child_process"
import { createHmac, randomBytes, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  mkdir,
  realpath,
  readlink,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { userInfo } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"
import type { JsonValue } from "../contracts/json.js"
import { securityKeychain } from "../base/keychain.js"
import { onMac } from "../base/platform.js"
const run = promisify(execFile)

const credentialSalt = randomBytes(32)
/** Host-only equality token; neither credentials nor an offline token hash crosses IPC. */
export function credentialFingerprint(values: readonly (string | null)[]): string {
  return createHmac("sha256", credentialSalt).update(JSON.stringify(values)).digest("hex")
}

/**
 * Who `contents` signs in as, as `credentialRevision` compares it: the fields
 * `principal` keeps, without the tokens a CLI rotates on its own before they
 * lapse. A refresh would otherwise read as another account and refuse the
 * next prompt. Contents in a shape `principal` does not read count whole.
 */
export function principalFingerprint(contents: string | null, principal: z.ZodType): string {
  if (contents === null) return credentialFingerprint([null])
  const parsed = z.string().transform((text, context) => {
    try { return JSON.parse(text) }
    catch {
      context.addIssue({ code: "custom", message: "not JSON" })
      return z.NEVER
    }
  }).pipe(principal).safeParse(contents)
  return credentialFingerprint([parsed.success ? JSON.stringify(parsed.data) : contents])
}

export async function readOptionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8") }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}

export async function credentialFileFingerprint(path: string): Promise<string> {
  try { return credentialFingerprint([await readFile(path, "utf8")]) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return credentialFingerprint([null])
    throw error
  }
}

export function valueFields(
  value: JsonValue | undefined
): Map<string, JsonValue> | null {
  if (Object.prototype.toString.call(value) !== "[object Object]") return null
  return new Map(Object.entries(Object(value)))
}

export function jsonFields(contents: string): Map<string, JsonValue> {
  const value: JsonValue = JSON.parse(contents)
  return valueFields(value) ?? new Map()
}

export function stringValue(value: JsonValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

export function numberValue(value: JsonValue | undefined): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Number]")
    return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const selectionState = z.record(z.string(), z.string().max(160).nullable())
function parseSelectionState(contents: string): Map<string, string | null> {
  return new Map(Object.entries(selectionState.parse(JSON.parse(contents))))
}

function providerName(provider: string): string {
  if (!/^[a-z0-9-]+$/.test(provider))
    throw new Error("Invalid account provider")
  return provider
}

/**
 * Where Mako keeps accounts: `accounts` in the host's user root
 * (`HostEnvironment.userRoot`), so `~/.mako/accounts` for the installed app,
 * every profile and a cloud machine, and the data root's own for a host
 * isolated outside the application-data folder (a test's, a proof's). It
 * holds each account Mako added (`<provider>/<name>`, the folder its harness
 * signs into), which one each harness launches on (`selection/`), the lease
 * every launch takes while it resolves its account, which accounts running
 * work holds (`holds/`) and removals waiting on them (`removing/`). Hosts
 * sharing a root share all of it; a host with its own shares none of it, and
 * runs each harness on its default login, the one a terminal uses.
 */
export class AccountRoot {
  readonly path: string

  constructor(userRoot: string) {
    this.path = join(userRoot, "accounts")
  }

  /** The folder a provider's accounts are kept in. */
  provider(provider: string): string {
    return join(this.path, providerName(provider))
  }

  /** One account's folder. Throws on a name that could leave it. */
  dir(provider: string, name: string): string {
    if (
      !/^[a-z0-9][a-z0-9@._+-]{0,159}$/i.test(name) ||
      name === "." ||
      name === ".."
    )
      throw new Error("Invalid account name")
    return join(this.provider(provider), name)
  }

  /** Where running work's leases are, one file per host. */
  get holds(): string {
    return join(this.path, "holds")
  }

  /** Where a provider's removals wait, or every provider's without one. */
  removing(provider?: string): string {
    return provider === undefined ? join(this.path, "removing") : join(this.path, "removing", providerName(provider))
  }

  private selectionPath(provider: string): string {
    return join(this.path, "selection", `${providerName(provider)}.json`)
  }

  async readSelection(provider: string): Promise<string | null> {
    let contents: string
    try {
      contents = await readFile(this.selectionPath(provider), "utf8")
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
        throw new Error(
          "Account selection could not be read. Select the account again.",
          { cause: error }
        )
      // Existing installations migrate each provider on its next explicit selection.
      try {
        contents = await readFile(join(this.path, "state.json"), "utf8")
      } catch (legacyError) {
        if (
          legacyError instanceof Error &&
          "code" in legacyError &&
          legacyError.code === "ENOENT"
        )
          return null
        throw new Error(
          "Account selection could not be read. Select the account again.",
          { cause: legacyError }
        )
      }
    }
    try {
      return parseSelectionState(contents).get(provider) ?? null
    } catch {
      throw new Error("Account selection is invalid. Select the account again.")
    }
  }

  /** Identity writers in every host sharing this root take the same provider lease. */
  async withMutation<T>(
    provider: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const path = this.selectionPath(provider)
    await mkdir(join(this.path, "selection"), {
      recursive: true,
      mode: 0o700,
    })
    // SAFETY: All profile hosts use identical lease timing. A compromised lease
    // must fail closed; the library's default handler terminates the writer.
    const release = await lock(path, {
      realpath: false,
      stale: 60_000,
      update: 5_000,
      retries: { retries: 20, minTimeout: 100, maxTimeout: 500, factor: 1.2 },
    })
    try {
      return await operation()
    } finally {
      await release()
    }
  }

  async writeSelection(
    provider: string,
    name: string | null
  ): Promise<void> {
    if (name !== null) this.dir(provider, name)
    const destination = this.selectionPath(provider)
    await mkdir(join(this.path, "selection"), {
      recursive: true,
      mode: 0o700,
    })
    const temporary = `${destination}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ [provider]: name }), {
        mode: 0o600,
        flag: "wx",
      })
      await rename(temporary, destination)
    } finally {
      await rm(temporary, { force: true })
    }
  }
}

export function cleanAccountName(name: string): string {
  const clean = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
  if (!clean || clean === "default")
    throw new Error("Pick a different account name")
  return clean
}

/**
 * A profile whose native sign-in has not finished. It is never listed or
 * selectable, so an abandoned sign-in cannot appear as a signed-out account.
 */
const LOGIN_PENDING = ".mako-login-pending"
export async function markLoginPending(dir: string): Promise<void> {
  await writeFile(join(dir, LOGIN_PENDING), "", { mode: 0o600, flag: "wx" })
}
export async function clearLoginPending(dir: string): Promise<void> {
  await rm(join(dir, LOGIN_PENDING), { force: true })
}
export function loginPending(dir: string): boolean {
  return existsSync(join(dir, LOGIN_PENDING))
}

const AccountHome = z.object({ version: z.literal(1), home: z.string().refine(isAbsolute) })
/** Preserve the settings/store origin across shell routing changes; never copy credentials here. */
export async function recordAccountHome(dir: string, home: string): Promise<void> {
  const canonical = await realpath(home).catch(() => resolve(home))
  await writeFile(join(dir, ".mako-account.json"), JSON.stringify({ version: 1, home: canonical }), { mode: 0o600, flag: "wx" })
}
export async function managedAccountHome(dir: string, fallback: string, store: string): Promise<string> {
  try { return AccountHome.parse(JSON.parse(await readFile(join(dir, ".mako-account.json"), "utf8"))).home }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error
  }
  // Older captures already own a store symlink. Keep that origin, not today's shell profile.
  try { return dirname(resolve(dir, await readlink(join(dir, store)))) }
  catch (error) {
    if (error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EINVAL")) return fallback
    throw error
  }
}

/**
 * Point an account home's shared entries at the real home. Re-run at every
 * spawn, because a skills directory created *after* capture should appear
 * under every account the moment it exists.
 */
export async function ensureSharedLinks(
  realHome: string,
  dir: string,
  links: readonly string[]
): Promise<void> {
  for (const link of links) {
    const target = join(realHome, link)
    const at = join(dir, link)
    if (!existsSync(target) || existsSync(at)) continue
    await symlink(target, at).catch(() => {})
  }
}

export function parseUsageReset(value: JsonValue | undefined): number | null {
  const seconds = numberValue(value)
  if (seconds !== undefined) return seconds * (seconds < 1e12 ? 1000 : 1)
  const timestamp = stringValue(value)
  if (timestamp === undefined) return null
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

export interface JwtClaims {
  email?: string
  accountId?: string
  /** Unix ms from `exp`. */
  expiresAt?: number
}

export function jwtClaims(token: string | undefined): JwtClaims {
  if (!token) return {}
  const payload = token.split(".")[1]
  if (!payload) return {}
  try {
    const fields = jsonFields(
      Buffer.from(payload, "base64url").toString("utf8")
    )
    const nested = valueFields(fields.get("https://api.openai.com/auth"))
    const profile = valueFields(fields.get("https://api.openai.com/profile"))
    const organizations = fields.get("organizations")
    const firstOrganization = Array.isArray(organizations)
      ? valueFields(organizations[0])
      : null
    const email =
      stringValue(fields.get("email")) ?? stringValue(profile?.get("email"))
    const accountId =
      stringValue(fields.get("chatgpt_account_id")) ??
      stringValue(nested?.get("chatgpt_account_id")) ??
      stringValue(firstOrganization?.get("id"))
    const expiry = numberValue(fields.get("exp"))
    const claims: JwtClaims = {}
    if (email !== undefined) claims.email = email
    if (accountId !== undefined) claims.accountId = accountId
    if (expiry !== undefined) claims.expiresAt = expiry * 1000
    return claims
  } catch {
    return {}
  }
}

/** A harness's own keychain item, which trusts `security`: see `securityKeychain`. */
export async function readKeychain(
  service: string,
  account?: string,
  failurePolicy: "optional" | "required" = "optional"
): Promise<string | null> {
  if (!onMac()) return null
  const read = await securityKeychain().read({ service, account: account || undefined })
  if (read.kind === "found") return read.value.trim() || null
  if (read.kind === "failed" && failurePolicy === "required")
    throw new Error("Could not read macOS Keychain. Unlock it and allow access before using this login.", {
      cause: { operation: "read-native-credentials", reason: read.reason },
    })
  return null
}

/** When a Keychain item was last written. Reads attributes only, never the secret. */
export async function keychainWrittenAt(service: string, account?: string): Promise<string | undefined> {
  if (!onMac()) return undefined
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", service, ...(account ? ["-a", account] : [])])
    const stamp = /"mdat"<timedate>=0x[0-9A-F]+\s+"(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z/.exec(stdout)
    return stamp ? `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}Z` : undefined
  } catch {
    return undefined
  }
}

export async function writeKeychain(
  service: string,
  contents: string,
  /** The item's account, when its owner names it otherwise than the login user (Claude's `$USER`, Codex's home key). */
  account = userInfo().username
): Promise<void> {
  if (!onMac()) return
  try {
    await securityKeychain().write({ service, account }, contents)
  } catch (error) {
    throw new Error(
      "Could not save the account to macOS Keychain. Unlock Keychain and try again.",
      { cause: error }
    )
  }
}

export async function deleteKeychain(service: string): Promise<void> {
  if (!onMac()) return
  try {
    await securityKeychain().delete({ service, account: userInfo().username })
  } catch (error) {
    throw new Error(
      "Could not remove the account from macOS Keychain. Unlock Keychain and try again.",
      { cause: error }
    )
  }
}
