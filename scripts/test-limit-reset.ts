import assert from "node:assert/strict"
import { classifyProviderFailure, permanentFailure, usageLimitWords, type ProviderFailureKind } from "@mako/host/contracts/provider-failure"
import { limitReset } from "@mako/host/contracts/limit-reset"
import { GIVE_UP_MS, nextRetry, RESET_MARGIN_MS, retryWords, transientCause } from "@mako/host/contracts/delivery-retry"

/**
 * A usage limit reads as one on every harness, with its reset when its words say it (`npm run test:delivery-retry`):
 * the exact lines that stopped this Mac's Fins on 2026-11-05, then each harness's other forms, and a multi-day reset
 * going once at its time rather than on the ten-minute steps.
 */

/** 14:25:45Z on the day Cursor's team plan ran out: 06:25:45 in Los Angeles, on Pacific Standard Time. */
const NOW = Date.UTC(2026, 10, 5, 14, 25, 45)
const HOUR = 60 * 60_000

const CURSOR = "Your team has reached its usage limit Please reach out to an admin to increase your limit, or return on 11/8/2026 when your usage resets."
const CLAUDE = "You've hit your weekly limit · resets 1pm (America/Los_Angeles)"

for (const words of [CURSOR, CLAUDE]) {
  assert.equal(classifyProviderFailure(words).kind, "rate-limited", words)
  assert.equal(usageLimitWords(words), true, words)
  assert.equal(permanentFailure(words), false, words)
  assert.equal(transientCause(words, classifyProviderFailure(words).kind, false), "rate-limited", words)
}
assert.equal(limitReset(CURSOR, NOW), new Date(2026, 10, 8).getTime(), "Cursor's date, from the start of that day here")
// 1pm PST is 21:00Z, that same day: the next time that clock reads 1pm.
assert.equal(limitReset(CLAUDE, NOW), Date.UTC(2026, 10, 5, 21, 0), "Claude's clock in the zone it names")
// Past 1pm there, it's tomorrow's.
assert.equal(limitReset(CLAUDE, Date.UTC(2026, 10, 5, 22, 0)), Date.UTC(2026, 10, 6, 21, 0), "a clock already past is tomorrow's")

/** Each harness's forms: the words, how they classify and when they say it resets, from `NOW`. */
const forms: [string, ProviderFailureKind, number | undefined][] = [
  ["You've hit your session limit · resets 5:10am", "rate-limited", undefined],
  ["You've hit your limit · resets Nov 8, 1pm (America/Los_Angeles)", "rate-limited", Date.UTC(2026, 10, 8, 21, 0)],
  ["You've hit your weekly limit · resets Nov 8 at 9:30am (UTC)", "rate-limited", Date.UTC(2026, 10, 8, 9, 30)],
  ["Claude usage limit reached. Your limit will reset at 7pm (America/New_York).", "rate-limited", Date.UTC(2026, 11 - 1, 6, 0, 0)],
  ["Claude AI usage limit reached|1793921400", "rate-limited", 1793921400 * 1000],
  ["You've hit your usage limit. Try again in 3 hours.", "rate-limited", NOW + 3 * HOUR],
  ["You've hit your usage limit. Upgrade to Pro or try again in 2 days 3 hours 2 minutes.", "rate-limited", NOW + 51 * HOUR + 2 * 60_000],
  ["You have hit your usage limit. Try again in 3h 20m.", "rate-limited", NOW + 3 * HOUR + 20 * 60_000],
  ["usage_limit_reached: resets at 2026-11-07T04:00:00Z", "rate-limited", Date.UTC(2026, 10, 7, 4, 0)],
  ["Quota exhausted", "rate-limited", undefined],
  ["429 Too Many Requests: retry after 90", "rate-limited", NOW + 90_000],
  ["429 Too Many Requests", "rate-limited", undefined],
  ["Rate limited", "rate-limited", undefined],
]
for (const [words, kind, at] of forms) {
  assert.equal(classifyProviderFailure(words).kind, kind, words)
  if (at !== undefined) assert.equal(limitReset(words, NOW), at, words)
  assert.ok(transientCause(words, kind, false), words)
}
// Without a zone a clock is this machine's: the next time it reads that, within a day.
{
  const at = limitReset("You've hit your usage limit. Try again at 6:26 PM.", NOW)!
  const shown = new Date(at)
  assert.deepEqual([shown.getHours(), shown.getMinutes()], [18, 26])
  assert.ok(at > NOW && at - NOW <= 24 * HOUR)
}
// Capacity isn't a limit with a reset, a date gone by or a misread far off names none, and a stray zone isn't fatal.
for (const words of ["[unavailable] Server at capacity", "resets 1/1/2020", "return on 3/1/2031 when your usage resets"])
  assert.equal(limitReset(words, NOW), undefined, words)
assert.ok(limitReset("You've hit your limit · resets 1pm (Not/AZone)", NOW))
assert.equal(usageLimitWords("Server at capacity"), false)
// A limit's plan words don't make it the person's to fix: it clears at its reset.
assert.equal(permanentFailure("You've hit your limit. Upgrade your plan to keep going."), false)
assert.equal(classifyProviderFailure("You've hit your limit. Upgrade your plan to keep going.").kind, "rate-limited")
// What it wasn't before: a plan that doesn't cover a model is still the person's, and a model's context is still that.
assert.equal(classifyProviderFailure("Your plan does not include this model").kind, "plan")
assert.equal(classifyProviderFailure("prompt is too long: 214031 tokens > 200000 maximum").kind, "context-exhausted")
console.log("limit words: Cursor's and Claude's exact lines and every harness's other forms read as usage limits, with their resets")

// A reset three days off goes once, at it, and outlasts the six hours a limit with no reset is waited out.
{
  const until = new Date(2026, 10, 8).getTime()
  const retry = nextRetry(undefined, "rate-limited", CURSOR, NOW)!
  assert.equal(retry.until, until)
  assert.equal(retry.at, until + RESET_MARGIN_MS, "it goes after the reset, not in ten seconds")
  assert.equal(nextRetry(retry, "rate-limited", CURSOR, NOW + 7 * HOUR)?.at, until + RESET_MARGIN_MS, "a wait past six hours is no failure while the reset is ahead")
  // Refused again past its reset, the words name nothing still to come: the steps go on from the reset, and end.
  const past = until + RESET_MARGIN_MS
  const again = nextRetry(retry, "rate-limited", CURSOR, past)
  assert.ok(again && again.at - past <= 30_000, "after its reset it tries on the steps")
  assert.equal(nextRetry(again, "rate-limited", CURSOR, until + GIVE_UP_MS["rate-limited"]), undefined, "a limit that never lifted ends in a failure")
  assert.match(retryWords(retry, "Cursor", NOW), /^Cursor is at its usage limit until /)
  assert.equal(retryWords({ cause: "rate-limited" }, "Cursor", NOW), "Cursor is at capacity or its usage limit")
}
console.log("limit waits: a reset days off goes once at it, outlasts the bound, and ends if the limit never lifted")
