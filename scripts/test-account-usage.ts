import assert from "node:assert/strict"
import { mock } from "node:test"
import { type UsageWindow } from "@mako/host/contracts/accounts"
import { bindingWindow, hasReset, limitOffer, mergeWindows, nextReset } from "@mako/host/contracts/account-usage"
import { codexUpdatedWindows, parseCodexRateLimits, parseResetOutcome } from "@mako/host/harnesses/codex/rate-limits"
import { resetCreditRequest } from "@mako/host/harnesses/codex/accounts"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import type { AccountUsage, HarnessAccount } from "@mako/host/contracts/accounts"
import { parseChatGptUsage } from "@mako/host/harnesses/chatgpt-usage"
import { spendWatch } from "@mako/host/usage/index"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { HostJobs, type JobDemand } from "@mako/host/base/host-jobs"
import { claudeRateLimitWindow, parseClaudeUsage } from "@mako/host/harnesses/claude/accounts"
import {
  parseCursorGrants,
  parseCursorPeriodUsage,
  parseCursorPlan,
} from "@mako/host/harnesses/cursor/accounts"
import {
  devinCredential,
  parseDevinStatus,
} from "@mako/host/harnesses/devin/accounts"
import {
  parseGrokAccounts,
  parseGrokBilling,
} from "@mako/host/harnesses/grok/accounts"
import { parseOpenCodeAccounts } from "@mako/host/harnesses/opencode/accounts"
import { normalizeOpenCodeModels } from "@mako/sessions/model-catalog"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const nativeStores = new NativeStores(false)

const providerHost = createHarnessHost(detachedHarnessContext(nativeStores))

const { accounts } = providerHost

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

// A model's weekly cap reported only in `limits` (the live API on
// 2026-10-13: "Fable", with the per-model fields null); one that has its own
// field is not read twice, and the session and weekly entries add nothing.
const scoped = parseClaudeUsage(
  JSON.stringify({
    five_hour: { utilization: 94, resets_at: "2026-10-13T10:20:00.429087+00:00" },
    seven_day: { utilization: 32, resets_at: "2026-10-13T21:00:00.429116+00:00" },
    seven_day_opus: { utilization: 81, resets_at: "2026-10-13T21:00:00Z" },
    seven_day_sonnet: null,
    limits: [
      { kind: "session", group: "session", percent: 94, resets_at: "2026-10-13T10:20:00.429087+00:00", scope: null },
      { kind: "weekly_all", group: "weekly", percent: 32, resets_at: "2026-10-13T21:00:00.429116+00:00", scope: null },
      { kind: "weekly_scoped", group: "weekly", percent: 9, resets_at: "2026-10-13T21:00:00.429370+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null } },
      { kind: "weekly_scoped", group: "weekly", percent: 81, resets_at: "2026-10-13T21:00:00Z", scope: { model: { id: null, display_name: "Opus" }, surface: null } },
      { kind: "weekly_scoped", group: "weekly", percent: 5, resets_at: null, scope: { model: null, surface: "chat" } },
    ],
  })
)
assert.deepEqual(
  scoped.windows.map((window) => [usageLabel(window), window.usedPercent]),
  [["300", 94], ["10080", 32], ["10080:Opus", 81], ["10080:Fable", 9]]
)
assert.equal(scoped.windows[3]?.resetsAt, Date.parse("2026-10-13T21:00:00.429370+00:00"))
assert.deepEqual(parseClaudeUsage(JSON.stringify({ limits: "unexpected" })).windows, [])

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
assert.equal(accounts.usage.spent("codex"), true)
assert.equal(accounts.usage.spent("codex"), false)
assert.equal(accounts.usage.spent("not-a-provider"), false)

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

const childEnv = await accounts.env("opencode", {
  PATH: "/fixture/bin",
  MAKO_CUA_SOCKET: "/fixture/cua.sock",
  MAKO_DATA_ROOT: "/fixture/Application Support/mako",
  MAKO_WEB_SOCKET: "/fixture/mako-host/host.sock",
  MAKO_HOST_EXECUTABLE: "/fixture/Mako.app/Contents/MacOS/Mako",
  MAKO_AGENT_VIEWS: "1",
  MAKO_PROFILE: "dev",
})
assert.equal(childEnv.PATH, "/fixture/bin")
assert.equal(childEnv.MAKO_CUA_SOCKET, undefined)
// The host's own launch variables stay with the host: an agent that runs
// `npm run dev` from a provider process must start or attach to the dev
// profile, not the host that spawned it.
for (const key of ["MAKO_DATA_ROOT", "MAKO_WEB_SOCKET", "MAKO_HOST_EXECUTABLE", "MAKO_AGENT_VIEWS", "MAKO_PROFILE"])
  assert.equal(childEnv[key], undefined, `${key} leaked into a provider process`)

// Observed providers keep their own single login and inherit ordinary
// process values while Mako runtime secrets stay isolated.
const cursorEnv = await accounts.env("cursor", {
  PATH: "/fixture/bin",
  CURSOR_API_KEY: "provider-owned-fixture",
  MAKO_CUA_SOCKET: "/fixture/cua.sock",
})
assert.deepEqual(cursorEnv, {
  PATH: "/fixture/bin",
  CURSOR_API_KEY: "provider-owned-fixture",
})
assert.deepEqual((await accounts.launch("cursor", { PATH: "/fixture/bin" }, { trackCredential: false })).account, { name: "default" })

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
    const [a, b] = await Promise.all([accounts.usage.read("grok", "default"), accounts.usage.read("grok", "default")])
    assert.equal(calls, 1, "readers asking at once share one request")
    assert.equal(a, b)
    assert.ok(a.status === "ok" && a.readAt !== undefined, "a good reading carries when it was taken")
    await accounts.usage.read("grok", "default")
    assert.equal(calls, 1, "a fresh reading is served from the cache")
    await new Promise((resolve) => setTimeout(resolve, 100))
    next = () => ({ status: "error", detail: "HTTP 429" })
    const kept = await accounts.usage.read("grok", "default")
    assert.equal(calls, 2, "a window that reset makes the reading expire")
    assert.equal(kept.status, "error", "a reading whose window reset is not kept through a failure")

    next = () => ({ status: "ok", windows: [{ usedPercent: 30, windowMinutes: 1_440, resetsAt: Date.now() + 3_600_000 }] })
    accounts.usage.spent("grok", 0)
    const good = await accounts.usage.read("grok", "default")
    next = () => ({ status: "error", detail: "HTTP 429" })
    accounts.usage.spent("grok", 0)
    assert.equal(await accounts.usage.read("grok", "default"), good, "a failed refresh keeps the last good reading")

    await accounts.list()
    identity = "second@example.com"
    await accounts.list()
    next = () => ({ status: "ok", windows: [{ usedPercent: 1, windowMinutes: 1_440, resetsAt: Date.now() + 3_600_000 }] })
    const fresh = await accounts.usage.read("grok", "default")
    assert.ok(fresh.status === "ok" && fresh.windows[0]?.usedPercent === 1, "a different login under the same name reads afresh")

    const heard: AccountUsage[] = []
    const stop = accounts.usage.onChange((harness, name, usage) => { if (harness === "grok" && name === "default") heard.push(usage) })
    const before = calls
    accounts.usage.observe("grok", "default", (previous) => mergeWindows(previous, [{ usedPercent: 55, windowMinutes: 1_440, resetsAt: Date.now() + 3_600_000 }], Date.now()))
    stop()
    assert.equal(calls, before, "a live reading needs no request")
    const amended = await accounts.usage.read("grok", "default")
    assert.ok(amended.status === "ok" && amended.windows[0]?.usedPercent === 55)
    assert.equal(heard[0], amended, "listeners hear the amended reading")
    credential = "rotated-credential"
    next = () => ({ status: "error", detail: "HTTP 429" })
    const rotated = await accounts.usage.read("grok", "default")
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
    const old = accounts.usage.read("grok", "default")
    await entered.promise
    current = "inflight-new"
    const latest = await accounts.usage.read("grok", "default")
    obsolete.resolve({ status: "error", detail: "Obsolete request failed" })
    assert.equal((await old).status, "error", "an obsolete response cannot borrow a different login's good usage")
    assert.equal(await accounts.usage.read("grok", "default"), latest, "an obsolete response cannot invalidate the newer revision")
    assert.equal(calls, 2)
  } finally { read.mock.restore(); revision.mock.restore() }
}

// At a plan limit: another account with room is offered, never taken; a harness with one account is never read for it.
{
  const now = Date.now()
  const window = (usedPercent: number): UsageWindow => ({ usedPercent, windowMinutes: 300, resetsAt: now + 3_600_000 })
  const ok = (usedPercent: number, windows = [window(usedPercent)]): AccountUsage => ({ status: "ok", windows })
  assert.equal(limitOffer("codex", [{ name: "a", active: true, usage: ok(95) }], now), null, "no other account, no offer")
  assert.equal(limitOffer("codex", [{ name: "a", active: true, usage: ok(50) }, { name: "b", usage: ok(0) }], now), null, "room left, no offer")
  assert.deepEqual(limitOffer("codex", [{ name: "a", email: "a@x", active: true, usage: ok(95) }, { name: "b", usage: ok(80) }, { name: "c", email: "c@x", usage: ok(12) }], now), {
    harness: "codex", because: "near-limit", from: { name: "a", email: "a@x", window: window(95) }, to: { name: "c", email: "c@x", window: window(12) },
  })
  assert.equal(limitOffer("codex", [{ name: "a", active: true, usage: ok(95) }, { name: "b", usage: ok(75) }], now), null, "an account nearly as spent is no way out")
  assert.equal(limitOffer("codex", [{ name: "a", active: true, usage: ok(95) }, { name: "b", usage: { status: "error" } }], now), null, "an unread account may be as spent")
  assert.equal(limitOffer("codex", [{ name: "a", active: true, usage: ok(10) }, { name: "b", usage: ok(5) }], now, true)?.because, "refused", "a refused turn offers whatever the reading says")
  assert.equal(limitOffer("codex", [{ name: "a", active: true, usage: ok(95, [{ ...window(95), resetsAt: now - 1 }]) }, { name: "b", usage: ok(5) }], now), null, "a window past its reset has emptied")

  const capability = providerHost.accountCapabilities.get("devin")!
  const listed: HarnessAccount[] = [{ harness: "devin", name: "default", dir: "", active: true, source: "cli" }]
  const list = mock.method(capability, "listAccounts", async () => listed)
  const reads: string[] = []
  const percent = new Map([["default", 96], ["spare", 8]])
  const read = mock.method(capability, "accountUsage", async (name: string) => { reads.push(name); return ok(percent.get(name) ?? 0) })
  try {
    assert.equal(await accounts.limitOffer("devin"), null)
    assert.deepEqual(reads, [], "one account: nothing read")
    listed.push({ harness: "devin", name: "spare", dir: "", active: false, source: "mako", email: "spare@x" })
    const offer = await accounts.limitOffer("devin")
    assert.equal(offer?.to.name, "spare")
    assert.equal(offer?.from.window?.usedPercent, 96)
    assert.equal(await accounts.limitOffer("devin"), null, "an offer near a limit comes once an hour")
    percent.set("default", 20)
    accounts.usage.forget("devin", "default")
    assert.equal((await accounts.limitOffer("devin", true))?.because, "refused", "a refused turn always asks")
    assert.match(await accounts.switchSuggestion("devin") ?? "throttled", /throttled/)
  } finally {
    list.mock.restore()
    read.mock.restore()
    accounts.usage.forget("devin", "default")
    accounts.usage.forget("devin", "spare")
  }
}

// Limits spent where Mako can't see: a background read reuses a fresh reading, keeps the shown one through a failure, and tells only of a change.
{
  const capability = providerHost.accountCapabilities.get("claude")!
  assert.ok(capability.usedElsewhere, "Claude's limits are spent on the web too")
  const told: number[] = []
  const stop = accounts.usage.onChange((harness, _name, usage) => { if (harness === "claude" && usage.status === "ok") told.push(usage.windows[0]?.usedPercent ?? -1) })
  const revision = mock.method(capability, "credentialRevision", async () => "fixture")
  let calls = 0
  let next: AccountUsage = { status: "ok", windows: [{ usedPercent: 30, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 }] }
  const reader = async () => { calls++; return next }
  try {
    accounts.usage.forget("claude", "default")
    assert.equal((await accounts.usage.readElsewhere("claude", "default", reader)).status, "ok")
    assert.deepEqual(told, [30])
    await accounts.usage.readElsewhere("claude", "default", reader)
    assert.equal(calls, 1, "a fresh reading costs no request")
    accounts.usage.spent("claude", 0)
    next = { status: "error", detail: "HTTP 429" }
    assert.equal((await accounts.usage.readElsewhere("claude", "default", reader)).status, "error")
    assert.deepEqual(told, [30], "a failed background read tells no one and blanks nothing")
    const resetsAt = Date.now() + 3_600_000
    next = { status: "ok", windows: [{ usedPercent: 45, windowMinutes: 300, resetsAt }] }
    await accounts.usage.readElsewhere("claude", "default", reader)
    accounts.usage.spent("claude", 0)
    await accounts.usage.readElsewhere("claude", "default", reader)
    assert.deepEqual(told, [30, 45], "a moved reading is told once; the same reading again tells no one")
  } finally {
    stop()
    revision.mock.restore()
    accounts.usage.forget("claude", "default")
  }

  // The watch: each harness on its own interval, twice as long after each failure, up to an hour, only while a window listens.
  let tick: (() => void | Promise<void>) | undefined
  let needs: readonly JobDemand[] = []
  const jobs: Pick<HostJobs, "every"> = { every: (_name, _everyMs, run, options) => { tick = run; needs = options?.needs ?? []; return () => {} } }
  const failing = mock.method(capability.usedElsewhere!, "read", async () => ({ status: "error", detail: "HTTP 503" }))
  const clock = mock.method(Date, "now", () => 1_000_000)
  try {
    accounts.watchElsewhere(jobs, [new HostJobs().demand("a client is subscribed")])
    assert.deepEqual(needs.map((demand) => demand.name), ["a client is subscribed"])
    await tick!()
    assert.equal(failing.mock.callCount(), 1)
    clock.mock.mockImplementation(() => 1_000_000 + capability.usedElsewhere!.everyMs + 1)
    await tick!()
    assert.equal(failing.mock.callCount(), 1, "after a failure, waits twice the interval")
    clock.mock.mockImplementation(() => 1_000_000 + 2 * capability.usedElsewhere!.everyMs + 1)
    await tick!()
    assert.equal(failing.mock.callCount(), 2)
  } finally {
    clock.mock.restore()
    failing.mock.restore()
    accounts.usage.forget("claude", "default")
  }
}

// The reset credit's request and answers, held to the schema Codex 0.159.3 generates (`codex app-server
// generate-json-schema`), so the button's shape is proven without spending a real credit.
{
  const fixtures = join(import.meta.dirname, "fixtures", "codex-reset-credit")
  const params = JSON.parse(readFileSync(join(fixtures, "ConsumeAccountRateLimitResetCreditParams.json"), "utf8"))
  const response = JSON.parse(readFileSync(join(fixtures, "ConsumeAccountRateLimitResetCreditResponse.json"), "utf8"))
  const sent = resetCreditRequest("attempt-1")
  for (const key of params.required) assert.ok(key in sent, `the request carries ${key}`)
  for (const key of Object.keys(sent)) assert.ok(key in params.properties, `${key} is a field Codex reads`)
  const outcomes: string[] = response.definitions.ConsumeAccountRateLimitResetCreditOutcome.oneOf.flatMap((entry: { enum: string[] }) => entry.enum)
  assert.deepEqual(outcomes.sort(), ["alreadyRedeemed", "noCredit", "nothingToReset", "reset"])
  for (const outcome of outcomes) assert.notEqual(parseResetOutcome({ outcome }), null, `${outcome} is an answer Mako knows`)
}

// Every live turn's end is heard, with whether the harness refused it on a limit or the plan; spend reads stay throttled.
{
  const ended: [string, boolean][] = []
  let allowed = true
  const watch = spendWatch(() => "codex", () => allowed, (harness, refused) => ended.push([harness, refused]))
  const batch = (status: LiveSessionState["status"], error?: string): HostEvent => {
    const sessionChanges: Partial<LiveSessionState> = { status }
    if (error) sessionChanges.error = error
    return { type: "live-batch", batch: { id: "c", revision: 1, updates: [], sessionChanges } }
  }
  watch(batch("running"))
  assert.deepEqual(watch(batch("failed", "You've hit your usage limit. Upgrade to Pro or try again at 4pm.")), { type: "account-usage-spent", harness: "codex" })
  watch(batch("running"))
  allowed = false
  assert.equal(watch(batch("ready")), undefined, "a throttled read sends nothing")
  watch(batch("running"))
  watch(batch("failed", "Payment required: insufficient credits"))
  watch(batch("running"))
  watch(batch("failed", "ECONNRESET"))
  assert.deepEqual(ended, [["codex", true], ["codex", false], ["codex", true], ["codex", false]])
}

console.log(
  "Account discovery, usage parsing for every harness, child environment isolation, offers at a plan limit, reads of limits spent elsewhere, and refused turns heard passed"
)
