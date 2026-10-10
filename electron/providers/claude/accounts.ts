import { z } from "zod"
import type { SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk"
import { claudeProbeUsage } from "./usage-probe.js"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir, userInfo } from "node:os"
import { join } from "node:path"
import type {
  AccountRemoval,
  AccountUsage,
  HarnessAccount,
  UsageBalance,
  UsageWindow,
} from "../../account-types.js"
import {
  childProcessEnv,
  loginPending,
  markLoginPending,
  managedAccountHome,
  recordAccountHome,
  credentialFingerprint,
  principalFingerprint,
  readOptionalFile,
  accountDir,
  accountsRoot,
  cleanAccountName,
  deleteKeychain,
  ensureSharedLinks,
  jsonFields,
  keychainWrittenAt,
  numberValue,
  parseUsageReset,
  readKeychain,
  stringValue,
  valueFields,
  writeKeychain,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import { orderWindows } from "../../contracts/account-usage.js"
import type { AccountLoginLaunch, AccountLoginTarget, SelectableAccountCapability } from "../account-capability.js"
import { claudeRuntime } from "./runtime.js"
import { onMac } from "../../platform.js"

/** Env vars that would override file credentials and cross accounts. */
const AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]
const ROUTING_ENV = [
  "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_SECURESTORAGE_CONFIG_DIR",
]

/** The CLI's ordinary login, whatever the shell exported: no config-dir override, token or alternate backend. */
function nativeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of [...AUTH_ENV, ...ROUTING_ENV, "CLAUDE_CONFIG_DIR"]) delete env[key]
  return env
}

/** Everything except credentials stays shared across accounts. */
const HOME = ".claude"
function defaultHome(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), HOME)
}
/** The config folder an account's sessions are kept under: the CLI's ordinary one for `default`. */
export function claudeConfigDir(account: string): string {
  return account === "default" ? join(homedir(), HOME) : accountDir("claude", account)
}
async function homeSettings(home: string): Promise<string | null> {
  try { return await readFile(join(home, "settings.json"), "utf8") }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
    throw error
  }
}
async function assertProfileSettings(home: string): Promise<void> {
  const contents = await homeSettings(home)
  const env = contents === null ? null : valueFields(jsonFields(contents).get("env"))
  if ([...AUTH_ENV, ...ROUTING_ENV, "CLAUDE_CONFIG_DIR"].some(key => stringValue(env?.get(key))))
    throw new Error("Claude home settings override this profile's authentication or backend. Remove those overrides or use the default account instead.")
}
function hasCredentials(contents: string): boolean {
  try {
    return Boolean(parseCredential(contents).accessToken)
  } catch {
    return false
  }
}

const SHARED_LINKS = [
  "projects",
  "skills",
  "agents",
  "commands",
  "plugins",
  "hooks",
  "CLAUDE.md",
  "settings.json",
  "todos",
]

function parseClaudeConfig(contents: string): string | undefined {
  const account = valueFields(jsonFields(contents).get("oauthAccount"))
  return stringValue(account?.get("emailAddress"))
}

interface ClaudeCredential {
  accessToken?: string
  /** "pro", "max", "team" — Claude writes the plan beside the token. */
  plan?: string
}

function parseCredential(contents: string): ClaudeCredential {
  const oauth = valueFields(jsonFields(contents).get("claudeAiOauth"))
  const credential: ClaudeCredential = {}
  const accessToken = stringValue(oauth?.get("accessToken"))
  const plan = stringValue(oauth?.get("subscriptionType"))
  if (accessToken !== undefined) credential.accessToken = accessToken
  if (plan !== undefined) credential.plan = plan
  return credential
}

function parseUsageWindow(
  value: JsonValue | undefined,
  windowMinutes: number,
  scope?: string
): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const used =
    numberValue(fields.get("utilization")) ??
    numberValue(fields.get("used_percentage"))
  if (used === undefined || !Number.isFinite(used)) return null
  const window: UsageWindow = {
    usedPercent: used,
    windowMinutes,
    resetsAt: parseUsageReset(fields.get("resets_at")),
  }
  if (scope !== undefined) window.scope = scope
  return window
}

/** Pay-as-you-go spend past the plan; Claude reports it in cents. */
function parseExtraUsage(value: JsonValue | undefined): UsageBalance | null {
  const fields = valueFields(value)
  if (!fields || fields.get("is_enabled") !== true) return null
  const limit = numberValue(fields.get("monthly_limit"))
  if (limit === undefined || limit <= 0) return null
  const used = numberValue(fields.get("used_credits")) ?? 0
  return {
    label: "Extra usage",
    remaining: Math.max(0, limit - used) / 100,
    total: limit / 100,
    unit: "usd",
  }
}

/** Claude's OAuth usage API; each window is its own field, null when unused. */
export function parseClaudeUsage(
  contents: string
): Extract<AccountUsage, { status: "ok" }> {
  const fields = jsonFields(contents)
  const windows = [
    parseUsageWindow(fields.get("five_hour"), 300),
    parseUsageWindow(fields.get("seven_day"), 10_080),
    parseUsageWindow(fields.get("seven_day_opus"), 10_080, "Opus"),
    parseUsageWindow(fields.get("seven_day_sonnet"), 10_080, "Sonnet"),
  ].filter((window): window is UsageWindow => window !== null)
  const usage: Extract<AccountUsage, { status: "ok" }> = {
    status: "ok",
    windows: orderWindows(windows),
  }
  const extra = parseExtraUsage(fields.get("extra_usage"))
  if (extra) usage.balances = [extra]
  return usage
}

/** The windows a streamed `rate_limit_event` can name, as `parseClaudeUsage` names them. */
function streamedWindow(type: SDKRateLimitInfo["rateLimitType"]): [number, string?] | undefined {
  switch (type) {
    case "five_hour": return [300]
    case "seven_day": return [10_080]
    case "seven_day_opus": return [10_080, "Opus"]
    case "seven_day_sonnet": return [10_080, "Sonnet"]
    default: return undefined
  }
}

/**
 * A turn's `rate_limit_event`: one window, its use as a 0–1 fraction and
 * its reset in Unix seconds. Buckets the usage reading doesn't show are left out.
 */
export function claudeRateLimitWindow(info: SDKRateLimitInfo): UsageWindow | null {
  const known = streamedWindow(info.rateLimitType)
  const utilization = info.utilization
  if (!known || utilization === undefined || !Number.isFinite(utilization)) return null
  const [windowMinutes, scope] = known
  const window: UsageWindow = {
    usedPercent: utilization * 100,
    windowMinutes,
    resetsAt: info.resetsAt ? info.resetsAt * 1000 : null,
  }
  if (scope !== undefined) window.scope = scope
  return window
}

/** Where a Claude account dir keeps its state file. */
function identityDir(dir: string): string {
  // The default "dir" is ~/.claude but .claude.json sits beside it in the
  // home; captured accounts keep the same shape inside their own root.
  return join(dir, "..")
}

async function accountEmail(dir: string): Promise<string | undefined> {
  try {
    return parseClaudeConfig(await readFile(join(dir, ".claude.json"), "utf8"))
  } catch {
    return undefined
  }
}

async function listAccounts(
  selection: string | null
): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  const home = join(homedir(), HOME)
  accounts.push({
    harness: "claude",
    name: "default",
    email: await accountEmail(identityDir(home)),
    dir: home,
    active: !selection,
    source: "cli",
    route: "native",
  })
  try {
    for (const name of await readdir(join(accountsRoot(), "claude"))) {
      if (name.startsWith(".")) continue
      const dir = accountDir("claude", name)
      if (loginPending(dir)) continue
      accounts.push({
        harness: "claude",
        name,
        email: await accountEmail(dir),
        dir,
        active: selection === name,
        source: "mako",
        route: "managed",
      })
    }
  } catch {
    // No Claude accounts added in Mako yet.
  }
  return accounts
}

/** Claude Code 2.1+ scopes its Keychain entry by the config dir it runs in. */
function scopedService(configDir: string): string {
  const suffix = createHash("sha256")
    .update(configDir.normalize("NFC"))
    .digest("hex")
    .slice(0, 8)
  return `Claude Code-credentials-${suffix}`
}

interface CredentialScope {
  dir: string
  service: string
  account: string
  scoped: boolean
}

interface CredentialSource {
  store: "keychain" | "file"
  contents: string
}

function credentialScope(env: NodeJS.ProcessEnv): CredentialScope {
  const configured = env.CLAUDE_SECURESTORAGE_CONFIG_DIR ?? env.CLAUDE_CONFIG_DIR
  const dir = (configured || join(homedir(), HOME)).normalize("NFC")
  const username = env.USER || userInfo().username
  return {
    dir,
    service: configured ? scopedService(dir) : "Claude Code-credentials",
    account: /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user",
    scoped: Boolean(configured),
  }
}

/** Follow native secure-storage precedence; a stale file must not shadow Keychain. */
async function readCredentialSource(scope: CredentialScope): Promise<CredentialSource | null> {
  const keychain = await readKeychain(scope.service, scope.account, "required")
  if (keychain !== null) return { store: "keychain", contents: keychain }
  try {
    return { store: "file", contents: await readFile(join(scope.dir, ".credentials.json"), "utf8") }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null
    throw error
  }
}

async function readCredentials(env: NodeJS.ProcessEnv): Promise<string | null> {
  return (await readCredentialSource(credentialScope(env)))?.contents ?? null
}

interface ClaudeStoreMissing {
  store: "none"
  scoped: boolean
}

interface ClaudeStoreUnreadable {
  store: "unreadable"
  scoped: boolean
}

interface ClaudeStoreHeld {
  store: "keychain" | "file"
  scoped: boolean
  access: boolean
  refresh: "present" | "empty" | "missing"
  expiresAt?: string
  refreshExpiresAt?: string
  writtenAt?: string
}

/** The store native Claude reads for this environment, described without its secrets. */
export type ClaudeCredentialState = ClaudeStoreMissing | ClaudeStoreUnreadable | ClaudeStoreHeld

export async function claudeCredentialState(env: NodeJS.ProcessEnv): Promise<ClaudeCredentialState> {
  const scope = credentialScope(env)
  let source: CredentialSource | null
  try {
    source = await readCredentialSource(scope)
  } catch {
    return { store: "unreadable", scoped: scope.scoped }
  }
  if (!source) return { store: "none", scoped: scope.scoped }
  let oauth: Map<string, JsonValue> | null = null
  try { oauth = valueFields(jsonFields(source.contents).get("claudeAiOauth")) } catch { /* Unparseable reads as signed out. */ }
  const refresh = stringValue(oauth?.get("refreshToken"))
  const state: ClaudeStoreHeld = {
    store: source.store,
    scoped: scope.scoped,
    access: Boolean(stringValue(oauth?.get("accessToken"))),
    refresh: refresh === undefined ? "missing" : refresh ? "present" : "empty",
  }
  const instant = (key: string) => {
    const value = numberValue(oauth?.get(key))
    // Claude writes 0 when it clears a store.
    return value === undefined || value <= 0 ? undefined : new Date(value).toISOString()
  }
  const expiresAt = instant("expiresAt")
  const refreshExpiresAt = instant("refreshTokenExpiresAt")
  if (expiresAt) state.expiresAt = expiresAt
  if (refreshExpiresAt) state.refreshExpiresAt = refreshExpiresAt
  if (source.store === "keychain") {
    const writtenAt = await keychainWrittenAt(scope.service, scope.account)
    if (writtenAt) state.writtenAt = writtenAt
  }
  return state
}

/**
 * Capture the CLI's current login as a named account. Credentials are copied,
 * never invented; browser OAuth remains the CLI's job.
 */
async function captureAccount(name: string): Promise<void> {
  const clean = cleanAccountName(name)
  const env = nativeEnv(process.env)
  const realHome = join(homedir(), HOME)
  await assertProfileSettings(realHome)
  const dir = accountDir("claude", clean)
  await mkdir(join(accountsRoot(), "claude"), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })
  let scopedLoginSaved = false

  try {
    // Credentials are required — an account with no keys is nothing.
    let captured = false
    const credentials = await readCredentials(env)
    if (credentials) {
      if (!hasCredentials(credentials))
        throw new Error(
          "The Claude Code login is invalid. Sign in with the CLI and capture it again."
        )
      await writeFile(join(dir, ".credentials.json"), credentials, {
        mode: 0o600,
      })
      await chmod(join(dir, ".credentials.json"), 0o600)
      await writeKeychain(scopedService(dir), credentials)
      scopedLoginSaved = onMac()
      captured = true
    }

    // The CLI's onboarding/config state is copied, not linked: it embeds
    // account state and prevents first-time setup from running again.
    const config = join(homedir(), ".claude.json")
    if (existsSync(config)) await copyFile(config, join(dir, ".claude.json"))

    if (!captured) {
      throw new Error(
        "No claude login found to capture — sign in with the CLI first"
      )
    }

    // Sessions and skills remain in the one watched store for every account.
    await recordAccountHome(dir, realHome)
    await ensureSharedLinks(realHome, dir, SHARED_LINKS)
  } catch (error) {
    if (scopedLoginSaved) await deleteKeychain(scopedService(dir))
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/**
 * The runtime's own subscription sign-in: into an empty profile, or over the
 * expired login of one Mako keeps, which Claude replaces in place.
 */
async function prepareAccountLogin({ name, renew }: AccountLoginTarget): Promise<AccountLoginLaunch> {
  const runtime = claudeRuntime()
  if (!runtime) throw new Error("Claude Code isn't installed. Install it, then sign in.")
  const command = (dir: string): AccountLoginLaunch => {
    const env = childProcessEnv(process.env)
    for (const key of [...AUTH_ENV, ...ROUTING_ENV]) delete env[key]
    env.CLAUDE_CONFIG_DIR = dir
    return {
      kind: "command",
      executable: runtime.executable,
      args: ["auth", "login", "--claudeai"],
      statusArgs: ["auth", "status"],
      env,
      paste: "code",
    }
  }
  if (renew) {
    const dir = accountDir("claude", name)
    if (!existsSync(dir)) throw new Error("That Claude Code account is gone. Refresh to see your accounts.")
    return command(dir)
  }
  const dir = accountDir("claude", cleanAccountName(name))
  const home = join(homedir(), HOME)
  await assertProfileSettings(home)
  await mkdir(join(accountsRoot(), "claude"), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })
  try {
    await markLoginPending(dir)
    await recordAccountHome(dir, home)
    await ensureSharedLinks(home, dir, SHARED_LINKS)
    return command(dir)
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
}

async function removeAccount(name: string): Promise<AccountRemoval> {
  if (name === "default")
    throw new Error("The default account is the CLI's own login")
  const dir = accountDir("claude", name)
  await deleteKeychain(scopedService(dir))
  await rm(dir, { recursive: true, force: true })
  return {}
}

async function accountEnv(
  selection: string | null,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  if (!selection) return nativeEnv(base)
  const env = nativeEnv(base)
  const dir = accountDir("claude", selection)
  if (!existsSync(dir))
    throw new Error(
      "The selected Claude Code account no longer exists. Choose another account in Settings → Agents."
    )
  env.CLAUDE_CONFIG_DIR = dir
  const credentials = await readCredentials(env)
  if (!credentials || !hasCredentials(credentials))
    throw new Error(
      "The selected Claude Code account is signed out. Sign in again in Settings → Agents."
    )
  await ensureSharedLinks(await managedAccountHome(dir, join(homedir(), HOME), "projects"), dir, SHARED_LINKS)
  await assertProfileSettings(dir)
  return env
}

async function usageForEnv(env: NodeJS.ProcessEnv): Promise<AccountUsage> {
  const raw = await readCredentials(env)
  let credential: ClaudeCredential = {}
  try {
    if (raw) credential = parseCredential(raw)
  } catch {
    // A corrupt credentials file reads as no credentials, not a crash.
  }
  const token = credential.accessToken
  if (!token) return { status: "missing-credentials" }
  let usage = await claudeOAuthUsage(token, "Claude Code")
  // The stored token expired since Claude last ran; Claude refreshes its own.
  if (usage.status === "stale-token")
    usage = (await claudeProbeUsage(childProcessEnv(env), parseClaudeUsage)) ?? usage
  return usage.plan === undefined && credential.plan !== undefined
    ? { ...usage, plan: credential.plan }
    : usage
}

/** Claude's usage API for any Claude subscription token, OpenCode's included. */
export async function claudeOAuthUsage(
  token: string,
  harnessLabel: string
): Promise<AccountUsage> {
  try {
    const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "User-Agent": "claude-code/2.1.0",
      },
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) {
      // Claude rotates the token itself; this is a wait, not a failure.
      return {
        status: "stale-token",
        detail: `Usage returns after this account’s next ${harnessLabel} run`,
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    return parseClaudeUsage(await response.text())
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function usageEnv(name: string, base: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const env = nativeEnv(base)
  if (name !== "default") env.CLAUDE_CONFIG_DIR = accountDir("claude", name)
  return env
}

async function accountUsage(name: string): Promise<AccountUsage> {
  return usageForEnv(await usageEnv(name))
}

export const claudeAccountCapability: SelectableAccountCapability = {
  provider: "claude",
  mode: "selectable",
  nativeLogin: true,
  label: "Claude Code",
  loginCommand: "claude auth login",
  listAccounts,
  captureAccount,
  prepareAccountLogin,
  removeAccount,
  accountEnv,
  selectedAccount: (selection, env) =>
    ({ name: selection ?? "default", dir: defaultHome(env) }),
  accountUsage,
  credentialRevision: async (name, base = process.env) => {
    const env = await usageEnv(name, base)
    const state = await readOptionalFile(env.CLAUDE_CONFIG_DIR ? join(env.CLAUDE_CONFIG_DIR, ".claude.json") : join(homedir(), ".claude.json"))
    return credentialFingerprint([defaultHome(env), env.USER ?? null,
      principalFingerprint(await readCredentials(env), ClaudePrincipal),
      principalFingerprint(state, ClaudeAccount),
      await homeSettings(defaultHome(env))])
  },
}

/**
 * Claude rewrites its OAuth tokens and their expiry on every refresh, and keeps
 * MCP servers' tokens beside them; who signed in is in its state file.
 */
const ClaudePrincipal = z.object({
  claudeAiOauth: z.object({ subscriptionType: z.string().nullable().optional(), scopes: z.array(z.string()).optional() }).optional(),
})
const ClaudeAccount = z.object({
  oauthAccount: z.object({ accountUuid: z.string().optional(), organizationUuid: z.string().optional() }).optional(),
})
