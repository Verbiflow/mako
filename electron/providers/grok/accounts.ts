import { existsSync } from "node:fs"
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { z } from "zod"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
} from "@agentclientprotocol/sdk"
import type {
  AccountUsage,
  HarnessAccount,
  UsageWindow,
} from "../../account-types.js"
import {
  accountDir,
  accountsRoot,
  cleanAccountName,
  credentialFileFingerprint,
  childProcessEnv,
  jsonFields,
  loginPending,
  markLoginPending,
  parseUsageReset,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import { acpReadable, acpWritable } from "../../acp-stream.js"
import type { JsonValue } from "../../codex-app-json.js"
import { resolveExecutable } from "../../executable.js"
import type { AccountLoginLaunch, AccountLoginTarget, SelectableAccountCapability } from "../account-capability.js"
import { withDiscoveryProcess } from "../discovery-process.js"

function authPath(env: NodeJS.ProcessEnv): string {
  return (
    env.GROK_AUTH_PATH ??
    join(env.GROK_HOME ?? join(homedir(), ".grok"), "auth.json")
  )
}

/**
 * Grok keys its auth file by issuer and client; each entry carries the
 * signed-in email beside the token. Only the public identity is read.
 */
export function parseGrokAccounts(
  contents: string,
  path: string
): HarnessAccount[] {
  for (const [, value] of jsonFields(contents)) {
    const email = stringValue(valueFields(value)?.get("email"))
    if (email === undefined) continue
    return [
      {
        harness: "grok",
        name: "default",
        email,
        dir: path,
        active: true,
        source: "cli",
      },
    ]
  }
  return []
}

const BillingSchema = z.object({
  subscription_tier: z.string().optional(),
  config: z
    .object({
      creditUsagePercent: z.number().optional(),
      currentPeriod: z
        .object({ start: z.string().optional(), end: z.string().optional() })
        .optional(),
      billingPeriodStart: z.string().optional(),
      billingPeriodEnd: z.string().optional(),
    })
    .optional(),
})

/**
 * `_x.ai/billing`: one credit percentage over the current usage period,
 * weekly on today's subscriptions. The on-demand and prepaid amounts carry
 * no unit, so they stay unread until one is confirmed.
 */
export function parseGrokBilling(
  value: JsonValue
): Extract<AccountUsage, { status: "ok" }> {
  const billing = BillingSchema.parse(value)
  const config = billing.config
  const used = config?.creditUsagePercent
  const start = parseUsageReset(
    config?.currentPeriod?.start ?? config?.billingPeriodStart
  )
  const end = parseUsageReset(
    config?.currentPeriod?.end ?? config?.billingPeriodEnd
  )
  const windows: UsageWindow[] =
    used === undefined
      ? []
      : [
          {
            usedPercent: used,
            windowMinutes:
              start !== null && end !== null && end > start
                ? Math.round((end - start) / 60_000)
                : 0,
            resetsAt: end,
          },
        ]
  const usage: Extract<AccountUsage, { status: "ok" }> = {
    status: "ok",
    windows,
  }
  if (billing.subscription_tier !== undefined)
    usage.plan = billing.subscription_tier
  return usage
}

/**
 * Grok answers billing over its ACP agent without a session, so no session
 * is created and no MCP server starts: initialize, ask, exit.
 */
async function readGrokBilling(env: NodeJS.ProcessEnv): Promise<JsonValue> {
  return withDiscoveryProcess(
    {
      command: "grok",
      args: ["agent", "--no-leader", "stdio"],
      env: { ...env, GROK_DISABLE_AUTOUPDATER: "1" },
      cwd: homedir(),
      timeoutMs: 20_000,
      priority: "background",
    },
    async ({ child }) => {
      const connection = new ClientSideConnection(
        () => ({
          requestPermission: async () => ({
            outcome: { outcome: "cancelled" },
          }),
          sessionUpdate: async () => {},
        }),
        ndJsonStream(acpWritable(child.stdin), acpReadable(child.stdout))
      )
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "mako", version: "0.0.1" },
        clientCapabilities: {},
      })
      // Grok's extension methods keep ACP's underscore prefix on the wire.
      return z.json().parse(await connection.extMethod("_x.ai/billing", {}))
    }
  )
}

/** Keys that would sign Grok in as someone else than the selected account's file. */
const AUTH_ENV = ["XAI_API_KEY", "GROK_CODE_XAI_API_KEY", "GROK_AUTH"]

/**
 * Each account Mako keeps is one auth file in its own folder: Grok locks the
 * file beside itself, so two accounts never share a lock. Sessions, config
 * and skills stay in `~/.grok`, shared by every account.
 */
function accountAuthPath(name: string): string {
  return join(accountDir("grok", name), "auth.json")
}

/**
 * Grok deletes its auth file when a refresh is refused, so who the account
 * was is kept beside it, without any token.
 */
const IdentitySchema = z.object({ email: z.string() })
function identityPath(name: string): string {
  return join(accountDir("grok", name), "identity.json")
}

async function fileEmail(path: string): Promise<string | undefined> {
  try {
    return parseGrokAccounts(await readFile(path, "utf8"), path)[0]?.email
  } catch {
    return undefined
  }
}

async function managedAccounts(selection: string | null): Promise<HarnessAccount[]> {
  const root = join(accountsRoot(), "grok")
  const accounts: HarnessAccount[] = []
  for (const name of await readdir(root).catch(() => [])) {
    if (name.startsWith(".") || loginPending(accountDir("grok", name))) continue
    const signedIn = await fileEmail(accountAuthPath(name))
    const email = signedIn ?? await readFile(identityPath(name), "utf8")
      .then((contents) => IdentitySchema.parse(JSON.parse(contents)).email)
      .catch(() => undefined)
    const account: HarnessAccount = {
      harness: "grok",
      name,
      dir: accountAuthPath(name),
      active: selection === name,
      source: "mako",
      route: "managed",
    }
    if (email !== undefined) account.email = email
    if (signedIn === undefined) account.signedOut = true
    accounts.push(account)
  }
  return accounts
}

async function accountEnv(selection: string | null, base: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const env = { ...base }
  if (!selection || selection === "default") return env
  if (!existsSync(accountDir("grok", selection)))
    throw new Error("The selected Grok account no longer exists. Choose another account in Settings → Agents.")
  if (!existsSync(accountAuthPath(selection)))
    throw new Error("The selected Grok account is signed out. Sign in again in Settings → Agents.")
  for (const key of AUTH_ENV) delete env[key]
  env.GROK_AUTH_PATH = accountAuthPath(selection)
  return env
}

/** Grok's own browser sign-in, written to the account's file; a new folder, or the file of an account whose login lapsed. */
async function prepareAccountLogin({ name, renew }: AccountLoginTarget): Promise<AccountLoginLaunch> {
  const base = childProcessEnv(process.env)
  const executable = resolveExecutable("grok", base)
  if (!executable) throw new Error("Grok isn't installed. Install it, then sign in.")
  const dir = accountDir("grok", renew ? name : cleanAccountName(name))
  if (renew) {
    if (!existsSync(dir)) throw new Error("That Grok account is gone. Refresh to see your accounts.")
  } else {
    await mkdir(join(accountsRoot(), "grok"), { recursive: true, mode: 0o700 })
    await mkdir(dir, { mode: 0o700 })
    await markLoginPending(dir).catch(async (error) => {
      await rm(dir, { recursive: true, force: true })
      throw error
    })
  }
  const env: NodeJS.ProcessEnv = { ...base, GROK_AUTH_PATH: join(dir, "auth.json"), GROK_DISABLE_AUTOUPDATER: "1" }
  for (const key of AUTH_ENV) delete env[key]
  return { kind: "command", executable, args: ["login", "--oauth"], env, paste: "address" }
}

/** Grok has no status command: the file it wrote, naming who signed in, is the proof. */
async function confirmAccountLogin({ name }: AccountLoginTarget): Promise<void> {
  const email = await fileEmail(accountAuthPath(name))
  if (email === undefined) throw new Error("Grok finished, but no login was saved. Try again.")
  await writeFile(identityPath(name), JSON.stringify({ email }), { mode: 0o600 })
}

async function accountUsage(name: string): Promise<AccountUsage> {
  const base = childProcessEnv(process.env)
  if (!resolveExecutable("grok", base))
    return { status: "unavailable", detail: "Install Grok to see its usage" }
  let env: NodeJS.ProcessEnv
  if (name === "default") {
    if ((await fileEmail(authPath(process.env))) === undefined) return { status: "missing-credentials" }
    env = base
  } else {
    if (!existsSync(accountAuthPath(name))) return { status: "missing-credentials" }
    env = await accountEnv(name, base)
  }
  try {
    return parseGrokBilling(await readGrokBilling(env))
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

export const grokAccountCapability: SelectableAccountCapability = {
  provider: "grok",
  mode: "selectable",
  nativeLogin: true,
  label: "Grok",
  loginCommand: "grok login",
  async listAccounts(selection) {
    const path = authPath(process.env)
    const own = await readFile(path, "utf8")
      .then((contents) => parseGrokAccounts(contents, path))
      .catch(() => [])
    return [
      ...own.map((account) => ({ ...account, active: !selection })),
      ...await managedAccounts(selection),
    ]
  },
  accountEnv,
  prepareAccountLogin,
  confirmAccountLogin,
  removeAccount: async (name) => {
    if (name === "default") throw new Error("The default account is Grok's own login")
    await rm(accountDir("grok", name), { recursive: true, force: true })
  },
  selectedAccount: (selection, env) => ({ name: selection ?? "default", dir: authPath(env) }),
  credentialRevision: (name, env = process.env) =>
    credentialFileFingerprint(name === "default" ? authPath(env) : accountAuthPath(name)),
  accountUsage,
}
