import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import type {
  AccountRemoval,
  AccountUsage,
  HarnessAccount,
  UsageBalance,
  UsageWindow,
} from "../../account-types.js"
import {
  credentialFingerprint,
  jsonFields,
  jwtClaims,
  numberValue,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { SelectableAccountCapability } from "../account-capability.js"
import { CURSOR_ACCOUNT_ENV, type CursorSdkAuth } from "./sdk/auth.js"
import type { CursorAccountKeys, StoredCursorCredential } from "./sdk/credentials.js"
import { CURSOR_API_KEY_URL } from "./connection.js"

const API = "https://api2.cursor.sh"

/** Connect-JSON sends int64 as strings; both shapes appear in one response. */
function int64(value: JsonValue | undefined): number | undefined {
  const number = numberValue(value) ?? Number(stringValue(value))
  return Number.isFinite(number) ? number : undefined
}

function cents(value: JsonValue | undefined): number | undefined {
  const amount = int64(value)
  return amount === undefined ? undefined : amount / 100
}

export interface CursorPeriodUsage {
  window: UsageWindow | null
  onDemand: UsageBalance | null
}

/**
 * `DashboardService/GetCurrentPeriodUsage`: the included usage of the billing
 * cycle as one percentage, and the on-demand pool the team or user allows.
 */
export function parseCursorPeriodUsage(contents: string): CursorPeriodUsage {
  const fields = jsonFields(contents)
  const start = int64(fields.get("billingCycleStart"))
  const end = int64(fields.get("billingCycleEnd"))
  const plan = valueFields(fields.get("planUsage"))
  const used = numberValue(plan?.get("totalPercentUsed"))
  const window: UsageWindow | null =
    used === undefined
      ? null
      : {
          usedPercent: used,
          windowMinutes:
            start !== undefined && end !== undefined && end > start
              ? Math.round((end - start) / 60_000)
              : 0,
          resetsAt: end ?? null,
        }
  const spend = valueFields(fields.get("spendLimitUsage"))
  const limit = cents(spend?.get("pooledLimit") ?? spend?.get("individualLimit"))
  const remaining = cents(
    spend?.get("pooledRemaining") ?? spend?.get("individualRemaining")
  )
  const onDemand: UsageBalance | null =
    limit !== undefined && limit > 0 && remaining !== undefined
      ? { label: "On-demand", remaining, total: limit, unit: "usd" }
      : null
  return { window, onDemand }
}

/** `DashboardService/GetPlanInfo`: "Pro", "Team", "Ultra". */
export function parseCursorPlan(contents: string): string | undefined {
  return stringValue(valueFields(jsonFields(contents).get("planInfo"))?.get("planName"))
}

/** Promotional grants that have not run out or expired, summed. */
export function parseCursorGrants(
  contents: string,
  now = Date.now()
): UsageBalance | null {
  const grants = jsonFields(contents).get("activeGrants")
  if (!Array.isArray(grants)) return null
  let remaining = 0
  let total = 0
  for (const entry of grants) {
    const grant = valueFields(entry)
    if (!grant) continue
    const expires = int64(grant.get("expiresAtMs"))
    if (expires !== undefined && expires <= now) continue
    remaining += cents(grant.get("remainingCents")) ?? 0
    total += cents(grant.get("totalCents")) ?? 0
  }
  return remaining > 0
    ? { label: "Promotional credit", remaining, total, unit: "usd" }
    : null
}

class CursorUsageError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

async function post(path: string, bearer: string, body: JsonValue = {}): Promise<string> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new CursorUsageError(response.status)
  return response.text()
}

/**
 * The dashboard service takes a session token, not an API key; the key
 * trades for one. Kept per key until shortly before it lapses.
 */
const sessions = new Map<string, { token: string; expiresAt: number }>()

async function sessionToken(apiKey: string): Promise<string> {
  const id = createHash("sha256").update(apiKey).digest("hex")
  const cached = sessions.get(id)
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token
  const token = stringValue(
    jsonFields(await post("/auth/exchange_user_api_key", apiKey)).get(
      "accessToken"
    )
  )
  if (!token) throw new CursorUsageError(401)
  sessions.set(id, {
    token,
    expiresAt: jwtClaims(token).expiresAt ?? Date.now() + 10 * 60_000,
  })
  return token
}

async function usageForKey(apiKey: string): Promise<AccountUsage> {
  try {
    const token = await sessionToken(apiKey)
    const [period, plan, grants] = await Promise.all([
      post("/aiserver.v1.DashboardService/GetCurrentPeriodUsage", token),
      post("/aiserver.v1.DashboardService/GetPlanInfo", token).catch(() => ""),
      post(
        "/aiserver.v1.DashboardService/GetUsageLimitStatusAndActiveGrants",
        token
      ).catch(() => ""),
    ])
    const { window, onDemand } = parseCursorPeriodUsage(period)
    const balances = [
      onDemand,
      grants ? parseCursorGrants(grants) : null,
    ].filter((balance): balance is UsageBalance => balance !== null)
    const usage: AccountUsage = {
      status: "ok",
      windows: window ? [window] : [],
    }
    const planName = plan ? parseCursorPlan(plan) : undefined
    if (planName !== undefined) usage.plan = planName
    if (balances.length > 0) usage.balances = balances
    return usage
  } catch (error) {
    if (error instanceof CursorUsageError && (error.status === 401 || error.status === 403)) {
      sessions.delete(createHash("sha256").update(apiKey).digest("hex"))
      return {
        status: "stale-token",
        detail: "Cursor refused this login. Sign in again.",
      }
    }
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

const UserApiKeysSchema = z.object({
  apiKeys: z.array(z.object({
    id: z.number(),
    maskedKey: z.string().default(""),
    name: z.string().default(""),
    expiresAt: z.union([z.string(), z.number()]).optional(),
  })).default([]),
})

/**
 * Whether `masked`, a key as Cursor's dashboard shows it, rules out `key`:
 * the ends it shows aren't the key's. Cursor masks on its side, so a shape
 * this doesn't recognise rules nothing out.
 */
function maskedOtherThan(masked: string, key: string): boolean {
  const [, head = "", tail = ""] = /^([\w-]*)[^\w-]+([\w-]*)$/.exec(masked) ?? []
  return !key.startsWith(head) || !key.endsWith(tail)
}

/**
 * Revokes the key a Mako sign-in minted: the one with the name it was
 * minted under and its exact expiry, to the millisecond, that the ends
 * Cursor shows don't rule out. Nothing else is touched. Resolves
 * `undefined` once Cursor no longer accepts the key, otherwise why it
 * still does.
 */
async function revokeMintedKey(credential: StoredCursorCredential): Promise<string | undefined> {
  let token: string
  try {
    token = await sessionToken(credential.apiKey)
  } catch (error) {
    if (error instanceof CursorUsageError && (error.status === 401 || error.status === 403)) return undefined
    return `Cursor couldn't be reached (${error instanceof Error ? error.message : String(error)})`
  } finally {
    sessions.delete(createHash("sha256").update(credential.apiKey).digest("hex"))
  }
  try {
    const listed = UserApiKeysSchema.parse(JSON.parse(await post("/aiserver.v1.DashboardService/ListUserApiKeys", token)))
    const expiresAt = credential.expiresAt === undefined ? Number.NaN : Date.parse(credential.expiresAt)
    const minted = listed.apiKeys.filter(key =>
      key.name === credential.keyName && Number(key.expiresAt) === expiresAt && !maskedOtherThan(key.maskedKey, credential.apiKey))
    const [only] = minted
    if (!only || minted.length > 1)
      return minted.length ? "Cursor lists more than one key that could be this one" : "Cursor's key list doesn't show this key"
    await post("/aiserver.v1.DashboardService/RevokeUserApiKey", token, { id: only.id })
    return undefined
  } catch (error) {
    return error instanceof CursorUsageError
      ? `Cursor refused to revoke it (${error.message})`
      : `Cursor's answer couldn't be read (${error instanceof Error ? error.message : String(error)})`
  }
}

function expired(credential: StoredCursorCredential, now = Date.now()): boolean {
  return credential.expiresAt !== undefined && Date.parse(credential.expiresAt) <= now
}

/**
 * Cursor's own login, read through the same auth the SDK runs under, and
 * the accounts added in Mako: each a key Cursor minted for whoever signed
 * in on its page, kept in its own encrypted record. Selecting one hands its
 * key to new sessions; the own login stays as it is.
 */
export function cursorAccountCapability(
  auth: CursorSdkAuth,
  keys: CursorAccountKeys
): SelectableAccountCapability {
  const saved = async (name: string): Promise<StoredCursorCredential> => {
    const credential = await keys.store(name).load()
    if (!credential) throw new Error("The selected Cursor account no longer exists. Choose another account in Settings → Agents.")
    return credential
  }
  return {
    provider: "cursor",
    mode: "selectable",
    nativeLogin: true,
    label: "Cursor",
    loginCommand: "cursor-agent login",
    async listAccounts(selection) {
      const accounts: HarnessAccount[] = []
      const { state } = await auth.status()
      if (state.status === "signed-in") {
        const account: HarnessAccount = {
          harness: "cursor",
          name: "default",
          dir: join(homedir(), ".cursor"),
          active: !selection,
          source: "cli",
        }
        if (state.email !== undefined) account.email = state.email
        accounts.push(account)
      }
      for (const name of await keys.names()) {
        const credential = await keys.store(name).load().catch(() => null)
        const account: HarnessAccount = {
          harness: "cursor",
          name,
          dir: "",
          active: selection === name,
          source: "mako",
          route: "managed",
        }
        if (credential?.email !== undefined) account.email = credential.email
        if (!credential || expired(credential)) account.signedOut = true
        accounts.push(account)
      }
      return accounts
    },
    async accountEnv(selection, base) {
      const env = { ...base }
      if (!selection || selection === "default") return env
      const credential = await saved(selection)
      if (expired(credential))
        throw new Error("The selected Cursor account's login expired. Sign in again in Settings → Agents.")
      env.CURSOR_API_KEY = credential.apiKey
      env[CURSOR_ACCOUNT_ENV] = selection
      return env
    },
    async prepareAccountLogin({ name }) {
      const store = keys.store(name)
      return {
        kind: "task",
        async run(events, signal) {
          await store.save(await auth.mintBrowserKey(events.page, signal))
        },
      }
    },
    removeAccount: async (name) => {
      if (name === "default") throw new Error("The default account is Cursor's own login")
      const store = keys.store(name)
      const credential = await store.load().catch(() => null)
      const reason = credential?.method === "browser" && !expired(credential) ? await revokeMintedKey(credential) : undefined
      await store.clear()
      if (reason === undefined || !credential) return {}
      const stillValid: NonNullable<AccountRemoval["stillValid"]> = { reason, manageUrl: CURSOR_API_KEY_URL }
      if (credential.expiresAt !== undefined) stillValid.expiresAt = credential.expiresAt
      return { stillValid }
    },
    selectedAccount: (selection) => ({ name: selection ?? "default" }),
    credentialRevision: async (name, env) => {
      if (name !== "default") {
        const credential = await keys.store(name).load()
        return credentialFingerprint([credential?.revision ?? null, credential?.apiKey ?? null])
      }
      const launch = await auth.childLaunch(env)
      const key = launch.env.CURSOR_API_KEY
      if (key) return credentialFingerprint([key])
      const path = join(launch.env.HOME ?? homedir(), ".cursor", "sdk", "auth.json")
      const raw = await readFile(path, "utf8").catch(error => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null
        throw error
      })
      return credentialFingerprint([path, raw])
    },
    async accountUsage(name) {
      if (name !== "default") {
        const credential = await keys.store(name).load().catch(() => null)
        if (!credential || expired(credential)) return { status: "missing-credentials" }
        return usageForKey(credential.apiKey)
      }
      const apiKey = (await auth.childEnv()).CURSOR_API_KEY
      if (!apiKey)
        return {
          status: (await auth.status()).state.status === "signed-in"
            ? "unavailable"
            : "missing-credentials",
          detail: "Usage needs a Cursor API key or the Cursor CLI login",
        }
      return usageForKey(apiKey)
    },
  }
}
