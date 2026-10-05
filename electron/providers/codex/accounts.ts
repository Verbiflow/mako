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
import type { AccountRemoval, AccountUsage, HarnessAccount, ResetCreditOutcome } from "../../account-types.js"
import {
  credentialFingerprint,
  loginPending,
  markLoginPending,
  managedAccountHome,
  recordAccountHome,
  accountDir,
  accountsRoot,
  childProcessEnv,
  cleanAccountName,
  ensureSharedLinks,
  jsonFields,
  jwtClaims,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { AccountLoginLaunch, AccountLoginTarget, SelectableAccountCapability } from "../account-capability.js"
import { chatGptUsage } from "../chatgpt-usage.js"
import { rpcRequest, withDiscoveryRpc } from "../profile-transport.js"
import { resolveCodexExecutable } from "./executable.js"
import { parseCodexRateLimits, parseResetOutcome } from "./rate-limits.js"
import { managedCodexConfig, readCodexCredentials } from "./credentials.js"

/** Env vars that would override file credentials and cross accounts. */
const AUTH_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"]
const ROUTING_ENV = ["OPENAI_BASE_URL"]
function nativeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...base }
  for (const key of [...AUTH_ENV, ...ROUTING_ENV, "CODEX_HOME"]) delete env[key]
  return env
}

/** Settings and stores retain their origin; auth and its storage policy stay private. */
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
    [".mako-account.json", "config.toml", "models_cache.json", "log", "memories", "tmp"].includes(name)
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

async function accountEmail(dir: string): Promise<string | undefined> {
  try {
    const credentials = await readCodexCredentials(dir)
    const auth = credentials ? parseCodexAuth(credentials) : {}
    return jwtClaims(auth.idToken).email
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
    harness: "codex",
    name: "default",
    email: await accountEmail(home),
    dir: home,
    active: !selection,
    source: "cli",
    route: "native",
  })
  try {
    for (const name of await readdir(join(accountsRoot(), "codex"))) {
      if (name.startsWith(".")) continue
      const dir = accountDir("codex", name)
      if (loginPending(dir)) continue
      accounts.push({
        harness: "codex",
        name,
        email: await accountEmail(dir),
        dir,
        active: selection === name,
        source: "mako",
        route: "managed",
      })
    }
  } catch {
    // No Codex accounts added in Mako yet.
  }
  return accounts
}

/**
 * Capture the CLI's current login as a named account. Credentials are copied,
 * never invented; browser OAuth remains the CLI's job.
 */
async function captureAccount(name: string): Promise<void> {
  const clean = cleanAccountName(name)
  const realHome = join(homedir(), HOME)
  const dir = accountDir("codex", clean)
  await mkdir(join(accountsRoot(), "codex"), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })

  try {
    // Credentials are required — an account with no keys is nothing.
    const credentials = await readCodexCredentials(realHome)
    if (!credentials) {
      throw new Error(
        "No codex login found to capture — sign in with the CLI first"
      )
    }
    if (!hasCredentials(credentials))
      throw new Error(
        "The Codex login is missing or invalid. Sign in with the CLI and capture it again."
      )
    await writeFile(join(dir, "auth.json"), credentials, { mode: 0o600 })
    await chmod(join(dir, "auth.json"), 0o600)

    // Sessions, archives and names remain in the one watched store for every account.
    await recordAccountHome(dir, realHome)
    await managedCodexConfig(realHome, dir, Boolean(parseCodexAuth(credentials).accessToken))
    await shareHome(realHome, dir)
  } catch (error) {
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

/**
 * Codex's ChatGPT sign-in into a profile whose private config keeps auth in
 * its own file: a new empty one, or one Mako keeps whose login expired,
 * which Codex replaces in place.
 */
async function prepareAccountLogin({ name, renew }: AccountLoginTarget): Promise<AccountLoginLaunch> {
  const executable = await resolveCodexExecutable()
  if (!executable) throw new Error("Codex isn't installed. Install it, then sign in.")
  const command = (dir: string): AccountLoginLaunch => {
    const env = childProcessEnv(process.env)
    for (const key of [...AUTH_ENV, ...ROUTING_ENV]) delete env[key]
    env.CODEX_HOME = dir
    return { kind: "command", executable, args: ["login"], statusArgs: ["login", "status"], env }
  }
  if (renew) {
    const dir = accountDir("codex", name)
    if (!existsSync(dir)) throw new Error("That Codex account is gone. Refresh to see your accounts.")
    await managedCodexConfig(await managedAccountHome(dir, join(homedir(), HOME), "sessions"), dir, true)
    return command(dir)
  }
  const dir = accountDir("codex", cleanAccountName(name))
  const home = join(homedir(), HOME)
  await mkdir(join(accountsRoot(), "codex"), { recursive: true, mode: 0o700 })
  await mkdir(dir, { mode: 0o700 })
  try {
    await markLoginPending(dir)
    await recordAccountHome(dir, home)
    await managedCodexConfig(home, dir, true)
    await shareHome(home, dir)
    return command(dir)
  } catch (error) { await rm(dir, { recursive: true, force: true }); throw error }
}

async function removeAccount(name: string): Promise<AccountRemoval> {
  if (name === "default")
    throw new Error("The default account is the CLI's own login")
  await rm(accountDir("codex", name), { recursive: true, force: true })
  return {}
}

async function accountEnv(
  selection: string | null,
  base: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const env = nativeEnv(base)
  if (!selection) return env
  const dir = accountDir("codex", selection)
  if (!existsSync(dir))
    throw new Error(
      "The selected Codex account no longer exists. Choose another account in Settings → Agents."
    )
  if (!existsSync(join(dir, "auth.json")))
    throw new Error(
      "The selected Codex account is signed out. Sign in again in Settings → Agents."
    )
  const credentials = await readFile(join(dir, "auth.json"), "utf8")
  if (!hasCredentials(credentials))
    throw new Error(
      "The selected Codex account's login is unreadable. Sign in again in Settings → Agents."
    )
  const home = await managedAccountHome(dir, join(homedir(), HOME), "sessions")
  await managedCodexConfig(home, dir, Boolean(parseCodexAuth(credentials).accessToken))
  await shareHome(home, dir)
  env.CODEX_HOME = dir
  return env
}

async function usageForDir(dir: string): Promise<AccountUsage> {
  let auth: CodexAuth
  try {
    const credentials = await readCodexCredentials(dir)
    auth = credentials ? parseCodexAuth(credentials) : {}
  } catch {
    return { status: "missing-credentials" }
  }
  if (!auth.accessToken) return { status: "missing-credentials" }
  return chatGptUsage(auth.accessToken, auth.accountId, "Codex")
}

/**
 * Codex answers for itself: its app-server reads the limits and reset
 * credits under the account's own home and refreshes the sign-in to do it.
 * The usage endpoint with the stored token covers a Codex that can't start.
 */
async function accountUsage(name: string): Promise<AccountUsage> {
  const fromCodex = await codexAppServerUsage(name).catch(() => null)
  if (fromCodex?.status === "ok") return fromCodex
  return usageForDir(name === "default" ? join(homedir(), HOME) : accountDir("codex", name))
}

async function codexAppServerUsage(name: string): Promise<AccountUsage | null> {
  const env = await accountEnv(name === "default" ? null : name, childProcessEnv(process.env))
  const executable = await resolveCodexExecutable(env)
  if (!executable) return null
  return parseCodexRateLimits(await rpcRequest(executable, ["app-server"], "account/rateLimits/read", env, false))
}

/**
 * Spend one of the account's reset credits through Codex itself. Codex
 * keys the spend on `attempt`, so the same attempt after a lost answer
 * spends nothing more, and it spends nothing when no window needs it.
 */
async function useResetCredit(name: string, attempt: string): Promise<ResetCreditOutcome> {
  const env = await accountEnv(name === "default" ? null : name, childProcessEnv(process.env))
  const executable = await resolveCodexExecutable(env)
  if (!executable) throw new Error("Codex is not installed")
  const answer = await withDiscoveryRpc(
    { command: executable, args: ["app-server"], env, jsonrpc: false, priority: "launch" },
    (rpc) => rpc.request("account/rateLimitResetCredit/consume", { idempotencyKey: attempt })
  )
  const outcome = parseResetOutcome(answer)
  if (!outcome)
    throw new Error("Codex answered in a way Mako doesn't know. Check the account's limits before trying again.")
  return outcome
}

export const codexAccountCapability: SelectableAccountCapability = {
  provider: "codex",
  mode: "selectable",
  nativeLogin: true,
  label: "Codex",
  loginCommand: "codex login",
  listAccounts,
  captureAccount,
  prepareAccountLogin,
  removeAccount,
  accountEnv,
  selectedAccount: (selection, env) =>
    ({ name: selection ?? "default", dir: defaultHome(env) }),
  accountUsage,
  credentialRevision: async (name) => {
    const home = name === "default" ? join(homedir(), HOME) : null
    const raw = home
      ? await readCodexCredentials(home)
      : await readFile(join(accountDir("codex", name), "auth.json"), "utf8").catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
        throw error
      })
    return credentialFingerprint([home, raw])
  },
  useResetCredit,
}
