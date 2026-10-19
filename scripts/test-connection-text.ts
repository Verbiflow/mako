import assert from "node:assert/strict"
import { formatRelative, formatUntil } from "@/lib/format"
import { connectionStatusText } from "@/lib/provider-connection-text"
import type { ProviderConnection } from "@/lib/types"

/**
 * A connection's line says how long its key lasts. Cursor's browser-minted key lasts 90 days, and the line read
 * "expires now" for all of them: it went through `formatRelative`, which reads only the past.
 */
const now = Date.parse("2026-10-19T12:00:00Z")
const day = 86_400_000
assert.equal(formatUntil(now + 90 * day - 60_000, now), "in 89 days")
assert.equal(formatUntil(now + 5 * 3_600_000 + 60_000, now), "in 5 h")
assert.equal(formatUntil(now + 30 * 60_000, now), "in 30 min")
assert.equal(formatUntil(now + 10_000, now), "in 1 min")
assert.equal(formatUntil(now - 1, now), "expired")
assert.match(formatUntil(now + 400 * day, now), /^on /)
assert.equal(formatRelative(Date.now() + 90 * day), "now", "formatRelative reads the past only, which is why it can't word an expiry")

const cursor = (expiresAt?: string): ProviderConnection => {
  const connection: ProviderConnection = {
    provider: "cursor",
    label: "Cursor",
    description: "",
    secureStorage: true,
    state: { status: "signed-in", source: "mako", method: "browser", account: "ada@example.com" },
  }
  if (expiresAt !== undefined && connection.state.status === "signed-in") connection.state.expiresAt = expiresAt
  return connection
}
const minted = connectionStatusText(cursor(new Date(Date.now() + 90 * day).toISOString()))
assert.match(minted, /^Signed in as ada@example\.com · from Mako's browser sign-in · expires in (89|90) days$/)
assert.ok(!minted.includes("now"))
assert.equal(connectionStatusText(cursor(new Date(Date.now() - day).toISOString())), "Signed in as ada@example.com · from Mako's browser sign-in · expired")
assert.equal(connectionStatusText(cursor()), "Signed in as ada@example.com · from Mako's browser sign-in", "a key with no expiry says none")
console.log("Connection text: a key's expiry reads as time to come (in 89 days, in 5 h, expired), never “now”")
