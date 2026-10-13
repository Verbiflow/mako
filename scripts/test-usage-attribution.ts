import assert from "node:assert/strict"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { MockLanguageModelV4 } from "ai/test"
import { CURRENT_PRICE_TABLE, conversationSpend, turnTrigger, type HelperRun, type TurnSpend } from "@mako/host/contracts/usage-ledger"
import type { LiveRequest } from "@mako/host/contracts/live-conversations"
import { ActorSchema } from "@mako/host/contracts/thread-identity"
import type { LiveSessionState } from "@mako/host/contracts/providers-acp"
import { settleRequest } from "@mako/host/conversations/live-settlement"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { languageUtilityModel } from "@mako/host/git/utility-work"
import { HelperRuns } from "@mako/host/usage/helper-runs"
import { priceEstimate } from "@mako/host/usage/pricing"
import { usageSummary } from "@mako/host/usage/summary"
import { auditSnapshot } from "./performance-audit-fixtures.ts"

/**
 * MH-32's accounting: occupancy, spend and the harness's own total stay
 * apart; every turn's spend is priced once with the table it names; every
 * model call Mako makes itself is a helper run with what asked for it; and a
 * compaction nothing measured reopens unmeasured.
 */

const tokens = (input: number, cacheRead: number, output: number) => ({ input, cacheRead, cacheWrite: 0, output })
const turn = (spend: TurnSpend, extra: Partial<LiveRequest> = {}): LiveRequest => ({ id: crypto.randomUUID(), text: "", attachments: [], status: "completed", spend, ...extra })

// A conversation's spend sums each turn's own record: reported cost and Mako's estimate apart, the tables named.
{
  const spent = conversationSpend([
    turn({ provider: "claude", at: 1, tokens: tokens(10, 100, 5), cost: 0.5 }),
    turn({ provider: "codex", at: 2, tokens: tokens(20, 200, 10), estimate: { amount: 0.25, currency: "USD", table: "2026-10-06" } }),
    turn({ provider: "devin", at: 3, tokens: tokens(1, 1, 1), unrecorded: "tokens" }),
    turn({ provider: "grok", at: 4, tokens: tokens(1, 1, 1), cost: 0.01, unrecorded: "cost" }),
    { id: "queued", text: "", attachments: [], status: "queued" },
  ])
  assert.equal(spent.turns, 4)
  assert.deepEqual(spent.tokens, { input: 32, cacheRead: 302, cacheWrite: 0, output: 17 })
  assert.equal(spent.cost, 0.51, "only what harnesses priced is cost")
  assert.deepEqual(spent.estimate, { amount: 0.25, tables: ["2026-10-06"] }, "an estimate is its own figure, naming its table")
  assert.equal(spent.unpriced, 1, "a turn with tokens and no price makes the cost a floor")
  assert.deepEqual(spent.unrecorded, { tokens: 1, cost: 1 })
  assert.equal(spent.last?.provider, "grok")
  // The running turn counts as far as it has gone, from the reading it started at.
  const running = conversationSpend(
    [turn({ provider: "claude", at: 1, tokens: tokens(10, 0, 5), cost: 0.1 }), { id: "r", text: "", attachments: [], status: "dispatching", usageFrom: { tokens: tokens(10, 0, 5), cost: { amount: 0.1, currency: "USD" } } }],
    { tokens: tokens(30, 0, 15), cost: { amount: 0.4, currency: "USD" } },
    "claude"
  )
  assert.equal(running.turns, 2)
  assert.deepEqual(running.running?.tokens, tokens(20, 0, 10))
  assert.equal(running.cost, 0.4)
}

// What started each turn, from the request's own record.
assert.equal(turnTrigger({ actor: ActorSchema.parse({ kind: "person", principal: crypto.randomUUID() }) }), "message")
assert.equal(turnTrigger({ goal: { step: "continue", turn: 2 } }), "goal")
assert.equal(turnTrigger({ review: { kind: "changes" } }), "review")
assert.equal(turnTrigger({ continues: { requestId: "x", reason: "host-quit", auto: true } }), "continuation")
assert.equal(turnTrigger({ actor: ActorSchema.parse({ kind: "agent", session: crypto.randomUUID() }) }), "agent")
assert.equal(turnTrigger({ actor: { kind: "service", name: "goal" } }), "goal")
assert.equal(turnTrigger({ actor: { kind: "service", name: "auto-continue" } }), "service")

// Settling a turn prices it once from the current table, only when the harness priced nothing.
{
  const session = (harness: string, model: string, usage: LiveSessionState["usage"]): LiveSessionState =>
    ({ id: "s", harness, cwd: "/", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], settings: { model }, usage })
  const request: LiveRequest = { id: "q", text: "", attachments: [], status: "dispatching", usageFrom: { tokens: tokens(0, 0, 0) } }
  const codex = settleRequest(request, session("codex", "gpt-6.1-sol", { tokens: tokens(100_000, 50_000, 2_000) }), false).spend
  assert.equal(codex?.estimate?.table, CURRENT_PRICE_TABLE.id)
  assert.equal(codex?.estimate?.amount, priceEstimate("gpt-6.1-sol", { ...tokens(100_000, 50_000, 2_000), summed: true })?.amount)
  assert.equal(codex?.cost, undefined, "an estimate is never the harness's cost")
  const claude = settleRequest(request, session("claude", "claude-opus-5-5", { tokens: tokens(10, 0, 5), cost: { amount: 0.2, currency: "USD" } }), false).spend
  assert.equal(claude?.cost, 0.2)
  assert.equal(claude?.estimate, undefined, "a reported cost is never estimated over")
  const devin = settleRequest(request, session("devin", "swe-2", { tokens: tokens(10, 0, 5) }), false).spend
  assert.equal(devin?.estimate, undefined, "a model the table doesn't list stays unpriced, never zero")
}

const root = await mkdtemp(join(tmpdir(), "mako-usage-attribution-"))
try {
  // A journal from before October 12 kept the stale reading beside a flag: it reopens as what the context held before.
  {
    const snapshot = auditSnapshot(1, "devin")
    snapshot.session.usage = { used: 40_000, size: 200_000 }
    new LiveJournal(join(root, "journals"), snapshot.session.id).commit(snapshot)
    const db = new DatabaseSync(join(root, "journals", `${snapshot.session.id}.sqlite`))
    const metadata = JSON.parse(String(db.prepare("SELECT value FROM metadata WHERE id=1").get()?.value))
    metadata.session.usage = { used: 40_000, size: 200_000, compacted: true }
    db.prepare("UPDATE metadata SET value=? WHERE id=1").run(JSON.stringify(metadata))
    db.close()
    assert.deepEqual(new LiveJournal(join(root, "journals"), snapshot.session.id).read()?.session.usage, { size: 200_000, compactedFrom: 40_000 })
  }

  // A utility model's calls report the tokens their provider did, once per call, answered or not.
  {
    const reported: (ReturnType<typeof tokens> | undefined)[] = []
    let fail = false
    const model = languageUtilityModel(new MockLanguageModelV4({
      doGenerate: async () => {
        if (fail) throw new Error("provider down")
        return { content: [{ type: "text", text: "OK" }], finishReason: { unified: "stop", raw: "stop" }, usage: { inputTokens: { total: 1_200, noCache: 200, cacheRead: 1_000, cacheWrite: 0 }, outputTokens: { total: 30, text: 20, reasoning: 10 } }, warnings: [] }
      },
    }), { connection: { provider: "anthropic", model: "claude-haiku-4-5", contextTokens: 200_000 }, via: "Fixture", onUsage: (counted) => reported.push(counted) })
    const request = { instructions: "Reply OK", prompt: "Test", maxOutputTokens: 64, reasoning: "low" as const }
    assert.equal(await model.complete(request, AbortSignal.timeout(5_000)), "OK")
    fail = true
    await assert.rejects(model.complete(request, AbortSignal.timeout(5_000)))
    assert.deepEqual(reported, [{ input: 200, cacheRead: 1_000, cacheWrite: 0, output: 30, reasoning: 10 }, undefined])
  }

  // Helper runs: priced as written, listed newest first, read by the summary as sources of their own.
  {
    const helpers = new HelperRuns(join(root, "usage", "helper-runs"))
    const at = Date.now()
    const run = (id: string, purpose: HelperRun["purpose"], extra: Partial<HelperRun> = {}): HelperRun =>
      ({ id, at, purpose, trigger: "Generate commit message", connection: "anthropic/claude-haiku-4-5", cwd: "/repo", outcome: "completed", durationMs: 900, calls: 3, ...extra })
    helpers.record(run("draft", "commit-message", { tokens: tokens(5_000, 0, 400) }))
    helpers.record(run("check", "connection-check", { trigger: "Connect a model", calls: 1, tokens: tokens(12, 0, 2) }))
    helpers.record(run("failed", "commit-message", { outcome: "failed", calls: 1 }))
    // A file older than ninety days goes when the next run is written.
    await helpers.flushed()
    await writeFile(join(root, "usage", "helper-runs", "2020-01.jsonl"), "")
    helpers.record(run("later", "commit-message", { at: at + 1, tokens: tokens(1, 0, 1) }))
    // A run priced from an older table keeps that price and names it: a newer table never reprices it.
    helpers.record(run("older", "commit-message", { at: at + 2, tokens: tokens(1_000, 0, 10), estimate: { amount: 1.25, currency: "USD", table: "2026-01-01" } }))
    await helpers.flushed()
    assert.deepEqual((await readdir(join(root, "usage", "helper-runs"))).sort(), [`${new Date(at).toISOString().slice(0, 7)}.jsonl`])
    const listed = await helpers.list()
    assert.deepEqual(listed.map((entry) => entry.id), ["older", "later", "failed", "check", "draft"])
    assert.equal(listed.find((entry) => entry.id === "draft")?.estimate?.table, CURRENT_PRICE_TABLE.id, "priced from the table current when it was written")
    assert.equal(listed.find((entry) => entry.id === "failed")?.estimate, undefined, "a run with no tokens reported has no price")
    const summary = await usageSummary([], join(root, "sessions"), join(root, "home"), undefined, { helperRuns: join(root, "usage", "helper-runs"), env: {} })
    assert.deepEqual(summary.sources?.map((source) => source.source).sort(), ["Mako: Commit messages", "Mako: Model connection checks"])
    assert.equal(summary.sessions, 0, "helper runs are no sessions")
    assert.equal(summary.total.messages, 4, "a run with no tokens adds no event")
    assert.deepEqual(summary.priceTables, ["2026-01-01", CURRENT_PRICE_TABLE.id].sort())
    const priced = listed.filter((entry) => entry.estimate).reduce((sum, entry) => sum + entry.estimate!.amount, 0)
    assert.ok(Math.abs((summary.total.estimatedCost ?? 0) - priced) < 1e-9, "the summary adds the estimates as recorded, the older one at its own table")
    assert.ok((summary.total.estimatedCost ?? 0) > 0 && !summary.total.reportedCost, "Mako's own calls are estimates, never reported cost")
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log("Usage attribution: occupancy, spend and the harness's own total apart; turns priced once with their table; triggers from the request's record; utility calls metered per call; helper runs priced, listed, pruned and summed as their own sources; an unmeasured compaction reopens unmeasured")
