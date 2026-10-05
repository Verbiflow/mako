import { existsSync } from "node:fs"
import { chmod, mkdir, readdir, readFile, readlink, rename, rm, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type {
  AccountUsage,
  HarnessAccount,
  UsageBalance,
  UsageWindow,
} from "../../account-types.js"
import {
  accountDir,
  accountsRoot,
  childProcessEnv,
  cleanAccountName,
  credentialFileFingerprint,
  jsonFields,
  loginPending,
  markLoginPending,
  numberValue,
  parseUsageReset,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { AccountLoginLaunch, AccountLoginTarget, SelectableAccountCapability } from "../account-capability.js"
import { devinExecutable } from "./executable.js"

function dataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME || join(homedir(), ".local", "share")
}
function credentialsPath(env: NodeJS.ProcessEnv): string {
  return join(dataHome(env), "devin", "credentials.toml")
}

/** Top-level `key = "value"` strings; Devin writes nothing nested here. */
export function devinCredential(contents: string, key: string): string | undefined {
  for (const line of contents.split("\n")) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*("(?:[^"\\]|\\.)*")\s*$/.exec(line)
    if (match?.[1] !== key || match[2] === undefined) continue
    try {
      const value: JsonValue = JSON.parse(match[2])
      return stringValue(value)
    } catch {
      return undefined
    }
  }
  return undefined
}

interface DevinStatus {
  email?: string
  usage: Extract<AccountUsage, { status: "ok" }>
}

/** Connect-JSON int64 fields arrive as strings. */
function int64(value: JsonValue | undefined): number | undefined {
  const number = numberValue(value) ?? Number(stringValue(value))
  return Number.isFinite(number) ? number : undefined
}

function quotaWindow(
  remaining: JsonValue | undefined,
  resetsAt: JsonValue | undefined,
  windowMinutes: number
): UsageWindow | null {
  const left = numberValue(remaining)
  if (left === undefined) return null
  return {
    usedPercent: Math.max(0, 100 - left),
    windowMinutes,
    resetsAt: parseUsageReset(int64(resetsAt)),
  }
}

/**
 * `SeatManagementService/GetUserStatus`, the call Devin's own CLI makes for
 * its quota line: daily and weekly quotas as percent remaining, and the
 * overage balance in micro-dollars.
 */
export function parseDevinStatus(contents: string): DevinStatus {
  const status = valueFields(jsonFields(contents).get("userStatus"))
  const plan = valueFields(status?.get("planStatus"))
  const info = valueFields(plan?.get("planInfo"))
  const windows = [
    quotaWindow(
      plan?.get("dailyQuotaRemainingPercent"),
      plan?.get("dailyQuotaResetAtUnix"),
      1440
    ),
    info?.get("hideWeeklyQuota") === true
      ? null
      : quotaWindow(
          plan?.get("weeklyQuotaRemainingPercent"),
          plan?.get("weeklyQuotaResetAtUnix"),
          10_080
        ),
  ].filter((window): window is UsageWindow => window !== null)
  const usage: DevinStatus["usage"] = { status: "ok", windows }
  const planName = stringValue(info?.get("planName"))
  if (planName !== undefined) usage.plan = planName
  const overage = int64(plan?.get("overageBalanceMicros"))
  if (overage !== undefined && overage > 0) {
    const balance: UsageBalance = {
      label: "Extra usage",
      remaining: overage / 1_000_000,
      unit: "usd",
    }
    usage.balances = [balance]
  }
  const email = stringValue(status?.get("email"))
  return email === undefined ? { usage } : { email, usage }
}

class DevinStatusError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

async function fetchDevinStatus(path: string): Promise<DevinStatus | null> {
  let contents: string
  try {
    contents = await readFile(path, "utf8")
  } catch {
    return null
  }
  const apiKey = devinCredential(contents, "windsurf_api_key")
  if (!apiKey) return null
  const server =
    devinCredential(contents, "api_server_url") ?? "https://server.codeium.com"
  const response = await fetch(
    `${server}/exa.seat_management_pb.SeatManagementService/GetUserStatus`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify({
        metadata: {
          apiKey,
          ideName: "devin-cli",
          ideVersion: "3000.6.14",
          extensionName: "devin-cli",
          extensionVersion: "3000.6.14",
          locale: "en",
        },
      }),
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!response.ok) throw new DevinStatusError(response.status)
  return parseDevinStatus(await response.text())
}

/**
 * The same call answers who is signed in and what is left, so listing and
 * usage share one reading a minute per login rather than asking twice.
 */
const readings = new Map<string, { at: number; revision: string; status: Promise<DevinStatus | null> }>()

async function devinStatus(path: string): Promise<DevinStatus | null> {
  const revision = await credentialFileFingerprint(path)
  const reading = readings.get(path)
  if (reading && reading.revision === revision && Date.now() - reading.at < 60_000) return reading.status
  const status = fetchDevinStatus(path)
  readings.set(path, { at: Date.now(), revision, status })
  status.catch(() => {
    if (readings.get(path)?.status === status) readings.delete(path)
  })
  return status
}

/**
 * An account Mako keeps is a Devin data folder, signed in by Devin's CLI.
 * Its sessions run with that folder as `XDG_DATA_HOME` (see `linkDataHome`),
 * never with the key in `WINDSURF_API_KEY`, which every tool the agent runs
 * would inherit.
 */
function accountRoot(name: string): string {
  return accountDir("devin", name)
}
function accountCredentials(name: string, root = accountRoot(name)): string {
  return credentialsPath({ XDG_DATA_HOME: join(root, "data") })
}
/** A login being renewed lands here first, so a failed one leaves the old login as it was. */
function renewalRoot(name: string): string {
  return join(accountRoot(name), "renewal")
}
const IdentitySchema = z.object({ email: z.string() })
function identityPath(name: string): string {
  return join(accountRoot(name), "identity.json")
}

async function managedAccounts(selection: string | null): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  for (const name of await readdir(join(accountsRoot(), "devin")).catch(() => [])) {
    if (name.startsWith(".") || loginPending(accountRoot(name))) continue
    const email = await readFile(identityPath(name), "utf8")
      .then((contents) => IdentitySchema.parse(JSON.parse(contents)).email)
      .catch(() => undefined)
    const account: HarnessAccount = {
      harness: "devin",
      name,
      dir: accountCredentials(name),
      active: selection === name,
      source: "mako",
      route: "managed",
    }
    if (email !== undefined) account.email = email
    if (!existsSync(accountCredentials(name))) account.signedOut = true
    accounts.push(account)
  }
  return accounts
}

/** Keys that would sign Devin in as someone else than the selected account. */
const AUTH_ENV = ["WINDSURF_API_KEY", "WINDSURF_API_SERVER_URL", "DEVIN_API_KEY"]

async function accountEnv(selection: string | null, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  if (!selection || selection === "default") return env
  if (!existsSync(accountRoot(selection)))
    throw new Error("The selected Devin account no longer exists. Choose another account in Settings → Agents.")
  const contents = await readFile(accountCredentials(selection), "utf8").catch(() => null)
  if (contents === null || !devinCredential(contents, "windsurf_api_key"))
    throw new Error("The selected Devin account is signed out. Sign in again in Settings → Agents.")
  for (const key of AUTH_ENV) delete env[key]
  env.XDG_DATA_HOME = await linkDataHome(join(accountRoot(selection), "data"), dataHome(base))
  return env
}

/**
 * Makes an account's data folder stand in for the user's own: Devin finds
 * the account's login in it, and everything else (Devin's sessions, other
 * programs' data the agent's tools reach through `XDG_DATA_HOME`) is a link
 * to the user's entry, refreshed at each launch. Devin reads its login and
 * sessions through these links (CLI 3000.10).
 */
async function linkDataHome(root: string, source: string): Promise<string> {
  // Mako finds Devin's sessions in the user's folder, so they must never
  // start inside an account's.
  await mkdir(join(source, "devin", "cli"), { recursive: true })
  await linkEntries(root, source, "devin", false)
  await linkEntries(join(root, "devin"), join(source, "devin"), "credentials.toml", true)
  return root
}

/**
 * Links each of `source`'s entries but `own` into `target` and drops links
 * whose entry is gone. A real entry in the way is something a program made
 * here: kept, unless `replace`, where it is a sign-in's leftover (Devin's
 * login writes its logs beside the login) and gives way to the user's.
 */
async function linkEntries(target: string, source: string, own: string, replace: boolean): Promise<void> {
  await mkdir(target, { recursive: true, mode: 0o700 })
  const wanted = new Set((await readdir(source)).filter(name => name !== own))
  for (const name of await readdir(target)) {
    if (name === own) continue
    const entry = join(target, name)
    const link = await readlink(entry).catch(() => undefined)
    if (link === join(source, name) && wanted.has(name)) wanted.delete(name)
    else if (link !== undefined || (replace && wanted.has(name))) await rm(entry, { recursive: true, force: true })
    else wanted.delete(name)
  }
  for (const name of wanted)
    await symlink(join(source, name), join(target, name)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
    })
}

/**
 * Devin's sign-in asks only through a terminal and refuses when already
 * signed in, so it always runs into a fresh data folder: the account's own
 * for a new account, a renewal folder beside it for one signed in again.
 * The page shows a code to paste back rather than calling a local port.
 */
async function prepareAccountLogin({ name, renew }: AccountLoginTarget): Promise<AccountLoginLaunch> {
  const base = childProcessEnv(process.env)
  const executable = devinExecutable(base)
  if (!executable) throw new Error("Devin isn't installed. Install it, then sign in.")
  let root: string
  if (renew) {
    if (!existsSync(accountRoot(name))) throw new Error("That Devin account is gone. Refresh to see your accounts.")
    root = renewalRoot(name)
    await rm(root, { recursive: true, force: true })
    await mkdir(root, { mode: 0o700 })
  } else {
    root = accountRoot(cleanAccountName(name))
    await mkdir(join(accountsRoot(), "devin"), { recursive: true, mode: 0o700 })
    await mkdir(root, { mode: 0o700 })
    await markLoginPending(root).catch(async (error) => {
      await rm(root, { recursive: true, force: true })
      throw error
    })
  }
  const env: NodeJS.ProcessEnv = {
    ...base,
    XDG_DATA_HOME: join(root, "data"),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
  }
  for (const key of AUTH_ENV) delete env[key]
  return {
    kind: "command",
    executable,
    args: ["auth", "login", "--force-manual-token-flow"],
    env,
    paste: "code",
    pasteOnly: true,
    terminal: true,
    opensBrowser: false,
    refusedCode: /failed to exchange code/i,
  }
}

/** Devin's status command answers the same whether or not it is signed in; Devin's server is asked instead. */
async function confirmAccountLogin({ name, renew }: AccountLoginTarget): Promise<void> {
  const landed = renew ? accountCredentials(name, renewalRoot(name)) : accountCredentials(name)
  if (!existsSync(landed)) throw new Error("Devin finished, but no login was saved. Try again.")
  const status = await fetchDevinStatus(landed).catch(() => null)
  if (!status) throw new Error("Devin finished, but the login didn't check out. Try again.")
  if (renew) {
    await mkdir(join(accountRoot(name), "data", "devin"), { recursive: true, mode: 0o700 })
    await rename(landed, accountCredentials(name))
    await rm(renewalRoot(name), { recursive: true, force: true })
  }
  await chmod(accountCredentials(name), 0o600)
  if (status.email !== undefined)
    await writeFile(identityPath(name), JSON.stringify({ email: status.email }), { mode: 0o600 })
}

async function usageFor(path: string): Promise<AccountUsage> {
  try {
    const status = await devinStatus(path)
    return status?.usage ?? { status: "missing-credentials" }
  } catch (error) {
    if (error instanceof DevinStatusError && error.status === 401)
      return {
        status: "stale-token",
        detail: "Devin refused this login. Sign in again.",
      }
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export const devinAccountCapability: SelectableAccountCapability = {
  provider: "devin",
  mode: "selectable",
  nativeLogin: true,
  label: "Devin",
  loginCommand: "devin auth login",
  async listAccounts(selection) {
    const accounts = await managedAccounts(selection)
    const status = await devinStatus(credentialsPath(process.env)).catch(() => null)
    if (!status) return accounts
    const account: HarnessAccount = {
      harness: "devin",
      name: "default",
      dir: credentialsPath(process.env),
      active: !selection,
      source: "cli",
    }
    if (status.email !== undefined) account.email = status.email
    return [account, ...accounts]
  },
  accountEnv,
  prepareAccountLogin,
  confirmAccountLogin,
  abandonAccountLogin: async ({ name, renew }) => {
    if (renew) await rm(renewalRoot(name), { recursive: true, force: true })
  },
  removeAccount: async (name) => {
    if (name === "default") throw new Error("The default account is Devin's own login")
    await rm(accountRoot(name), { recursive: true, force: true })
    return {}
  },
  selectedAccount: (selection) => ({ name: selection ?? "default" }),
  credentialRevision: (name, env = process.env) =>
    credentialFileFingerprint(name === "default" ? credentialsPath(env) : accountCredentials(name)),
  accountUsage: (name) => usageFor(name === "default" ? credentialsPath(process.env) : accountCredentials(name)),
}
