import type {
  AccountUsage,
  UsageBalance,
  UsageWindow,
} from "../account-types.js"
import {
  jsonFields,
  numberValue,
  parseUsageReset,
  stringValue,
  valueFields,
} from "../accounts-common.js"
import type { JsonValue } from "../codex-app-json.js"
import { orderWindows } from "../contracts/account-usage.js"

function parseWindow(
  value: JsonValue | undefined,
  now: number,
  scope?: string
): UsageWindow | null {
  const fields = valueFields(value)
  if (!fields) return null
  const usedPercent = numberValue(fields.get("used_percent"))
  if (usedPercent === undefined) return null
  const windowSeconds = numberValue(fields.get("limit_window_seconds")) ?? 0
  const resetAfter = numberValue(fields.get("reset_after_seconds"))
  const window: UsageWindow = {
    usedPercent,
    windowMinutes: Math.round(windowSeconds / 60),
    resetsAt:
      parseUsageReset(fields.get("reset_at")) ??
      (resetAfter === undefined ? null : now + resetAfter * 1000),
  }
  if (scope !== undefined) window.scope = scope
  return window
}

/** A plan can have one window or two; they arrive by position, not length. */
function parseRateLimit(
  value: JsonValue | undefined,
  now: number,
  scope?: string
): UsageWindow[] {
  const fields = valueFields(value)
  if (!fields) return []
  return [
    parseWindow(fields.get("primary_window"), now, scope),
    parseWindow(fields.get("secondary_window"), now, scope),
  ].filter((window): window is UsageWindow => window !== null)
}

function parseCredits(value: JsonValue | undefined): UsageBalance | null {
  const fields = valueFields(value)
  if (!fields || fields.get("has_credits") !== true) return null
  if (fields.get("unlimited") === true) return null
  const balance = Number(
    stringValue(fields.get("balance")) ?? numberValue(fields.get("balance"))
  )
  if (!Number.isFinite(balance) || balance <= 0) return null
  return { label: "Credits", remaining: balance, unit: "credits" }
}

/**
 * ChatGPT's `wham/usage`, shared by Codex and OpenCode's OpenAI login.
 * Upstream shape: codex-rs/backend-client RateLimitStatusPayload.
 */
export function parseChatGptUsage(
  contents: string,
  now = Date.now()
): Extract<AccountUsage, { status: "ok" }> {
  const fields = jsonFields(contents)
  const windows = parseRateLimit(fields.get("rate_limit"), now)
  const additional = fields.get("additional_rate_limits")
  if (Array.isArray(additional)) {
    for (const entry of additional) {
      const limit = valueFields(entry)
      if (!limit) continue
      const scope =
        stringValue(limit.get("limit_name")) ??
        stringValue(limit.get("metered_feature"))
      windows.push(...parseRateLimit(limit.get("rate_limit"), now, scope))
    }
  }
  windows.push(
    ...parseRateLimit(fields.get("code_review_rate_limit"), now, "Code review")
  )
  const usage: Extract<AccountUsage, { status: "ok" }> = {
    status: "ok",
    windows: orderWindows(windows),
  }
  const plan = stringValue(fields.get("plan_type"))
  if (plan !== undefined) usage.plan = plan
  const credits = parseCredits(fields.get("credits"))
  if (credits) usage.balances = [credits]
  return usage
}

export async function chatGptUsage(
  accessToken: string,
  accountId: string | undefined,
  harnessLabel: string
): Promise<AccountUsage> {
  try {
    const headers = new Headers({ Authorization: `Bearer ${accessToken}` })
    if (accountId) headers.set("ChatGPT-Account-Id", accountId)
    const response = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (response.status === 401)
      return {
        status: "stale-token",
        detail: `Usage returns after this account’s next ${harnessLabel} run`,
      }
    if (!response.ok)
      return { status: "error", detail: `HTTP ${response.status}` }
    return parseChatGptUsage(await response.text())
  } catch (error) {
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}
