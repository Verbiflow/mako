import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { AccountLimits } from "../src/components/identity/account-usage"
import { IdentityRow } from "../src/components/identity/identity-row"
import { accountGroups, accountsStore } from "../src/state/accounts"
import {
  balanceText,
  planText,
  readingAgeText,
  resetCreditsText,
  resetText,
  usageTone,
  usageWindowName,
  usedText,
} from "../src/lib/usage-window"

/**
 * Plan limits read the same in the identity menu, Settings → Agents and
 * Settings → Usage because all three render these components. These checks
 * render them from a fixture store, without a host.
 */

const minute = 60_000
const hour = 60 * minute
const day = 24 * hour
const now = Date.parse("2026-09-30T12:00:00Z")

assert.equal(usageWindowName({ usedPercent: 0, windowMinutes: 300, resetsAt: null }), "5-hour limit")
assert.equal(usageWindowName({ usedPercent: 0, windowMinutes: 1_440, resetsAt: null }), "Daily limit")
assert.equal(
  usageWindowName({ usedPercent: 0, windowMinutes: 10_080, resetsAt: null, scope: "Opus" }),
  "Weekly Opus limit"
)
assert.equal(usageWindowName({ usedPercent: 0, windowMinutes: 43_200, resetsAt: null }), "Monthly limit")
assert.equal(usageWindowName({ usedPercent: 0, windowMinutes: 0, resetsAt: null }), "Current period limit")

assert.equal(usedText(41.6), "42% used")
assert.equal(usedText(100), "Limit reached")
assert.deepEqual([74, 75, 89, 90].map(usageTone), ["neutral", "caution", "caution", "negative"])

assert.equal(resetText(null, now), null)
assert.equal(resetText(now - minute, now), "resets now")
assert.equal(resetText(now + 48 * minute, now), "resets in 48m")
assert.equal(resetText(now + 2 * hour + 13 * minute, now), "resets in 2h 13m")
assert.equal(resetText(now + 7 * hour, now), "resets in 7h")
assert.match(resetText(now + 3 * day, now) ?? "", /^resets \S+ \d{1,2}:\d{2}/)
assert.match(resetText(now + 25 * day, now) ?? "", /^resets \S+ \d{1,2}$/)

assert.equal(
  balanceText({ label: "Promotional credit", remaining: 3_730.31, total: 5_000, unit: "usd" }),
  "$3,730 of $5,000 promotional credit left"
)
assert.equal(balanceText({ label: "Extra usage", remaining: 39.5, unit: "usd" }), "$39.50 extra usage left")
assert.equal(balanceText({ label: "On-demand", remaining: 20, total: 20, unit: "usd" }), "$20 on-demand left")
assert.equal(balanceText({ label: "Credits", remaining: 62_494.05, unit: "credits" }), "62,494 credits left")
assert.equal(resetCreditsText({ available: 1, expiresAt: null }), "1 reset available")
assert.match(resetCreditsText({ available: 2, expiresAt: now + 22 * day }), /^2 resets available · first expires \S+ \d{1,2}$/)
assert.equal(readingAgeText(now - 4 * minute, now), null, "a fresh reading says nothing about its age")
assert.equal(readingAgeText(now - 12 * minute, now), "Read 12m ago")
assert.equal(readingAgeText(now - 3 * hour, now), "Read 3h ago")
assert.equal(planText("pro"), "Pro")
assert.equal(planText("X Premium+"), "X Premium+")

accountsStore.set({
  loadedAt: now,
  providers: [
    { provider: "claude", label: "Claude Code", mode: "selectable", loginCommand: "claude /login" },
    { provider: "codex", label: "Codex", mode: "selectable", loginCommand: "codex login" },
    { provider: "cursor", label: "Cursor", mode: "observed", loginCommand: "cursor-agent login" },
    { provider: "devin", label: "Devin", mode: "observed", loginCommand: "devin auth login" },
  ],
  accounts: [
    { harness: "codex", name: "default", email: "codex@example.com", active: false },
    { harness: "claude", name: "default", email: "personal@example.com", active: true },
    { harness: "codex", name: "personal", email: "personal@work.dev", active: true },
    { harness: "claude", name: "work", email: "work@example.com", active: false, source: "subrouter" },
    { harness: "cursor", name: "default", email: "cursor@example.com", active: true, source: "cli" },
  ],
  usage: {
    "claude:default": {
      status: "ok",
      plan: "max",
      windows: [
        { usedPercent: 42, windowMinutes: 300, resetsAt: Date.now() + 2 * hour },
        { usedPercent: 81, windowMinutes: 10_080, resetsAt: Date.now() + 3 * day, scope: "Opus" },
      ],
    },
    "claude:work": { status: "stale-token", detail: "Usage returns after this account’s next Claude Code run" },
    "codex:personal": {
      status: "ok",
      plan: "plus",
      windows: [
        { usedPercent: 34, windowMinutes: 300, resetsAt: Date.now() + 48 * minute },
        { usedPercent: 92, windowMinutes: 10_080, resetsAt: Date.now() + 2 * day },
      ],
      resetCredits: { available: 2, expiresAt: Date.now() + 22 * day },
      readAt: Date.now() - 40 * minute,
    },
    "cursor:default": {
      status: "ok",
      plan: "Team",
      windows: [],
      balances: [{ label: "Promotional credit", remaining: 3_730.31, total: 5_000, unit: "usd" }],
    },
  },
})

const groups = accountGroups(accountsStore.get())
assert.deepEqual(
  groups.map((group) => [group.provider.provider, group.accounts.map((account) => account.name)]),
  [
    ["claude", ["default", "work"]],
    ["codex", ["default", "personal"]],
    ["cursor", ["default"]],
  ],
  "accounts group under their harness in provider order; a harness with no login is left out"
)
accountsStore.set((state) => ({ usage: { ...state.usage, "codex:default": { status: "error", detail: "HTTP 500" } } }))
assert.equal(accountGroups(accountsStore.get()), groups, "a usage reading does not regroup accounts")

const menu = renderToStaticMarkup(<AccountLimits density="menu" />)
const order = ["Claude Code", "Codex", "Cursor"].map((label) => menu.indexOf(`aria-label="${label} accounts"`))
assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), "one section per harness, in order")
assert.match(menu, /2 accounts/)
assert.match(menu, /role="meter" aria-label="5-hour limit"[^>]*aria-valuenow="42"/)
assert.match(menu, /aria-label="Weekly Opus limit"[^>]*aria-valuenow="81"/)
assert.match(menu, /text-caution">81% used</)
assert.match(menu, /text-negative">92% used</)
assert.match(menu, /resets in 47m|resets in 48m/)
assert.match(menu, /Usage returns after this account’s next Claude Code run/)
assert.match(menu, /Couldn&#x27;t read usage/)
assert.match(menu, /\$3,730 of \$5,000 promotional credit left/)
assert.match(menu, /No usage limits reported for this plan/)
assert.match(menu, />Max</)
assert.match(menu, />2 resets available · Read 40m ago</, "the menu names the credits; their expiry is in the tooltip")
assert.match(menu, /title="2 resets available · first expires/)
assert.match(menu, />Reads after its next run</, "another login is one line in the menu")
const page = renderToStaticMarkup(<AccountLimits density="page" />)
assert.match(page, />2 resets available · first expires \S+ \d{1,2} · Read 40m ago</)
assert.match(page, />Usage returns after this account’s next Claude Code run</)
assert.match(page, />Weekly Opus limit</, "Settings names each window in full")
assert.match(menu, />Opus</, "the menu names a scoped window by its scope")
assert.match(menu, /Read 40m ago/, "a kept reading says how old it is")
assert.equal((menu.match(/Use a reset credit/g) ?? []).length, 1, "a reset is offered only where a window is nearly out")
assert.ok(menu.indexOf("Use a reset credit") > menu.indexOf('aria-label="Codex accounts"'))
assert.equal((menu.match(/aria-pressed="true"/g) ?? []).length, 2, "each switchable harness marks its own active account")
assert.doesNotMatch(
  menu.slice(menu.indexOf('aria-label="Cursor accounts"')),
  /aria-pressed/,
  "a CLI-owned login is not a switch"
)

accountsStore.set((state) => {
  const { "cursor:default": _cursor, ...usage } = state.usage
  return { usage }
})
accountsStore.set((state) => ({
  usage: {
    ...state.usage,
    "claude:default": { status: "ok", windows: [{ usedPercent: 100, windowMinutes: 300, resetsAt: Date.now() - minute }] },
  },
}))
const passed = renderToStaticMarkup(<AccountLimits density="menu" />)
assert.match(passed, /aria-label="5-hour limit"[^>]*aria-valuenow="0"[^>]*aria-valuetext="0% used, just reset"/,
  "a window past its reset reads empty until the new reading arrives")
const loading = renderToStaticMarkup(<AccountLimits density="page" />)
assert.match(loading, /aria-label="Loading usage"/)

assert.doesNotMatch(renderToStaticMarkup(<IdentityRow />), /% used|at its limit/, "limits live in the menu, not beside the name")

console.log("Account limits render grouped by harness with named windows, resets, balances, and nothing beside the name")
