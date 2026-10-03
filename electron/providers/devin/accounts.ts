import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type {
  AccountUsage,
  HarnessAccount,
  UsageBalance,
  UsageWindow,
} from "../../account-types.js"
import {
  credentialFileFingerprint,
  jsonFields,
  numberValue,
  parseUsageReset,
  stringValue,
  valueFields,
} from "../../accounts-common.js"
import type { JsonValue } from "../../codex-app-json.js"
import type { ObservedAccountCapability } from "../account-capability.js"

function credentialsPath(env: NodeJS.ProcessEnv): string {
  return join(
    env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
    "devin",
    "credentials.toml"
  )
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

async function fetchDevinStatus(): Promise<DevinStatus | null> {
  let contents: string
  try {
    contents = await readFile(credentialsPath(process.env), "utf8")
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
 * usage share one reading a minute rather than asking twice.
 */
let reading: { at: number; revision: string; status: Promise<DevinStatus | null> } | undefined

async function devinStatus(): Promise<DevinStatus | null> {
  const revision = await credentialFileFingerprint(credentialsPath(process.env))
  if (reading && reading.revision === revision && Date.now() - reading.at < 60_000) return reading.status
  const status = fetchDevinStatus()
  reading = { at: Date.now(), revision, status }
  status.catch(() => {
    if (reading?.status === status) reading = undefined
  })
  return status
}

export const devinAccountCapability: ObservedAccountCapability = {
  provider: "devin",
  mode: "observed",
  label: "Devin",
  loginCommand: "devin auth login",
  async listAccounts() {
    const status = await devinStatus().catch(() => null)
    if (!status) return []
    const account: HarnessAccount = {
      harness: "devin",
      name: "default",
      dir: credentialsPath(process.env),
      active: true,
      source: "cli",
    }
    if (status.email !== undefined) account.email = status.email
    return [account]
  },
  accountEnv: async (_selection, base) => ({ ...base }),
  selectedAccount: () => ({ name: "default" }),
  credentialRevision: () => credentialFileFingerprint(credentialsPath(process.env)),
  async accountUsage() {
    try {
      const status = await devinStatus()
      return status?.usage ?? { status: "missing-credentials" }
    } catch (error) {
      if (error instanceof DevinStatusError && error.status === 401)
        return {
          status: "stale-token",
          detail: "Sign in to Devin again with devin auth login",
        }
      return {
        status: "error",
        detail: error instanceof Error ? error.message : String(error),
      }
    }
  },
}
