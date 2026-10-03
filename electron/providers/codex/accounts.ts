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
import type { AccountUsage, HarnessAccount, ResetCreditOutcome } from "../../account-types.js"
import {
  credentialFingerprint,
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
import type { SelectableAccountCapability } from "../account-capability.js"
import { chatGptUsage } from "../chatgpt-usage.js"
import { rpcRequest, withDiscoveryRpc } from "../profile-transport.js"
import { resolveCodexExecutable } from "./executable.js"
import { parseCodexRateLimits, parseResetOutcome } from "./rate-limits.js"

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
  // Router-managed accounts resolve by identity, not by a Mako-owned dir.
  const routed = (await subrouterAccounts()).find(
    (account) => account.name === name
  )
  const captured = accountDir("codex", name)
  const dir = name === "default" ? defaultHome()
    : existsSync(join(captured, "auth.json")) ? captured : routed?.dir ?? captured
  return usageForDir(dir)
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
  credentialRevision: async (name) => {
    const captured = accountDir("codex", name)
    const routed = (await subrouterAccounts()).find((account) => account.name === name)
    const source = name === "default" ? join(defaultHome(), "auth.json")
      : existsSync(join(captured, "auth.json")) ? join(captured, "auth.json") : routed?.dir ?? join(captured, "auth.json")
    const raw = await readFile(source, "utf8").catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
      throw error
    })
    return credentialFingerprint([raw, name === "default" ? process.env.OPENAI_API_KEY ?? null : null])
  },
  useResetCredit,
}
