import { existsSync } from "node:fs"
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  AccountUsage,
  ClassifiedUsageWindows,
  HarnessAccount,
  UsageWindow,
} from "../../account-types.js"
import {
  accountDir,
  accountsRoot,
  cleanAccountName,
  ensureSharedLinks,
  jsonFields,
  jwtClaims,
  numberValue,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { SelectableAccountCapability } from "../account-capability.js"

/** Env vars that would override file credentials and cross accounts. */
const AUTH_ENV = ["OPENAI_API_KEY"]

/** Everything except credentials stays shared across accounts. */
const HOME = ".codex"
function defaultHome(env: NodeJS.ProcessEnv = process.env) {
  return env.CODEX_HOME || join(homedir(), HOME)
}
function hasCredentials(contents: string): boolean {
  try {
    const fields = jsonFields(contents)
    return Boolean(
      stringValue(fields.get("OPENAI_API_KEY")) ||
      parseCodexAuth(contents).accessToken
    )
  } catch {
    return false
  }
}

/** An account's own entries in its Codex home; every other entry links to the real home. */
function isPrivateEntry(name: string): boolean {
  return (
    name.startsWith("auth.json") ||
    ["models_cache.json", "log", "memories", "tmp"].includes(name)
  )
}
/**
 * Codex creates these on first use, which inside an account would split them
 * from the watched store: an archive would move its rollout out of Mako's
 * sight and a rename would land in the account's own log.
 */
const SHARED_DIRECTORIES = ["sessions", "archived_sessions"]
const NAME_LOG = "session_index.jsonl"

/** Links an account's Codex home to the real one, adopting what it archived or named on its own. */
async function shareHome(realHome: string, dir: string): Promise<void> {
  await Promise.all(
    SHARED_DIRECTORIES.map((name) =>
      mkdir(join(realHome, name), { recursive: true })
    )
  )
  await appendFile(join(realHome, NAME_LOG), "")
  await adoptArchive(realHome, dir)
  await adoptNameLog(realHome, dir)
  const entries = await readdir(realHome)
  await ensureSharedLinks(
    realHome,
    dir,
    entries.filter((name) => !isPrivateEntry(name))
  )
}

/** A rollout archived while the account's own folder stood keeps it until the next launch. */
async function adoptArchive(realHome: string, dir: string): Promise<void> {
  const own = join(dir, "archived_sessions")
  if (!(await lstat(own).catch(() => null))?.isDirectory()) return
  const shared = join(realHome, "archived_sessions")
  for (const name of await readdir(own)) {
    if (!existsSync(join(shared, name)))
      await rename(join(own, name), join(shared, name))
  }
  await rmdir(own).catch(() => {})
}

/** Appends only the names the real log lacks or holds older, so adopting twice adds nothing. */
async function adoptNameLog(realHome: string, dir: string): Promise<void> {
  const own = join(dir, NAME_LOG)
  if (!(await lstat(own).catch(() => null))?.isFile()) return
  const shared = join(realHome, NAME_LOG)
  const named = (line: string) => {
    try {
      const fields = jsonFields(line)
      const id = stringValue(fields.get("id"))
      const at = Date.parse(stringValue(fields.get("updated_at")) ?? "")
      return id && !Number.isNaN(at) ? { id, at } : undefined
    } catch {
      return undefined
    }
  }
  const latest = new Map<string, number>()
  for (const line of (await readFile(shared, "utf8")).split("\n")) {
    const entry = named(line)
    if (entry && entry.at > (latest.get(entry.id) ?? -Infinity))
      latest.set(entry.id, entry.at)
  }
  const newer = (await readFile(own, "utf8")).split("\n").filter((line) => {
    const entry = named(line)
    return entry && entry.at > (latest.get(entry.id) ?? -Infinity)
  })
  if (newer.length) await appendFile(shared, `${newer.join("\n")}\n`)
  const link = `${own}.link`
  await rm(link, { force: true })
  await symlink(shared, link)
  await rename(link, own)
}

interface CodexAuth {
  idToken?: string
  accessToken?: string
  accountId?: string
}

interface RouterAccount {
  auth: CodexAuth
  authJson: string
}

interface CodexUsageResponse {
  plan?: string
  windows: UsageWindow[]
}

function parseCodexAuthValue(value: JsonValue | undefined): CodexAuth {
  const tokens = valueFields(valueFields(value)?.get("tokens"))
  if (!tokens) return {}
  const idToken = stringValue(tokens.get("id_token"))
  const accessToken = stringValue(tokens.get("access_token"))
  const accountId = stringValue(tokens.get("account_id"))
  const auth: CodexAuth = {}
  if (idToken !== undefined) auth.idToken = idToken
  if (accessToken !== undefined) auth.accessToken = accessToken
  if (accountId !== undefined) auth.accountId = accountId
  return auth
}

function parseCodexAuth(contents: string): CodexAuth {
  const value: JsonValue = JSON.parse(contents)
  return parseCodexAuthValue(value)
}

function parseRouterAccount(contents: string): RouterAccount {
  const fields = jsonFields(contents)
  const authValue = fields.get("auth")
  const authFields = valueFields(authValue)
  return {
    auth: parseCodexAuthValue(authValue),
    authJson: authFields
      ? JSON.stringify(Object.fromEntries(authFields))
      : "{}",
  }
}

function parseBackendWindow(value: JsonValue | undefined): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const usedPercent = numberValue(fields.get("used_percent"))
  if (usedPercent === undefined) return null
  const windowSeconds = numberValue(fields.get("limit_window_seconds")) ?? 0
  const resetSeconds = numberValue(fields.get("reset_after_seconds"))
  return {
    usedPercent,
    windowMinutes: Math.round(windowSeconds / 60),
    resetsAt:
      resetSeconds === undefined ? null : Date.now() + resetSeconds * 1000,
  }
}

function parseUsageResponse(contents: string): CodexUsageResponse {
  const fields = jsonFields(contents)
  const rateLimit = valueFields(fields.get("rate_limit"))
  const windows = [
    parseBackendWindow(rateLimit?.get("primary_window")),
    parseBackendWindow(rateLimit?.get("secondary_window")),
  ]
    .filter((entry): entry is UsageWindow => entry !== null)
    .sort((a, b) => a.windowMinutes - b.windowMinutes)
  const plan = stringValue(fields.get("plan_type"))
  return plan === undefined ? { windows } : { plan, windows }
}

export function classifyCodexWindows(
  windows: UsageWindow[]
): ClassifiedUsageWindows {
  const session =
    windows.find((window) => window.windowMinutes <= 24 * 60) ?? null
  const weekly =
    [...windows].reverse().find((window) => window.windowMinutes > 24 * 60) ??
    null
  return { session, weekly }
}

async function accountEmail(dir: string): Promise<string | undefined> {
  try {
    const auth = parseCodexAuth(await readFile(join(dir, "auth.json"), "utf8"))
    return jwtClaims(auth.idToken).email
  } catch {
    return undefined
  }
}

/**
 * Subrouter keeps Codex logins as <router>/accounts/<email>.json. Those files
 * contain tokens only; selecting one materializes an isolated Codex home.
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
      for (const file of await readdir(join(root, router, "accounts"))) {
        if (!file.endsWith(".json")) continue
        const email = file.slice(0, -".json".length)
        accounts.push({
          harness: "codex",
          name: email,
          email,
          dir: join(root, router, "accounts", file),
          active: false,
          source: "subrouter",
        })
      }
    } catch {
      // This router has no Codex accounts.
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
    harness: "codex",
    name: "default",
    email: await accountEmail(defaultDir),
    dir: defaultDir,
    active: !selection,
  })
  try {
    for (const name of await readdir(join(accountsRoot(), "codex"))) {
      if (name.startsWith(".")) continue
      const dir = accountDir("codex", name)
      accounts.push({
        harness: "codex",
        name,
        email: await accountEmail(dir),
        dir,
        active: selection === name,
      })
    }
  } catch {
    // No captured Codex accounts yet.
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

/**
 * Capture the CLI's current login as a named account. Credentials are copied,
 * never invented; browser OAuth remains the CLI's job.
 */
async function captureAccount(name: string): Promise<void> {
  const clean = cleanAccountName(name)
  const realHome = defaultHome()
  const dir = accountDir("codex", clean)
  await mkdir(join(accountsRoot(), "codex"), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })

  try {
    // Credentials are required — an account with no keys is nothing.
    const source = join(realHome, "auth.json")
    if (!existsSync(source)) {
      throw new Error(
        "No codex login found to capture — sign in with the CLI first"
      )
    }
    const credentials = await readFile(source, "utf8")
    if (!hasCredentials(credentials))
      throw new Error(
        "The Codex login is missing or invalid. Sign in with the CLI and capture it again."
      )
    await writeFile(join(dir, "auth.json"), credentials, { mode: 0o600 })
    await chmod(join(dir, "auth.json"), 0o600)

    // Sessions, archives and names remain in the one watched store for every account.
    await shareHome(realHome, dir)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

async function removeAccount(name: string): Promise<void> {
  if (name === "default")
    throw new Error("The default account is the CLI's own login")
  await rm(accountDir("codex", name), { recursive: true, force: true })
}

async function accountEnv(
  selection: string | null,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  if (!selection) return env
  for (const key of AUTH_ENV) delete env[key]

  let dir = accountDir("codex", selection)
  if (!existsSync(dir)) {
    // A router account file materializes into a Mako home once, then routes
    // like any captured account with its home shared.
    const routed = (await subrouterAccounts()).find(
      (account) => account.name === selection
    )
    if (routed) {
      dir = accountDir("codex", selection)
      if (!existsSync(join(dir, "auth.json"))) {
        try {
          const account = parseRouterAccount(await readFile(routed.dir, "utf8"))
          await mkdir(dir, { recursive: true, mode: 0o700 })
          await writeFile(join(dir, "auth.json"), account.authJson, {
            encoding: "utf8",
            mode: 0o600,
          })
          await chmod(join(dir, "auth.json"), 0o600)
        } catch {
          throw new Error(
            "The selected Codex account could not be loaded. Select another account or capture it again."
          )
        }
      }
    }
  }
  if (!existsSync(join(dir, "auth.json")))
    throw new Error(
      "The selected Codex account has no credentials. Select another account or capture it again."
    )
  if (!hasCredentials(await readFile(join(dir, "auth.json"), "utf8")))
    throw new Error(
      "The selected Codex account has invalid credentials. Sign in with the CLI and capture it again."
    )
  await shareHome(defaultHome(base), dir)
  env.CODEX_HOME = dir
  return env
}

async function chatGptUsage(
  accessToken: string,
  accountId: string | undefined
): Promise<AccountUsage> {
  try {
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    if (accountId) headers.set("ChatGPT-Account-Id", accountId)
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401) {
      return {
        status: "stale-token",
        detail: "Refreshes the next time Codex runs",
      }
    }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    // Codex names windows by position, not duration; sort by length so
    // "session" is always the shorter one whatever the backend calls it.
    const usage = parseUsageResponse(await response.text())
    const windows = classifyCodexWindows(usage.windows)
    return {
      status: "ok",
      plan: usage.plan,
      session: windows.session,
      weekly: windows.weekly,
    }
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

async function usageForDir(dir: string): Promise<AccountUsage> {
  let auth: CodexAuth
  try {
    if (dir.endsWith(".json")) {
      // A router file wraps the same tokens in {email, auth: {tokens}}.
      auth = parseRouterAccount(await readFile(dir, "utf8")).auth
    } else {
      auth = parseCodexAuth(await readFile(join(dir, "auth.json"), "utf8"))
    }
  } catch {
    return { status: "missing-credentials" }
  }
  if (!auth.accessToken) return { status: "missing-credentials" }
  return chatGptUsage(auth.accessToken, auth.accountId)
}

async function accountUsage(name: string): Promise<AccountUsage> {
  // Router-managed accounts resolve by identity, not by a Mako-owned dir.
  const routed = (await subrouterAccounts()).find(
    (account) => account.name === name
  )
  const dir =
    routed?.dir ??
    (name === "default" ? defaultHome() : accountDir("codex", name))
  return usageForDir(dir)
}

export const codexAccountCapability: SelectableAccountCapability = {
  provider: "codex",
  mode: "selectable",
  label: "Codex",
  loginCommand: "codex login",
  listAccounts,
  captureAccount,
  removeAccount,
  accountEnv,
  selectedAccount: (selection, env) =>
    selection && env.CODEX_HOME
      ? { name: selection, dir: env.CODEX_HOME }
      : { name: "default" },
  accountUsage,
}
