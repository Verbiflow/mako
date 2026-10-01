import { z } from "zod"
import type { AccountUsage, ResetCreditOutcome, UsageBalance, UsageResetCredits, UsageWindow } from "../../account-types.js"
import type { JsonValue } from "../../codex-app-json.js"
import { orderWindows } from "../../contracts/account-usage.js"

/**
 * Codex's own account limits, from its app-server: `account/rateLimits/read`
 * answers with every limit and the account's reset credits, and
 * `account/rateLimits/updated` repeats a limit while a turn spends it. Codex
 * refreshes its own sign-in to answer, so this has no stale-token state.
 * Upstream shape: codex-rs app-server-protocol v2 `RateLimitSnapshot`.
 */
const WindowSchema = z.object({
  usedPercent: z.number(),
  windowDurationMins: z.number().nullish(),
  /** Unix seconds. */
  resetsAt: z.number().nullish(),
})

const SnapshotSchema = z.object({
  limitId: z.string().nullish(),
  limitName: z.string().nullish(),
  primary: WindowSchema.nullish(),
  secondary: WindowSchema.nullish(),
  credits: z.object({
    hasCredits: z.boolean(),
    unlimited: z.boolean(),
    balance: z.string().nullish(),
  }).nullish(),
  planType: z.string().nullish(),
})

const ReadSchema = z.object({
  rateLimits: SnapshotSchema,
  rateLimitsByLimitId: z.record(z.string(), SnapshotSchema).nullish(),
  rateLimitResetCredits: z.object({
    availableCount: z.number(),
    credits: z.array(z.object({
      status: z.string(),
      expiresAt: z.number().nullish(),
    })).nullish(),
  }).nullish(),
})

const UpdatedSchema = z.object({ rateLimits: SnapshotSchema })

type Snapshot = z.infer<typeof SnapshotSchema>

/** The account's general allowance; other ids are a model's own cap. */
const GENERAL_LIMIT = "codex"

function window(value: z.infer<typeof WindowSchema> | null | undefined, scope: string | undefined): UsageWindow | null {
  if (!value || !Number.isFinite(value.usedPercent)) return null
  const reading: UsageWindow = {
    usedPercent: value.usedPercent,
    windowMinutes: value.windowDurationMins ?? 0,
    resetsAt: value.resetsAt ? value.resetsAt * 1000 : null,
  }
  if (scope !== undefined) reading.scope = scope
  return reading
}

function snapshotWindows(snapshot: Snapshot): UsageWindow[] {
  const general = !snapshot.limitId || snapshot.limitId === GENERAL_LIMIT
  const scope = general ? undefined : snapshot.limitName ?? snapshot.limitId ?? undefined
  return [window(snapshot.primary, scope), window(snapshot.secondary, scope)]
    .filter((reading): reading is UsageWindow => reading !== null)
}

function credits(snapshot: Snapshot): UsageBalance | null {
  const credit = snapshot.credits
  if (!credit?.hasCredits || credit.unlimited) return null
  const remaining = Number(credit.balance)
  return Number.isFinite(remaining) && remaining > 0
    ? { label: "Credits", remaining, unit: "credits" }
    : null
}

function resetCredits(value: z.infer<typeof ReadSchema>["rateLimitResetCredits"]): UsageResetCredits | undefined {
  if (!value || value.availableCount <= 0) return undefined
  const expiries = (value.credits ?? [])
    .filter((credit) => credit.status === "available" && credit.expiresAt)
    .map((credit) => (credit.expiresAt ?? 0) * 1000)
  return { available: value.availableCount, expiresAt: expiries.length ? Math.min(...expiries) : null }
}

/** `account/rateLimits/read`'s result as the account's whole reading. */
export function parseCodexRateLimits(value: JsonValue): AccountUsage {
  const parsed = ReadSchema.safeParse(value)
  if (!parsed.success) return { status: "error", detail: "Codex answered with limits Mako can't read" }
  const byId = parsed.data.rateLimitsByLimitId ?? {}
  const general = byId[GENERAL_LIMIT] ?? parsed.data.rateLimits
  const snapshots = [general, ...Object.entries(byId).filter(([id]) => id !== GENERAL_LIMIT).map(([, snapshot]) => snapshot)]
  const usage: Extract<AccountUsage, { status: "ok" }> = {
    status: "ok",
    windows: orderWindows(snapshots.flatMap(snapshotWindows)),
  }
  if (general.planType) usage.plan = general.planType
  const balance = credits(general)
  if (balance) usage.balances = [balance]
  const resets = resetCredits(parsed.data.rateLimitResetCredits)
  if (resets) usage.resetCredits = resets
  return usage
}

/** The windows an `account/rateLimits/updated` names; the rest of the reading stands. */
export function codexUpdatedWindows(value: JsonValue): UsageWindow[] {
  const parsed = UpdatedSchema.safeParse(value)
  return parsed.success ? snapshotWindows(parsed.data.rateLimits) : []
}

const OutcomeSchema = z.object({ outcome: z.enum(["reset", "nothingToReset", "noCredit", "alreadyRedeemed"]) })

const OUTCOMES = {
  reset: "reset",
  nothingToReset: "nothing-to-reset",
  noCredit: "no-credit",
  alreadyRedeemed: "already-used",
} satisfies Record<z.infer<typeof OutcomeSchema>["outcome"], ResetCreditOutcome>

/** `account/rateLimitResetCredit/consume`'s answer; anything else is unknown. */
export function parseResetOutcome(value: JsonValue): ResetCreditOutcome | null {
  const outcome = OutcomeSchema.safeParse(value)
  return outcome.success ? OUTCOMES[outcome.data.outcome] : null
}
