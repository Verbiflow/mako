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
import { homedir, userInfo } from "node:os"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { promisify } from "node:util"
import type { JsonValue } from "./codex-app-json.js"
const run = promisify(execFile)

const credentialSalt = randomBytes(32)
/** Host-only equality token; neither credentials nor an offline token hash crosses IPC. */
export function credentialFingerprint(values: readonly (string | null)[]): string {
  return createHmac("sha256", credentialSalt).update(JSON.stringify(values)).digest("hex")
}

export async function credentialFileFingerprint(path: string): Promise<string> {
  try { return credentialFingerprint([await readFile(path, "utf8")]) }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return credentialFingerprint([null])
    throw error
  }
}


/**
 * Runtime-only values must never leak into a provider child process. The
 * host's own launch variables are included: an agent under the installed
 * app once ran `npm run dev` and, through the inherited `MAKO_DATA_ROOT`
 * and `MAKO_WEB_SOCKET`, attached its "profile" client to the installed
 * app's host instead of starting one.
 */
const MAKO_RUNTIME_ENV = [
  "MAKO_BACKEND_TOKEN",
  "MAKO_CUA_SOCKET",
  "MAKO_DATA_ROOT",
  "MAKO_PROFILE",
  "MAKO_HOST_ONLY",
  "MAKO_STANDALONE",
  "MAKO_WEB_SOCKET",
  "MAKO_WEB_ONLY",
  "MAKO_CLIENT_ID",
  "VITE_DEV_SERVER_URL",
]

export function accountsRoot(): string {
  return join(homedir(), ".mako", "accounts")
}

export function accountDir(provider: string, name: string): string {
  if (!/^[a-z0-9-]+$/.test(provider))
    throw new Error("Invalid account provider")
  if (
    !/^[a-z0-9][a-z0-9@._+-]{0,159}$/i.test(name) ||
    name === "." ||
    name === ".."
  )
    throw new Error("Invalid account name")
  return join(accountsRoot(), provider, name)
}

function statePath(): string {
  return join(accountsRoot(), "state.json")
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

function selectionPath(provider: string): string {
  if (!/^[a-z0-9-]+$/.test(provider))
    throw new Error("Invalid account provider")
  return join(accountsRoot(), "selection", `${provider}.json`)
}

export async function readSelection(provider: string): Promise<string | null> {
  let contents: string
  try {
    contents = await readFile(selectionPath(provider), "utf8")
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error(
        "Account selection could not be read. Select the account again.",
        { cause: error }
      )
    // Existing installations migrate each provider on its next explicit selection.
    try {
      contents = await readFile(statePath(), "utf8")
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
    const selection = parseSelectionState(contents).get(provider) ?? null
    // "@cli" chose the CLI's ordinary login when the default could follow a shell router; it is the default now.
    return selection === "@cli" ? null : selection
  } catch {
    throw new Error("Account selection is invalid. Select the account again.")
  }
}

/** Identity writers in separate app profiles share the same provider lease. */
export async function withAccountMutation<T>(
  provider: string,
  operation: () => Promise<T>
): Promise<T> {
  const path = selectionPath(provider)
  await mkdir(join(accountsRoot(), "selection"), {
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

export async function writeSelection(
  provider: string,
  name: string | null
): Promise<void> {
  if (name !== null) accountDir(provider, name)
  const destination = selectionPath(provider)
  await mkdir(join(accountsRoot(), "selection"), {
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

export function childProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of MAKO_RUNTIME_ENV) delete env[key]
  return env
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

const KeychainReadFailure = z.object({
  code: z.union([z.number(), z.enum(["ENOENT", "EACCES", "ETIMEDOUT"])]).optional(),
  killed: z.boolean().optional(),
})

export async function readKeychain(
  service: string,
  account?: string,
  failurePolicy: "optional" | "required" = "optional"
): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      service,
      ...(account ? ["-a", account] : []),
      "-w",
    ])
    return stdout.trim() || null
  } catch (error) {
    if (failurePolicy === "required" && !(error instanceof Error && "code" in error && error.code === 44)) {
      // Native exec failures can contain credential stdout; retain only public failure facts.
      const failure = KeychainReadFailure.safeParse(error)
      throw new Error("Could not read macOS Keychain. Unlock it and allow access before using this login.", {
        // eslint-disable-next-line preserve-caught-error -- Raw execFile causes retain credential stdout; preserve only validated public failure facts.
        cause: failure.success ? failure.data : { operation: "read-native-credentials" },
      })
    }
    return null
  }
}

/** When a Keychain item was last written. Reads attributes only, never the secret. */
export async function keychainWrittenAt(service: string, account?: string): Promise<string | undefined> {
  if (process.platform !== "darwin") return undefined
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
  contents: string
): Promise<void> {
  if (process.platform !== "darwin") return
  const user = userInfo().username
  try {
    await run("security", [
      "add-generic-password",
      "-U",
      "-s",
      service,
      "-a",
      user,
      "-w",
      contents,
    ])
  } catch {
    // execFile errors include the command arguments, including the credential.
    throw new Error(
      "Could not save the account to macOS Keychain. Unlock Keychain and try again."
    )
  }
}

export async function deleteKeychain(service: string): Promise<void> {
  if (process.platform !== "darwin") return
  try {
    await run("security", [
      "delete-generic-password",
      "-s",
      service,
      "-a",
      userInfo().username,
    ])
  } catch (error) {
    if (z.object({ code: z.literal(44) }).safeParse(error).success) return
    throw new Error(
      "Could not remove the account from macOS Keychain. Unlock Keychain and try again.",
      { cause: error }
    )
  }
}
