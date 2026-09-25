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
  AccountUsage,
  HarnessAccount,
  UsageWindow,
} from "../../account-types.js"
import {
  accountDir,
  accountsRoot,
  cleanAccountName,
  deleteKeychain,
  ensureSharedLinks,
  jsonFields,
  numberValue,
  parseUsageReset,
  readKeychain,
  stringValue,
  valueFields,
  writeKeychain,
} from "../../accounts-common.js"
import type { SelectableAccountCapability } from "../account-capability.js"

/** Env vars that would override file credentials and cross accounts. */
const AUTH_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
]

/** Everything except credentials stays shared across accounts. */
const HOME = ".claude"
function defaultHome(env: NodeJS.ProcessEnv = process.env) {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), HOME)
}
function hasCredentials(contents: string): boolean {
  try {
    return Boolean(parseAccessToken(contents))
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

interface RouterProfile {
  email: string
  dir: string
}

interface ClaudeUsageResponse {
  session: UsageWindow | null
  weekly: UsageWindow | null
}

function parseClaudeConfig(contents: string): string | undefined {
  const account = valueFields(jsonFields(contents).get("oauthAccount"))
  return stringValue(account?.get("emailAddress"))
}

function parseRouterProfiles(contents: string): RouterProfile[] {
  const profiles = valueFields(jsonFields(contents).get("profiles"))
  if (!profiles) return []
  const parsed: RouterProfile[] = []
  for (const [email, value] of profiles) {
    const dir = stringValue(valueFields(value)?.get("dir"))
    if (dir !== undefined) parsed.push({ email, dir })
  }
  return parsed
}

function parseAccessToken(contents: string): string | undefined {
  const oauth = valueFields(jsonFields(contents).get("claudeAiOauth"))
  return stringValue(oauth?.get("accessToken"))
}

function parseUsageWindow(
  value: Parameters<typeof valueFields>[0],
  windowMinutes: number
): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const used =
    numberValue(fields.get("utilization")) ??
    numberValue(fields.get("used_percentage"))
  if (used === undefined || !Number.isFinite(used)) return null
  return {
    usedPercent: used,
    windowMinutes,
    resetsAt: parseUsageReset(fields.get("resets_at")),
  }
}

function parseUsageResponse(contents: string): ClaudeUsageResponse {
  const fields = jsonFields(contents)
  return {
    session: parseUsageWindow(fields.get("five_hour"), 300),
    weekly: parseUsageWindow(fields.get("seven_day"), 10_080),
  }
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

/**
 * Accounts a router already manages. Subrouter keeps Claude profiles in
 * <router>/claude.json, each with its own directly usable config dir.
 */
async function subrouterAccounts(): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  const root = join(homedir(), ".subrouter")
  let routers: string[]
  try {
    routers = (await readdir(root)).filter(
      (name) => !name.startsWith(".") && !name.includes(".")
    )
  } catch {
    return accounts
  }
  for (const router of routers) {
    try {
      const profiles = parseRouterProfiles(
        await readFile(join(root, router, "claude.json"), "utf8")
      )
      for (const profile of profiles) {
        accounts.push({
          harness: "claude",
          name: profile.email,
          email: profile.email,
          dir: join(root, router, "claude", profile.dir),
          active: false,
          source: "subrouter",
        })
      }
    } catch {
      // This router has no Claude profiles.
    }
  }
  return accounts
}

async function listAccounts(
  selection: string | null
): Promise<HarnessAccount[]> {
  const accounts: HarnessAccount[] = []
  const defaultDir = defaultHome()
  accounts.push({
    harness: "claude",
    name: "default",
    email: await accountEmail(identityDir(defaultDir)),
    dir: defaultDir,
    active: !selection,
  })
  try {
    for (const name of await readdir(join(accountsRoot(), "claude"))) {
      if (name.startsWith(".")) continue
      const dir = accountDir("claude", name)
      accounts.push({
        harness: "claude",
        name,
        email: await accountEmail(dir),
        dir,
        active: selection === name,
      })
    }
  } catch {
    // No captured Claude accounts yet.
  }

  // Router-managed logins ride along, deduped by identity against what Mako
  // captured itself.
  const known = new Set(
    accounts.map((account) => account.email ?? account.name)
  )
  for (const account of await subrouterAccounts()) {
    if (!known.has(account.email ?? account.name)) accounts.push(account)
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

/** Follow native secure-storage precedence; a stale file must not shadow Keychain. */
async function readCredentials(env: NodeJS.ProcessEnv): Promise<string | null> {
  const override = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const configured = override ?? env.CLAUDE_CONFIG_DIR
  const dir = (configured || join(homedir(), HOME)).normalize("NFC")
  const username = env.USER || userInfo().username
  const account = /^[a-zA-Z0-9._-]+$/.test(username) ? username : "claude-code-user"
  const keychain = await readKeychain(
    configured ? scopedService(dir) : "Claude Code-credentials",
    account
  )
  if (keychain !== null) return keychain
  try {
    return await readFile(join(dir, ".credentials.json"), "utf8")
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null
    throw error
  }
}

/**
 * Capture the CLI's current login as a named account. Credentials are copied,
 * never invented; browser OAuth remains the CLI's job.
 */
async function captureAccount(name: string): Promise<void> {
  const clean = cleanAccountName(name)
  const realHome = defaultHome()
  const dir = accountDir("claude", clean)
  await mkdir(join(accountsRoot(), "claude"), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })
  let scopedLoginSaved = false

  try {
    // Credentials are required — an account with no keys is nothing.
    let captured = false
    const credentials = await readCredentials(process.env)
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
      scopedLoginSaved = process.platform === "darwin"
      captured = true
    }

    // The CLI's onboarding/config state is copied, not linked: it embeds
    // account state and prevents first-time setup from running again.
    const config = process.env.CLAUDE_CONFIG_DIR
      ? join(realHome, ".claude.json")
      : join(homedir(), ".claude.json")
    if (existsSync(config)) await copyFile(config, join(dir, ".claude.json"))

    if (!captured) {
      throw new Error(
        "No claude login found to capture — sign in with the CLI first"
      )
    }

    // Sessions and skills remain in the one watched store for every account.
    await ensureSharedLinks(realHome, dir, SHARED_LINKS)
  } catch (error) {
    if (scopedLoginSaved) await deleteKeychain(scopedService(dir))
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

async function removeAccount(name: string): Promise<void> {
  if (name === "default")
    throw new Error("The default account is the CLI's own login")
  const dir = accountDir("claude", name)
  await deleteKeychain(scopedService(dir))
  await rm(dir, { recursive: true, force: true })
}

async function accountEnv(
  selection: string | null,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  if (!selection) return env
  for (const key of AUTH_ENV) delete env[key]

  let dir = accountDir("claude", selection)
  if (!existsSync(dir)) {
    // Router profiles are real config homes and route directly.
    const routed = (await subrouterAccounts()).find(
      (account) => account.name === selection
    )
    if (routed) dir = routed.dir
  }
  if (!existsSync(dir))
    throw new Error(
      "The selected Claude Code account no longer exists. Select another account or capture it again."
    )
  // An explicit account owns its credential home, including secure storage.
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  env.CLAUDE_CONFIG_DIR = dir
  const credentials = await readCredentials(env)
  if (!credentials || !hasCredentials(credentials))
    throw new Error(
      "The selected Claude Code account has no valid credentials. Sign in with the CLI and capture it again."
    )
  await ensureSharedLinks(defaultHome(base), dir, SHARED_LINKS)
  return env
}

async function usageForEnv(env: NodeJS.ProcessEnv): Promise<AccountUsage> {
  const raw = await readCredentials(env)
  let token: string | null = null
  try {
    token = raw ? (parseAccessToken(raw) ?? null) : null
  } catch {
    // A corrupt credentials file reads as no credentials, not a crash.
  }
  if (!token) return { status: "missing-credentials" }
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
        detail: "Refreshes the next time Claude Code runs",
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    const usage = parseUsageResponse(await response.text())
    return { status: "ok", session: usage.session, weekly: usage.weekly }
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function accountUsage(name: string): Promise<AccountUsage> {
  if (name === "default") return usageForEnv(process.env)
  // Use the same captured-before-router precedence as native launches.
  const routed = (await subrouterAccounts()).find(
    (account) => account.name === name
  )
  const captured = accountDir("claude", name)
  const dir = existsSync(captured) ? captured : routed?.dir ?? captured
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: dir }
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  return usageForEnv(env)
}

export const claudeAccountCapability: SelectableAccountCapability = {
  provider: "claude",
  mode: "selectable",
  label: "Claude Code",
  loginCommand: "claude /login",
  listAccounts,
  captureAccount,
  removeAccount,
  accountEnv,
  selectedAccount: (selection, env) =>
    selection && env.CLAUDE_CONFIG_DIR
      ? { name: selection, dir: env.CLAUDE_CONFIG_DIR }
      : { name: "default" },
  accountUsage,
}
