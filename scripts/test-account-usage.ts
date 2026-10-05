import assert from "node:assert/strict"
import { mock } from "node:test"
import {
  accountEnv,
  accountUsage,
  accountUsageSpent,
  listAccounts,
  observeAccountUsage,
  onAccountUsage,
  selectedAccount,
  type UsageWindow,
} from "../electron/accounts"
import { bindingWindow, hasReset, mergeWindows, nextReset } from "../electron/contracts/account-usage"
import { codexUpdatedWindows, parseCodexRateLimits, parseResetOutcome } from "../electron/providers/codex/rate-limits"
import { providerHost } from "../electron/providers/index"
import type { AccountUsage } from "../electron/account-types"
import { parseChatGptUsage } from "../electron/providers/chatgpt-usage"
import { claudeRateLimitWindow, parseClaudeUsage } from "../electron/providers/claude/accounts"
import {
  parseCursorGrants,
  parseCursorPeriodUsage,
  parseCursorPlan,
} from "../electron/providers/cursor/accounts"
import {
  devinCredential,
  parseDevinStatus,
} from "../electron/providers/devin/accounts"
import {
  parseGrokAccounts,
  parseGrokBilling,
} from "../electron/providers/grok/accounts"
import { parseOpenCodeAccounts } from "../electron/providers/opencode/accounts"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"

const now = Date.parse("2026-09-30T12:00:00Z")

// ChatGPT's usage API names windows by position. A Pro plan can report a
// single weekly window and no five-hour one; credits ride alongside.
const weeklyOnly = parseChatGptUsage(
  JSON.stringify({
    plan_type: "pro",
    rate_limit: {
      primary_window: {
        used_percent: 23,
        limit_window_seconds: 604_800,
        reset_after_seconds: 3_600,
        reset_at: 1_791_189_980,
      },
      secondary_window: null,
    },
    additional_rate_limits: null,
    code_review_rate_limit: null,
    credits: { has_credits: true, unlimited: false, balance: "62494.05" },
  }),
  now
)
assert.deepEqual(weeklyOnly, {
  status: "ok",
  plan: "pro",
  windows: [
    { usedPercent: 23, windowMinutes: 10_080, resetsAt: 1_791_189_980_000 },
  ],
  balances: [{ label: "Credits", remaining: 62_494.05, unit: "credits" }],
})

const twoWindows = parseChatGptUsage(
  JSON.stringify({
    rate_limit: {
      primary_window: { used_percent: 15, limit_window_seconds: 604_800, reset_after_seconds: 60 },
      secondary_window: { used_percent: 40, limit_window_seconds: 18_000, reset_after_seconds: 30 },
    },
    additional_rate_limits: [
      {
        limit_name: "GPT-6 Astra",
        rate_limit: { primary_window: { used_percent: 5, limit_window_seconds: 604_800 } },
      },
    ],
    credits: { has_credits: true, unlimited: true, balance: "1" },
  }),
  now
)
assert.deepEqual(
  twoWindows.windows.map((window) => [window.windowMinutes, window.usedPercent, window.scope]),
  [
    [300, 40, undefined],
    [10_080, 15, undefined],
    [10_080, 5, "GPT-6 Astra"],
  ],
  "windows sort by length, a scoped cap after the general one"
)
assert.equal(twoWindows.windows[0]?.resetsAt, now + 30_000)
assert.equal(twoWindows.balances, undefined, "unlimited credits are not a balance")

const fiveHour: UsageWindow = { usedPercent: 40, windowMinutes: 300, resetsAt: 1 }
const week: UsageWindow = { usedPercent: 96, windowMinutes: 10_080, resetsAt: 2 }
assert.equal(bindingWindow([fiveHour, week]), week, "the most spent window binds")
assert.equal(bindingWindow([]), null)

// Claude: one field per window, null when a plan has no such cap; extra
// usage is reported in cents.
const claude = parseClaudeUsage(
  JSON.stringify({
    five_hour: { utilization: 42, resets_at: "2026-09-30T14:13:00Z" },
    seven_day: { utilization: 18, resets_at: "2026-10-03T16:32:00Z" },
    seven_day_opus: { utilization: 81, resets_at: "2026-10-03T16:32:00Z" },
    seven_day_sonnet: null,
    extra_usage: { is_enabled: true, monthly_limit: 5_000, used_credits: 1_240, utilization: 24.8 },
  })
)
assert.deepEqual(
  claude.windows.map((window) => [usageLabel(window), window.usedPercent]),
  [["300", 42], ["10080", 18], ["10080:Opus", 81]]
)
assert.equal(claude.windows[0]?.resetsAt, Date.parse("2026-09-30T14:13:00Z"))
assert.deepEqual(claude.balances, [
  { label: "Extra usage", remaining: 37.6, total: 50, unit: "usd" },
])
assert.equal(
  parseClaudeUsage(JSON.stringify({ extra_usage: { is_enabled: false } })).balances,
  undefined
)

// Cursor: Connect JSON with int64 strings; money in cents.
const cursorPeriod = parseCursorPeriodUsage(
  JSON.stringify({
    billingCycleStart: "1788863914000",
    billingCycleEnd: "1791455914000",
    planUsage: { remaining: 1_260, limit: 2_000, totalPercentUsed: 37 },
    spendLimitUsage: { pooledLimit: "2000", pooledUsed: 0, pooledRemaining: "2000", limitType: "team" },
  })
)
assert.deepEqual(cursorPeriod, {
  window: { usedPercent: 37, windowMinutes: 43_200, resetsAt: 1_791_455_914_000 },
  onDemand: { label: "On-demand", remaining: 20, total: 20, unit: "usd" },
})
assert.equal(parseCursorPlan(JSON.stringify({ planInfo: { planName: "Team" } })), "Team")
assert.deepEqual(
  parseCursorGrants(
    JSON.stringify({
      activeGrants: [
        { totalCents: "500000", remainingCents: "373031", expiresAtMs: String(now + 1), grantType: "promo" },
        { totalCents: "1000", remainingCents: "1000", expiresAtMs: String(now - 1), grantType: "promo" },
      ],
    }),
    now
  ),
  { label: "Promotional credit", remaining: 3_730.31, total: 5_000, unit: "usd" },
  "expired grants are not spendable"
)

// Grok: one credit percentage over the current period.
assert.deepEqual(
  parseGrokBilling({
    config: {
      creditUsagePercent: 2,
      currentPeriod: {
        type: "USAGE_PERIOD_TYPE_WEEKLY",
        start: "2026-09-25T03:43:58.836813+00:00",
        end: "2026-10-02T03:43:58.836813+00:00",
      },
      onDemandCap: { val: 0 },
    },
    subscription_tier: "X Premium+",
  }),
  {
    status: "ok",
    windows: [
      { usedPercent: 2, windowMinutes: 10_080, resetsAt: Date.parse("2026-10-02T03:43:58.836Z") },
    ],
    plan: "X Premium+",
  }
)
const grokSecrets = { key: "grok-key-fixture", refresh_token: "grok-refresh-fixture" }
const grokAccounts = parseGrokAccounts(
  JSON.stringify({
    "https://auth.x.ai::client": { ...grokSecrets, email: "grok@example.com", user_id: "user-fixture" },
  }),
  "/fixture/.grok/auth.json"
)
assert.deepEqual(grokAccounts, [
  {
    harness: "grok",
    name: "default",
    email: "grok@example.com",
    dir: "/fixture/.grok/auth.json",
    active: true,
    source: "cli",
  },
])
for (const secret of Object.values(grokSecrets))
  assert.equal(JSON.stringify(grokAccounts).includes(secret), false)

// Devin: remaining percentages, unix-second resets, overage in micro-dollars.
const devinToml = [
  'windsurf_api_key = "devin-key-fixture"',
  'api_server_url = "https://server.example.com"',
  'devin_api_url = "https://api.example.com"',
].join("\n")
assert.equal(devinCredential(devinToml, "windsurf_api_key"), "devin-key-fixture")
assert.equal(devinCredential(devinToml, "api_server_url"), "https://server.example.com")
assert.equal(devinCredential(devinToml, "missing"), undefined)
const devin = parseDevinStatus(
  JSON.stringify({
    userStatus: {
      email: "devin@example.com",
      planStatus: {
        dailyQuotaRemainingPercent: 36,
        weeklyQuotaRemainingPercent: 82,
        overageBalanceMicros: "39495900",
        dailyQuotaResetAtUnix: "1790841600",
        weeklyQuotaResetAtUnix: "1791100800",
        planInfo: { planName: "Teams" },
      },
    },
  })
)
assert.deepEqual(devin, {
  email: "devin@example.com",
  usage: {
    status: "ok",
    windows: [
      { usedPercent: 64, windowMinutes: 1_440, resetsAt: 1_790_841_600_000 },
      { usedPercent: 18, windowMinutes: 10_080, resetsAt: 1_791_100_800_000 },
    ],
    plan: "Teams",
    balances: [{ label: "Extra usage", remaining: 39.4959, unit: "usd" }],
  },
})
assert.deepEqual(
  parseDevinStatus(
    JSON.stringify({
      userStatus: {
        planStatus: {
          dailyQuotaRemainingPercent: 100,
          weeklyQuotaRemainingPercent: 100,
          planInfo: { hideWeeklyQuota: true },
        },
      },
    })
  ).usage.windows.map((window) => window.windowMinutes),
  [1_440],
  "a hidden weekly quota is not shown"
)

// A turn ending drops a harness's cached readings, at most every twenty seconds.
assert.equal(accountUsageSpent("codex"), true)
assert.equal(accountUsageSpent("codex"), false)
assert.equal(accountUsageSpent("not-a-provider"), false)

function usageLabel(window: UsageWindow): string {
  return window.scope ? `${window.windowMinutes}:${window.scope}` : String(window.windowMinutes)
}

const jwtHeader = Buffer.from(JSON.stringify({ alg: "none" })).toString(
  "base64url"
)
const jwtPayload = Buffer.from(
  JSON.stringify({
    "https://api.openai.com/profile": { email: "fixture@example.com" },
    "https://api.openai.com/auth": { chatgpt_account_id: "account-fixture" },
  })
).toString("base64url")
const accessToken = `${jwtHeader}.${jwtPayload}.fixture-signature`
const secrets = {
  accessToken,
  refreshToken: "refresh-secret-fixture",
  apiKey: "api-secret-fixture",
}
const discovered = parseOpenCodeAccounts(
  JSON.stringify({
    openai: {
      type: "oauth",
      access: secrets.accessToken,
      refresh: secrets.refreshToken,
      expires: 9_999_999_999_999,
      accountId: "stored-account-fallback",
    },
    anthropic: { type: "api", key: secrets.apiKey },
  }),
  "/fixture/opencode/auth.json"
)

assert.deepEqual(discovered, [
  {
    harness: "opencode",
    name: "openai",
    providerId: "openai",
    authType: "oauth",
    email: "fixture@example.com",
    accountId: "account-fixture",
    dir: "/fixture/opencode/auth.json",
    active: true,
    source: "model-provider",
  },
  {
    harness: "opencode",
    name: "anthropic",
    providerId: "anthropic",
    authType: "api",
    dir: "/fixture/opencode/auth.json",
    active: true,
    source: "model-provider",
  },
])
const serialized = JSON.stringify(discovered)
for (const secret of Object.values(secrets)) {
  assert.equal(serialized.includes(secret), false)
}
for (const secretField of ["access", "refresh", "key", "token", "expires"]) {
  assert.equal(serialized.includes(`"${secretField}"`), false)
}
assert.equal(serialized.includes("stored-account-fallback"), false)

const openCodeCatalog = normalizeOpenCodeModels([
  { providerID: "openai", id: "gpt-5.4", name: "GPT-5.4" },
  {
    providerID: "opencode",
    id: "x-preview-f-free",
    name: "Ox Alpha Free (Unlimited)",
  },
])
assert.equal(openCodeCatalog.defaultModel, undefined)
assert.deepEqual(openCodeCatalog.models.map((model) => model.id), [
  "openai/gpt-5.4",
  "opencode/x-preview-f-free",
])

const childEnv = await accountEnv("opencode", {
  PATH: "/fixture/bin",
  MAKO_BACKEND_TOKEN: "backend-secret",
  MAKO_CUA_SOCKET: "/fixture/cua.sock",
  MAKO_DATA_ROOT: "/fixture/Application Support/mako",
  MAKO_WEB_SOCKET: "/fixture/mako-host/host.sock",
  MAKO_HOST_ONLY: "1",
  MAKO_WEB_ONLY: "1",
  MAKO_PROFILE: "dev",
})
assert.equal(childEnv.PATH, "/fixture/bin")
assert.equal(childEnv.MAKO_BACKEND_TOKEN, undefined)
assert.equal(childEnv.MAKO_CUA_SOCKET, undefined)
// The host's own launch variables stay with the host: an agent that runs
// `npm run dev` from a provider process must start or attach to the dev
// profile, not the host that spawned it.
for (const key of ["MAKO_DATA_ROOT", "MAKO_WEB_SOCKET", "MAKO_HOST_ONLY", "MAKO_WEB_ONLY", "MAKO_PROFILE"])
  assert.equal(childEnv[key], undefined, `${key} leaked into a provider process`)

// Observed providers keep their own single login and inherit ordinary
// process values while Mako runtime secrets stay isolated.
const cursorEnv = await accountEnv("cursor", {
  PATH: "/fixture/bin",
  CURSOR_API_KEY: "provider-owned-fixture",
  MAKO_BACKEND_TOKEN: "backend-secret",
})
assert.deepEqual(cursorEnv, {
  PATH: "/fixture/bin",
  CURSOR_API_KEY: "provider-owned-fixture",
})
assert.deepEqual(await selectedAccount("cursor"), { name: "default" })

// Codex answers for itself through its app-server.
{
  const read = parseCodexRateLimits({
    rateLimits: { limitId: "codex", primary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1 } },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_900_000_000 },
        secondary: { usedPercent: 64, windowDurationMins: 10_080, resetsAt: 1_900_300_000 },
        credits: { hasCredits: true, unlimited: false, balance: "120.5" },
        planType: "pro",
      },
      spark: {
        limitId: "spark", limitName: "Spark",
        primary: { usedPercent: 3, windowDurationMins: 10_080, resetsAt: null },
      },
    },
    rateLimitResetCredits: {
      availableCount: 2,
      credits: [
        { status: "available", expiresAt: 1_901_000_000 },
        { status: "available", expiresAt: 1_900_500_000 },
        { status: "redeemed", expiresAt: 1_800_000_000 },
      ],
    },
  })
  assert.deepEqual(read, {
    status: "ok",
    plan: "pro",
    windows: [
      { usedPercent: 12, windowMinutes: 300, resetsAt: 1_900_000_000_000 },
      { usedPercent: 64, windowMinutes: 10_080, resetsAt: 1_900_300_000_000 },
      { usedPercent: 3, windowMinutes: 10_080, resetsAt: null, scope: "Spark" },
    ],
    balances: [{ label: "Credits", remaining: 120.5, unit: "credits" }],
    resetCredits: { available: 2, expiresAt: 1_900_500_000_000 },
  }, "the general limit comes from its own id, a model's cap is scoped, and the soonest unspent credit's expiry is kept")
  assert.equal(parseCodexRateLimits({ rateLimits: "nope" }).status, "error")
  assert.deepEqual(codexUpdatedWindows({ rateLimits: { limitId: "codex", primary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_900_000_000 } } }),
    [{ usedPercent: 40, windowMinutes: 300, resetsAt: 1_900_000_000_000 }])
  assert.deepEqual(codexUpdatedWindows({}), [])
  assert.equal(parseResetOutcome({ outcome: "nothingToReset" }), "nothing-to-reset")
  assert.equal(parseResetOutcome({ outcome: "alreadyRedeemed" }), "already-used")
  assert.equal(parseResetOutcome({ outcome: "somethingNew" }), null)
}

// Claude's streamed limits land on the windows its usage reading draws.
assert.deepEqual(claudeRateLimitWindow({ status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.815, resetsAt: 1_900_000_000 }),
  { usedPercent: 81.5, windowMinutes: 10_080, resetsAt: 1_900_000_000_000, scope: "Opus" })
assert.equal(claudeRateLimitWindow({ status: "allowed", rateLimitType: "overage", utilization: 0.5 }), null)
assert.equal(claudeRateLimitWindow({ status: "allowed", rateLimitType: "five_hour" }), null)

// A reading stops being true at its soonest reset; a live update amends only the windows it names.
{
  const now = 1_000_000
  const reading: AccountUsage = {
    status: "ok",
    windows: [
      { usedPercent: 90, windowMinutes: 300, resetsAt: now + 60_000 },
      { usedPercent: 40, windowMinutes: 10_080, resetsAt: now + 600_000 },
      { usedPercent: 10, windowMinutes: 10_080, resetsAt: now - 1, scope: "Opus" },
    ],
  }
  assert.equal(nextReset(reading, now), now + 60_000)
  assert.equal(hasReset(reading, now), true)
  assert.equal(hasReset({ status: "ok", windows: [] }, now), false)
  const merged = mergeWindows(reading, [{ usedPercent: 95, windowMinutes: 300, resetsAt: now + 60_000 }], now)
  assert.deepEqual(merged?.status === "ok" && merged.windows.map((window) => window.usedPercent), [95, 40, 10])
  assert.equal(mergeWindows({ status: "stale-token" }, [{ usedPercent: 5, windowMinutes: 300, resetsAt: null }], now), undefined,
    "a lone window never stands in for a whole reading")
}

// The cache: shared reads, expiry at a reset, the last good reading through a failure, a new login, a live amendment.
{
  const grok = providerHost.accountCapabilities.get("grok")
  assert.ok(grok)
  let calls = 0
  let credential = "first-credential"
  const revision = mock.method(grok, "credentialRevision", async () => credential)
  let next: () => AccountUsage = () => ({ status: "ok", windows: [] })
  const read = mock.method(grok, "accountUsage", async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 5))
    return next()
  })
  let identity = "first@example.com"
  const lists = providerHost.accountCapabilities.list().map((capability) =>
    mock.method(capability, "listAccounts", async () => capability === grok
      ? [{ harness: "grok", name: "default", email: identity, dir: "", active: true, source: "cli" as const }]
      : []))
  try {
    const soon = Date.now() + 80
    next = () => ({ status: "ok", windows: [{ usedPercent: 97, windowMinutes: 1_440, resetsAt: soon }] })
    const [a, b] = await Promise.all([accountUsage("grok", "default"), accountUsage("grok", "default")])
    assert.equal(calls, 1, "readers asking at once share one request")
    assert.equal(a, b)
    assert.ok(a.status === "ok" && a.readAt !== undefined, "a good reading carries when it was taken")
    await accountUsage("grok", "default")
    assert.equal(calls, 1, "a fresh reading is served from the cache")
    await new Promise((resolve) => setTimeout(resolve, 100))
    next = () => ({ status: "error", detail: "HTTP 429" })
    const kept = await accountUsage("grok", "default")
    assert.equal(calls, 2, "a window that reset makes the reading expire")
    assert.equal(kept.status, "error", "a reading whose window reset is not kept through a failure")

    next = () => ({ status: "ok", windows: [{ usedPercent: 30, windowMinutes: 1_440, resetsAt: Date.now() + 3_600_000 }] })
    accountUsageSpent("grok", 0)
    const good = await accountUsage("grok", "default")
    next = () => ({ status: "error", detail: "HTTP 429" })
    accountUsageSpent("grok", 0)
    assert.equal(await accountUsage("grok", "default"), good, "a failed refresh keeps the last good reading")

    await listAccounts()
    identity = "second@example.com"
    await listAccounts()
    next = () => ({ status: "ok", windows: [{ usedPercent: 1, windowMinutes: 1_440, resetsAt: Date.now() + 3_600_000 }] })
    const fresh = await accountUsage("grok", "default")
    assert.ok(fresh.status === "ok" && fresh.windows[0]?.usedPercent === 1, "a different login under the same name reads afresh")

    const heard: AccountUsage[] = []
    const stop = onAccountUsage((harness, name, usage) => { if (harness === "grok" && name === "default") heard.push(usage) })
    const before = calls
    observeAccountUsage("grok", "default", (previous) => mergeWindows(previous, [{ usedPercent: 55, windowMinutes: 1_440, resetsAt: Date.now() + 3_600_000 }], Date.now()))
    stop()
    assert.equal(calls, before, "a live reading needs no request")
    const amended = await accountUsage("grok", "default")
    assert.ok(amended.status === "ok" && amended.windows[0]?.usedPercent === 55)
    assert.equal(heard[0], amended, "listeners hear the amended reading")
    credential = "rotated-credential"
    next = () => ({ status: "error", detail: "HTTP 429" })
    const rotated = await accountUsage("grok", "default")
    assert.equal(rotated.status, "error", "same-email credential rotation cannot reuse the previous login's last-good usage")
    assert.equal(calls, before + 1, "credential revision invalidates a fresh usage cache without listing accounts")
  } finally {
    revision.mock.restore()
    read.mock.restore()
    for (const list of lists) list.mock.restore()
  }
}

// A rotation during an endpoint request cannot overwrite a newer login's cache.
{
  const capability = providerHost.accountCapabilities.get("grok")!
  let current = "inflight-old"
  const revision = mock.method(capability, "credentialRevision", async () => current)
  const entered = Promise.withResolvers<void>()
  const obsolete = Promise.withResolvers<AccountUsage>()
  let calls = 0
  const read = mock.method(capability, "accountUsage", async () => {
    calls++
    if (calls === 1) { entered.resolve(); return obsolete.promise }
    return { status: "ok" as const, windows: [{ usedPercent: 12, windowMinutes: 60, resetsAt: Date.now() + 60_000 }] }
  })
  try {
    const old = accountUsage("grok", "default")
    await entered.promise
    current = "inflight-new"
    const latest = await accountUsage("grok", "default")
    obsolete.resolve({ status: "error", detail: "Obsolete request failed" })
    assert.equal((await old).status, "error", "an obsolete response cannot borrow a different login's good usage")
    assert.equal(await accountUsage("grok", "default"), latest, "an obsolete response cannot invalidate the newer revision")
    assert.equal(calls, 2)
  } finally { read.mock.restore(); revision.mock.restore() }
}

console.log(
  "Account discovery, usage parsing for every harness, and child environment isolation passed"
)
