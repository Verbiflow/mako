import { z } from "zod"
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import type { JsonValue } from "./codex-app-json.js"

const run = promisify(execFile)

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
    return parseSelectionState(contents).get(provider) ?? null
  } catch {
    throw new Error("Account selection is invalid. Select the account again.")
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
    const claims: JwtClaims = {}
    if (email !== undefined) claims.email = email
    if (accountId !== undefined) claims.accountId = accountId
    return claims
  } catch {
    return {}
  }
}

export async function readKeychain(service: string): Promise<string | null> {
  if (process.platform !== "darwin") return null
  try {
    const { stdout } = await run("security", [
      "find-generic-password",
      "-s",
      service,
      "-w",
    ])
    return stdout.trim() || null
  } catch {
    return null
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
      "add-generic-password", "-U", "-s", service, "-a", user, "-w", contents,
    ])
  } catch {
    // execFile errors include the command arguments, including the credential.
    throw new Error("Could not save the account to macOS Keychain. Unlock Keychain and try again.")
  }
}


export async function deleteKeychain(service: string): Promise<void> {
  if (process.platform !== "darwin") return
  try {
    await run("security", ["delete-generic-password", "-s", service, "-a", userInfo().username])
  } catch (error) {
    if (z.object({ code: z.literal(44) }).safeParse(error).success) return
    throw new Error("Could not remove the account from macOS Keychain. Unlock Keychain and try again.", { cause: error })
  }
}
