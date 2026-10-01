import { createHash } from "node:crypto"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  AccountUsage,
  HarnessAccount,
  UsageBalance,
  UsageWindow,
} from "../../account-types.js"
import {
  jsonFields,
  jwtClaims,
  numberValue,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { ObservedAccountCapability } from "../account-capability.js"
import type { CursorSdkAuth } from "./sdk/auth.js"

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

/**
 * `DashboardService/GetCurrentPeriodUsage`: the included usage of the billing
 * cycle as one percentage, and the on-demand pool the team or user allows.
 */
export function parseCursorPeriodUsage(contents: string): {
  window: UsageWindow | null
  onDemand: UsageBalance | null
} {
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

async function post(path: string, bearer: string): Promise<string> {
  const response = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: "{}",
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
  sessions.clear()
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
    if (error instanceof CursorUsageError && error.status === 401) {
      sessions.clear()
      return {
        status: "stale-token",
        detail: "Sign in to Cursor again in Settings → Agents",
      }
    }
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Cursor's single login, read through the same auth the SDK runs under.
 * Mako cannot switch Cursor accounts; it shows who is signed in and what
 * the plan has left.
 */
export function cursorAccountCapability(
  auth: CursorSdkAuth
): ObservedAccountCapability {
  return {
    provider: "cursor",
    mode: "observed",
    label: "Cursor",
    loginCommand: "cursor-agent login",
    async listAccounts() {
      const { state } = await auth.status()
      if (state.status !== "signed-in") return []
      const account: HarnessAccount = {
        harness: "cursor",
        name: "default",
        dir: join(homedir(), ".cursor"),
        active: true,
        source: "cli",
      }
      if (state.email !== undefined) account.email = state.email
      return [account]
    },
    accountEnv: async (_selection, base) => ({ ...base }),
    selectedAccount: () => ({ name: "default" }),
    async accountUsage() {
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
