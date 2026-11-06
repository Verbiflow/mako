// Settings › Usage against each harness's own records, worked out by hand.
// `scripts/fixtures/usage-truth` holds excerpts of real records from each
// harness's store, their text, paths and session ids replaced. Each is laid
// out where its harness keeps it, with the copies its store makes of the
// same calls: Claude's line per content block and a forked session, Codex's
// repeated running total and a forked rollout, Cursor's runs beside what a
// version 4 ledger measured of them from Mako's journals, Grok's subagent
// session, OpenCode's message saved again, Devin's call kept in three rows.
// Each total below is the fixture's own numbers added by hand, and each cost
// the price list's rates applied by hand.
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { SqliteLocalAgentStore } from "@cursor/sdk/sqlite"
import { usageWindow, type UsageWindow } from "@mako/host/contracts/automations-usage-updates"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { usageHarnesses } from "@mako/host/harnesses/usage-harnesses"
import { UsageLedger } from "@mako/host/usage/ledger"
import { estimateUsageCost } from "@mako/host/usage/pricing"
import { usageSummary } from "@mako/host/usage/summary"
import { formatTokens, formatUsd } from "@mako/sessions/amounts"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

const FIXTURES = join(import.meta.dirname, "fixtures", "usage-truth")
const harnesses = usageHarnesses(createHarnessHost(detachedHarnessContext(new NativeStores(false))))
const root = await mkdtemp(join(tmpdir(), "mako-usage-truth-"))

const near = (actual: number | null | undefined, expected: number, message: string) =>
  assert.ok(actual != null && Math.abs(actual - expected) < 1e-9, `${message}: ${actual} != ${expected}`)
const lines = async (path: string) => (await readFile(join(FIXTURES, path), "utf8")).trim().split("\n")
const put = async (path: string, rows: readonly string[]) => {
  await mkdir(join(path, ".."), { recursive: true })
  await writeFile(path, `${rows.join("\n")}\n`)
}

/** One source's 30-day row, from a summary a day after `at`. */
async function source(home: string, label: string, at: string, ledger?: UsageLedger, conversations?: string): Promise<UsageWindow["sources"][number]> {
  const summary = await usageSummary(harnesses, join(home, ".mako"), home, conversations, { now: Date.parse(at) + 86_400_000, ledger })
  const row = usageWindow(summary, "month")?.sources.find((entry) => entry.source === label)
  assert.ok(row, `${label} is listed`)
  return row
}

function tokens(row: UsageWindow["sources"][number], expected: { calls: number; input: number; output: number; cacheRead: number; cacheWrite: number }, label: string) {
  assert.deepEqual(
    { calls: row.messages, input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite },
    expected,
    `${label}: every call once`
  )
}

try {
  // ── Pricing, against the providers' pages read 2026-11-04 ──────────────────
  const m = (counts: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number; fast: boolean }>) =>
    ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...counts })
  near(estimateUsageCost("claude-sonnet-5-5", m({ cacheRead: 1e6 })), 0.1, "Sonnet 5.5 reads its cache at 0.05x input, not Sonnet 5's 0.1x")
  near(estimateUsageCost("claude-haiku-5-5", m({ input: 1e5 })), 0.01, "Haiku 5.5 up to 100K prompt tokens")
  near(estimateUsageCost("claude-haiku-5-5", m({ input: 1e5, cacheRead: 1e3 })), 0.05 + 0.00005, "Haiku 5.5 past 100K prompt tokens, cache included, is priced 5x")
  near(estimateUsageCost("claude-opus-5-5", m({ input: 1e6, output: 1e6, fast: true })), 48, "Opus 5.5 in fast mode is $8 and $40")
  near(estimateUsageCost("claude-opus-5-5-fast", m({ input: 1e6 })), 8, "a model id naming fast mode is fast")
  assert.equal(estimateUsageCost("claude-sonnet-5", m({ input: 1e6, fast: true })), null, "a fast call of a model without a fast price is unpriced, not priced standard")
  near(estimateUsageCost("gpt-5.6-sol", m({ input: 1e5, output: 1e5, cacheRead: 1e5 })), 0.4 + 2 + 0.04, "GPT-5.6 Sol at its promotional $4 and $20")
  near(estimateUsageCost("gpt-5.5", m({ input: 3e5 })), 3, "GPT-5.5 past 272K input is long-context")
  near(estimateUsageCost("gpt-5.4", m({ input: 3e5, output: 1e6 })), 1.5 + 22.5, "GPT-5.4 past 272K input is long-context")
  near(estimateUsageCost("gpt-6.1-sol", m({ input: 1e5, fast: true })), 0.4, "Codex's fast tier is OpenAI's Fast price")
  near(estimateUsageCost("gpt-6.1-terra", m({ input: 1e5, output: 1e5 })), 0.6, "GPT-6.1 Terra is listed")
  near(estimateUsageCost("gpt-6-sol", m({ cacheRead: 1e5 })), 0.02, "GPT-6 Sol is not GPT-6.1 Sol")
  for (const [model, base, price] of [
    ["gpt-4.1-mini", "gpt-4.1", 0.4], ["gpt-4o-mini", "gpt-4o", 0.15], ["o3-pro", "o3", 20], ["gpt-5-mini", "gpt-5", 0.25],
    ["gpt-5-nano", "gpt-5", 0.05], ["gpt-5-pro", "gpt-5", 15], ["gpt-5.5-pro", "gpt-5.5", 30], ["gpt-5.2-pro", "gpt-5.2", 21],
  ] as const) near(estimateUsageCost(model, m({ input: 1e5 })), price / 10, `${model} has its own price, not ${base}'s`)
  near(estimateUsageCost("gpt-4o-2024-08-06", m({ input: 1e6 })), 2.5, "a dated snapshot is its model")
  near(estimateUsageCost("gpt-5-codex", m({ input: 1e6 })), 1.25, "Codex's own id for GPT-5")
  near(estimateUsageCost("google/gemini-3.8-flash", m({ input: 1e6 }), Date.parse("2026-12-31T12:00:00Z")), 0.75, "Gemini 3.8 Flash through 2026")
  near(estimateUsageCost("google/gemini-3.8-flash", m({ input: 1e6 }), Date.parse("2027-01-01T12:00:00Z")), 1.5, "and its announced price from 2027, for a call made then")

  // ── Claude Code ────────────────────────────────────────────────────────────
  // Three calls of a session, written a line per content block, all
  // 1-hour cache writes; two calls of its subagent, whose first line of each
  // call streamed before the output was all in. A forked session copies the
  // session's calls with their ids.
  {
    const home = join(root, "claude")
    const project = join(home, ".claude", "projects", "-work-project")
    const session = await lines("claude/session.jsonl")
    await put(join(project, "5e5510a0-0000-4000-8000-000000000001.jsonl"), session)
    await put(join(project, "5e5510a0-0000-4000-8000-000000000001", "subagents", "agent-1.jsonl"), await lines("claude/subagents/agent-1.jsonl"))
    await put(join(project, "5e5510a0-0000-4000-8000-00000000f0f0.jsonl"), session.map((line) => line.replace("5e5510a0-0000-4000-8000-000000000001", "5e5510a0-0000-4000-8000-00000000f0f0")))
    const claude = await source(home, "Claude Code", "2026-10-25T04:55:50.190Z")
    // input 2×5; output 244+196+125 and 259+160; cache read 11,586+34,416+35,381+5,538+18,567;
    // cache write 22,830+965+289 (an hour's) and 13,029+7,584 (five minutes').
    tokens(claude, { calls: 5, input: 10, output: 984, cacheRead: 105_488, cacheWrite: 44_697 }, "Claude Code")
    // Opus 5.5: $4 input, $20 output, $0.20 cache read, $5 a five-minute write and $8 an hour's, per million.
    near(claude.estimatedCost, (10 * 4 + 984 * 20 + 105_488 * 0.2 + 20_613 * 5 + 24_084 * 8) / 1e6, "Claude Code at Opus 5.5's list")
    assert.equal(claude.reportedCost, 0, "Claude's session files keep no cost")

    // The same calls made in fast mode cost twice as much.
    const fastHome = join(root, "claude-fast")
    await put(join(fastHome, ".claude", "projects", "-work-project", "fast.jsonl"), session.map((line) => line.replace('"speed":"standard"', '"speed":"fast"')))
    const fast = await source(fastHome, "Claude Code", "2026-10-24T23:20:09.689Z")
    near(fast.estimatedCost, 2 * (6 * 4 + 565 * 20 + 81_383 * 0.2 + 24_084 * 8) / 1e6, "Claude Code's fast calls at Opus 5.5's fast price")
  }

  // ── Codex ──────────────────────────────────────────────────────────────────
  // Four calls' running totals; Codex writes a total again when nothing was
  // spent (a rate-limit update), and a forked rollout repeats the calls.
  {
    const home = join(root, "codex")
    const rollout = await lines("codex/rollout.jsonl")
    const last = rollout.at(-1)!
    const repeated = last.replace('"timestamp":"2026-11-03T16:38:24.566Z"', '"timestamp":"2026-11-03T16:38:30.000Z"')
    const day = join(home, ".codex", "sessions", "2026", "11", "03")
    await put(join(day, "rollout-a.jsonl"), [...rollout, repeated])
    await put(join(day, "rollout-b.jsonl"), rollout.map((line) => line.replace("5e5510a0-0000-4000-8000-000000000002", "5e5510a0-0000-4000-8000-00000000f0f1")))
    const codex = await source(home, "Codex", "2026-11-03T16:38:30.000Z")
    // Fresh input 20,861 + (30,980 − 20,864) + (41,203 − 30,848) + (48,769 − 41,088): the rollout's own total, 141,813 less 92,800 cached.
    tokens(codex, { calls: 4, input: 49_013, output: 745, cacheRead: 92_800, cacheWrite: 0 }, "Codex")
    near(codex.estimatedCost, (49_013 * 10 + 745 * 50 + 92_800 * 1) / 1e6, "Codex at GPT-6 Astra's list")

    const fastHome = join(root, "codex-fast")
    await put(join(fastHome, ".codex", "sessions", "2026", "11", "03", "rollout.jsonl"), rollout.map((line) => line.replace('"service_tier":"default"', '"service_tier":"fast"')))
    near((await source(fastHome, "Codex", "2026-11-03T16:38:24.566Z")).estimatedCost, 2 * (49_013 * 10 + 745 * 50 + 92_800) / 1e6, "a rollout on the fast tier at the Fast price")
  }

  // ── Cursor ─────────────────────────────────────────────────────────────────
  // Three finished runs of one agent, each its calls summed, `inputTokens`
  // including both caches. Before Cursor's history was read, Mako measured
  // the same turns from its journals; a version 4 ledger keeps both.
  {
    const home = join(root, "cursor")
    // SAFETY: the fixture is this repository's own excerpt, in the shape the type names.
    const fixture = JSON.parse(await readFile(join(FIXTURES, "cursor", "runs.json"), "utf8")) as {
      agent: string
      workspace: string
      runs: { run_id: string; turn_number: number; model: string; usage_json: string; created_at: string; finished_at: string }[]
    }
    const store = await SqliteLocalAgentStore.open({ workspaceRef: fixture.workspace, stateRoot: join(home, ".mako", "cursor-sdk") })
    try {
      const created = Date.parse(fixture.runs[0]!.created_at)
      await store.agents.create({ agent: { agentId: fixture.agent, cwd: fixture.workspace, status: "idle", createdAt: created, updatedAt: created } })
      for (const run of fixture.runs)
        await store.runs.create({
          run: {
            runId: run.run_id, agentId: fixture.agent, turnNumber: run.turn_number, status: "finished", model: { id: run.model },
            createdAt: Date.parse(run.created_at), updatedAt: Date.parse(run.finished_at), endedAt: Date.parse(run.finished_at), usage: JSON.parse(run.usage_json),
          },
        })
    } finally {
      await store.dispose()
    }
    const ledgerPath = join(home, "usage-ledger.sqlite")
    const old = new DatabaseSync(ledgerPath)
    old.exec(`
      CREATE TABLE files (source TEXT NOT NULL, identity TEXT NOT NULL, offset INTEGER NOT NULL, state TEXT NOT NULL, unread TEXT, PRIMARY KEY (source, identity));
      CREATE TABLE stores (source TEXT NOT NULL, id TEXT NOT NULL, cursor REAL NOT NULL, PRIMARY KEY (source, id));
      CREATE TABLE events (
        key TEXT PRIMARY KEY, source TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL, model TEXT NOT NULL, cwd TEXT NOT NULL,
        input INTEGER NOT NULL, output INTEGER NOT NULL, cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cache_write_1h INTEGER NOT NULL, cost REAL, summed INTEGER NOT NULL,
        incomplete INTEGER NOT NULL, estimate REAL, price_table TEXT
      ) WITHOUT ROWID;
      CREATE TABLE sessions (source TEXT NOT NULL, session TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (source, session)) WITHOUT ROWID;
      PRAGMA user_version = 4;
    `)
    const event = old.prepare("INSERT INTO events VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, 0, ?, ?)")
    const session = old.prepare("INSERT INTO sessions VALUES (?, ?, ?)")
    for (const [index, run] of fixture.runs.entries()) {
      const usage = JSON.parse(run.usage_json)
      const at = Date.parse(run.finished_at) + 900
      event.run(`Cursor:${fixture.agent}:0000000${index}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, "Cursor", fixture.agent, at, run.model, fixture.workspace,
        usage.inputTokens - usage.cacheReadTokens - usage.cacheWriteTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens, 1, 1, "2026-10-06")
    }
    session.run("Cursor", fixture.agent, Date.parse(fixture.runs.at(-1)!.finished_at))
    // A rollout read before it was deleted: spent, so it stays.
    event.run("Codex:2026-11-03T10:00:00.000Z:1,2,0,0:1,2,0,0", "Codex", "gone-rollout", Date.parse("2026-11-03T10:00:00.000Z"), "gpt-6.1-sol", "/work/gone", 1_000, 200, 0, 0, 0, null, null)
    session.run("Codex", "gone-rollout", Date.parse("2026-11-03T10:00:00.000Z"))
    old.close()

    const ledger = new UsageLedger(ledgerPath)
    try {
      const at = "2026-11-04T00:56:16.759Z"
      const cursor = await source(home, "Cursor", at, ledger)
      // Fresh input 78 + 64 + 22: 4,667,253 − 4,475,512 − 191,663, and so on.
      tokens(cursor, { calls: 3, input: 164, output: 81_820, cacheRead: 13_730_208, cacheWrite: 529_397 }, "Cursor, with the journals' copies of its runs in an older ledger")
      assert.equal(cursor.sessions, 1)
      near(cursor.estimatedCost, (164 * 4 + 81_820 * 20 + 13_730_208 * 0.2 + 529_397 * 5) / 1e6, "Cursor at Opus 5.5's list")
      const kept = await source(home, "Codex", at, ledger)
      assert.equal(kept.messages, 1, "a deleted rollout's spend stays through the ledger's migration")
    } finally {
      ledger.close()
    }
  }

  // ── Grok ───────────────────────────────────────────────────────────────────
  // Two turns, each priced by Grok in ten-billionths of a dollar, `inputTokens`
  // including the cache. A subagent's session beside it counts through its
  // parent, never on its own.
  {
    const home = join(root, "grok")
    const workspace = join(home, ".grok", "sessions", encodeURIComponent("/work/project"))
    const updates = await lines("grok/updates.jsonl")
    await put(join(workspace, "5e5510a0-0000-4000-8000-000000000004", "updates.jsonl"), updates)
    await writeFile(join(workspace, "5e5510a0-0000-4000-8000-000000000004", "summary.json"), JSON.stringify({ session_kind: "interactive" }))
    await put(join(workspace, "subagent", "updates.jsonl"), updates.map((line) => line.replace("5e5510a0-0000-4000-8000-000000000004", "subagent")))
    await writeFile(join(workspace, "subagent", "summary.json"), JSON.stringify({ session_kind: "subagent" }))
    const grok = await source(home, "Grok", "2026-09-22T06:22:54.000Z")
    // Fresh input 243,976 − 130,560 and 342,166 − 214,528.
    tokens(grok, { calls: 2, input: 241_054, output: 16_557, cacheRead: 345_088, cacheWrite: 0 }, "Grok")
    near(grok.reportedCost, (1_196_874_800 + 1_366_704_800) / 1e10, "Grok's own price")
    assert.equal(grok.estimatedCost, 0, "Mako estimates nothing Grok priced")
  }

  // ── OpenCode ───────────────────────────────────────────────────────────────
  // Three messages of a free model, `input` apart from the cache and
  // reasoning beside output; a message saved again as it streams counts once.
  {
    const home = join(root, "opencode")
    const folder = join(home, ".local", "share", "opencode")
    await mkdir(folder, { recursive: true })
    // SAFETY: the fixture is this repository's own excerpt, in the shape the type names.
    const messages = JSON.parse(await readFile(join(FIXTURES, "opencode", "messages.json"), "utf8")) as { id: string; time: { created: number; completed: number } }[]
    const db = new DatabaseSync(join(folder, "opencode.db"))
    db.exec(`
      CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
      CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, model TEXT, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    db.prepare("INSERT INTO session VALUES ('ses_fixture', NULL, '/work/project', NULL, ?, ?)").run(messages[2]!.time.created, messages[0]!.time.completed)
    const insert = db.prepare("INSERT INTO message VALUES (?, 'ses_fixture', ?, ?, ?)")
    for (const message of messages) insert.run(message.id, message.time.created, message.time.completed, JSON.stringify(message))
    db.close()
    const ledger = new UsageLedger(join(home, "usage-ledger.sqlite"))
    try {
      const at = new Date(messages[0]!.time.completed).toISOString()
      await source(home, "OpenCode", at, ledger)
      const again = new DatabaseSync(join(folder, "opencode.db"))
      again.prepare("UPDATE message SET time_updated = time_updated + 1000").run()
      again.close()
      const openCode = await source(home, "OpenCode", at, ledger)
      // Input 1,209 + 2,164 + 1,654; output (60 + 1,781) + (57 + 1,006) + (321 + 1,778); cache read 22,641 + 20,593 + 19,057.
      tokens(openCode, { calls: 3, input: 5_027, output: 5_003, cacheRead: 62_291, cacheWrite: 0 }, "OpenCode, read again")
      assert.equal(openCode.reportedCost, 0, "OpenCode priced its free model at nothing")
      assert.equal(openCode.unpricedTokens, 0, "a model its harness priced at nothing is priced, not unpriced")
    } finally {
      ledger.close()
    }
  }

  // ── Devin ──────────────────────────────────────────────────────────────────
  // Two calls; Devin keeps the first in two sibling rows and copies it into a
  // forked session, every copy with the call's request id.
  {
    const home = join(root, "devin")
    const folder = join(home, ".local", "share", "devin", "cli")
    await mkdir(folder, { recursive: true })
    // SAFETY: the fixture is this repository's own excerpt, in the shape the type names.
    const rows = JSON.parse(await readFile(join(FIXTURES, "devin", "calls.json"), "utf8")) as { node_id: number; created_at: number; metadata: { request_id: string } }[]
    const db = new DatabaseSync(join(folder, "sessions.db"))
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, working_directory TEXT);
      CREATE TABLE message_nodes (row_id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, node_id INTEGER NOT NULL, created_at INTEGER, chat_message TEXT, UNIQUE (session_id, node_id));
      INSERT INTO sessions VALUES ('devin-a', 'swe-2-high', '/work/project'), ('devin-fork', 'swe-2-high', '/work/project'), ('devin-b', 'swe-2-high', '/work/project');
    `)
    const insert = db.prepare("INSERT INTO message_nodes (session_id, node_id, created_at, chat_message) VALUES (?, ?, ?, ?)")
    const first = rows[0]!.metadata.request_id
    for (const [index, row] of rows.entries()) {
      const session = row.metadata.request_id !== first ? "devin-b" : index === 2 ? "devin-fork" : "devin-a"
      insert.run(session, row.node_id, row.created_at, JSON.stringify({ role: "assistant", metadata: row.metadata }))
    }
    db.close()
    const devin = await source(home, "Devin", "2026-10-27T07:32:17.129Z")
    tokens(devin, { calls: 2, input: 31_416, output: 173, cacheRead: 1_280, cacheWrite: 0 }, "Devin")
    assert.equal(devin.unpricedTokens, 32_869, "Devin's own model has no published price, and says so")
  }

  // ── The formatter every surface uses ───────────────────────────────────────
  const said: [number, string][] = [
    [0, "0"], [940, "940"], [999, "999"], [1_000, "1K"], [1_240, "1.24K"], [12_400, "12.4K"], [124_000, "124K"], [999_499, "999K"],
    [999_960, "1M"], [1_048_576, "1.05M"], [12_400_000, "12.4M"], [20_736_745_267, "20.7B"], [12_400_000_000, "12.4B"],
    [999_999_999_999, "1T"], [2_500_000_000_000, "2.5T"], [1_500_000_000_000_000, "1,500T"],
  ]
  for (const [count, words] of said) assert.equal(formatTokens(count), words, `${count} tokens`)
  const dollars: [number, string][] = [
    [0, "$0.00"], [0.004, "<$0.01"], [0.005, "$0.01"], [0.42, "$0.42"], [9.99, "$9.99"], [9.996, "$10"], [12.4, "$12"],
    [1_294.32, "$1,294"], [8_507.77, "$8,508"], [2_063_540, "$2,063,540"],
  ]
  for (const [amount, words] of dollars) assert.equal(formatUsd(amount), words, `$${amount}`)

  console.log("Usage truth: each harness's real records, laid out with the copies its store makes, total and price as worked out by hand; a version 4 ledger drops the journals' copies of Cursor's runs and keeps deleted spend; prices as listed on 2026-11-04; tokens in K, M, B and T and dollars with cents below $10")
} finally {
  await rm(root, { recursive: true, force: true })
}
