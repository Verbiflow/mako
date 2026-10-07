import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { providerHost } from "../electron/providers/index.js"
import type { UsageSummary } from "../electron/shared.js"
import { usageHarnesses, usageSummary } from "../electron/usage.js"
import { UsageLedger } from "../electron/usage-ledger.js"
import { readAppended } from "../electron/usage-scan.js"
import { estimateUsageCost } from "../electron/usage-pricing.js"

// Fable 5.1 and Fable 5 share list prices but not cache reads, and the
// per-turn cache read is the token class an agent session is made of.
const cacheRead = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }
assert.equal(estimateUsageCost("claude-fable-5-1[1m]", cacheRead), 0.25)
assert.equal(estimateUsageCost("claude-fable-5", cacheRead), 1)
assert.equal(estimateUsageCost("claude-5-fable-low", cacheRead), 1)

const near = (actual: number | null, expected: number, message?: string) =>
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `${message ?? "cost"}: ${actual} != ${expected}`)
const million = (counts: Partial<{ input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number }>) =>
  ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...counts })
near(estimateUsageCost("claude-opus-5-5", million({ input: 1e6, output: 1e6 })), 24)
near(estimateUsageCost("claude-sonnet-5", million({ cacheWrite: 1e6, cacheWrite1h: 4e5 })), 3.1, "an hour's cache write is 2x input, five minutes' 1.25x")
near(estimateUsageCost("claude-sonnet-5-max", million({ cacheRead: 1e6 })), 0.2, "an effort suffix is the same model")
near(estimateUsageCost("gpt-6.1-sol", million({ input: 1e5, cacheRead: 1e5, output: 1e5 })), 1.21)
near(estimateUsageCost("gpt-6.1-sol", million({ input: 1e5, cacheRead: 2e5, output: 1e5 })), 0.4 + 0.04 + 1.5, "past 272K input the whole call is long-context")
near(estimateUsageCost("gpt-6.1-sol", { ...million({ input: 1e5, cacheRead: 2e5, output: 1e5 }), summed: true }), 1.22, "a turn's sum is not one long call")
near(estimateUsageCost("gpt-6-astra", million({ input: 1e5 })), 1)
near(estimateUsageCost("gpt-6-luna", million({ output: 1e6 })), 0.5)

/** The fixtures' records are from August 20, 2026; the summaries run five days later. */
const AUGUST_25 = Date.parse("2026-08-25T12:00:00.000Z")

const root = await mkdtemp(join(tmpdir(), "mako-usage-"))
const sessionsRoot = join(root, "built-in")
const homeRoot = join(root, "home")

try {
  const builtInRows = [
    JSON.stringify({
      type: "session",
      id: "built-1",
      cwd: "/work/reported",
    }),
    JSON.stringify({
      type: "message",
      id: "built-turn-1",
      timestamp: "2026-08-20T10:00:00.000Z",
      message: {
        model: "private-model",
        usage: {
          input: 100,
          output: 20,
          cacheRead: 30,
          cacheWrite: 10,
          cost: { total: 0.123 },
        },
      },
    }),
  ]
  await putJsonl(join(sessionsRoot, "project-a", "original.jsonl"), builtInRows)
  await putJsonl(join(sessionsRoot, "project-a", "copy.jsonl"), builtInRows)

  const streamedClaudeTurn = claudeTurn(
    "claude-1",
    "msg-1",
    "req-1",
    "row-2",
    "claude-sonnet-4-6",
    2,
    15,
    100,
    20
  )
  await putJsonl(join(homeRoot, ".claude", "projects", "repo", "original.jsonl"), [
    claudeTurn(
      "claude-1",
      "msg-1",
      "req-1",
      "row-1",
      "claude-sonnet-4-6",
      2,
      10,
      100,
      20
    ),
    streamedClaudeTurn,
  ])
  await putJsonl(join(homeRoot, ".claude", "projects", "repo", "fork.jsonl"), [
    streamedClaudeTurn.replace('"claude-1"', '"claude-fork"'),
    claudeTurn(
      "claude-fork",
      "msg-2",
      "req-2",
      "row-3",
      "unpriced-model",
      7,
      3,
      0,
      0
    ),
  ])

  const firstCodex = codexUsage(
    "2026-08-20T12:00:01.000Z",
    rawCodex(100, 40, 10, 20),
    rawCodex(100, 40, 10, 20)
  )
  const secondCodex = codexUsage(
    "2026-08-20T12:00:02.000Z",
    rawCodex(160, 60, 15, 30),
    rawCodex(60, 20, 5, 10)
  )
  const repeatedSnapshot = codexUsage(
    "2026-08-20T12:00:03.000Z",
    rawCodex(160, 60, 15, 30),
    rawCodex(60, 20, 5, 10)
  )
  const codexPrefix = [
    JSON.stringify({
      type: "session_meta",
      payload: { id: "codex-1", cwd: "/work/codex" },
    }),
    JSON.stringify({
      type: "turn_context",
      payload: { cwd: "/work/codex", model: "gpt-5" },
    }),
    firstCodex,
    secondCodex,
    repeatedSnapshot,
  ]
  await putJsonl(
    join(homeRoot, ".codex", "sessions", "2026", "08", "20", "original.jsonl"),
    codexPrefix
  )
  await putJsonl(
    join(homeRoot, ".codex", "sessions", "2026", "08", "20", "fork.jsonl"),
    [
      codexPrefix[0].replace('"codex-1"', '"codex-fork"'),
      ...codexPrefix.slice(1),
      codexUsage(
        "2026-08-20T12:00:04.000Z",
        rawCodex(190, 70, 15, 35),
        rawCodex(30, 10, 0, 5)
      ),
    ]
  )
  await putOpenCodeDatabases(homeRoot)

  const summary = await usageSummary(usageHarnesses(providerHost), sessionsRoot, homeRoot, undefined, { now: AUGUST_25 })

  assert.equal(summary.total.messages, 11)
  assert.equal(summary.sessions, 9)
  assert.equal(summary.total.input, 243)
  assert.equal(summary.total.output, 97)
  assert.equal(summary.total.cacheRead, 213)
  assert.equal(summary.total.cacheWrite, 49)
  assert.equal(summary.total.reportedCost, 0.393)
  assert.ok(Math.abs((summary.total.estimatedCost ?? 0) - 0.000958875) < 1e-12)
  assert.equal(summary.total.pricedTokens, 585)
  assert.equal(summary.total.unpricedTokens, 17)
  assert.deepEqual(
    summary.sources?.map((source) => source.source).sort(),
    ["Claude Code", "Codex", "Mako", "OpenCode"]
  )

  const claude = summary.sources?.find((source) => source.source === "Claude Code")
  assert.equal(claude?.messages, 2)
  assert.equal(claude?.output, 18)
  const codex = summary.sources?.find((source) => source.source === "Codex")
  assert.equal(codex?.messages, 3)
  assert.equal(codex?.input, 105)
  assert.equal(codex?.cacheRead, 70)
  assert.equal(codex?.cacheWrite, 15)
  const openCode = summary.sources?.find((source) => source.source === "OpenCode")
  assert.equal(openCode?.messages, 5)
  assert.equal(openCode?.input, 29)
  assert.equal(openCode?.output, 24)
  assert.equal(openCode?.cacheRead, 13)
  assert.equal(openCode?.cacheWrite, 4)
  assert.equal(openCode?.reportedCost, 0.27)
  assert.ok(Math.abs((openCode?.estimatedCost ?? 0) - 0.000114125) < 1e-12)
  assert.equal(openCode?.pricedTokens, 63)
  assert.equal(openCode?.unpricedTokens, 7)
  assert.equal(
    summary.projects?.find((project) => project.cwd === "/work/opencode-current")
      ?.messages,
    3
  )
  assert.equal(
    summary.projects?.find((project) => project.cwd === "/work/opencode-legacy")
      ?.messages,
    1
  )
  assert.equal(
    summary.projects?.find((project) => project.cwd === "/work/opencode-v2")
      ?.messages,
    1
  )

  console.log("Local usage scanner fixtures passed")

  const grokHome = join(root, "grok-home")
  const grokSession = join(grokHome, ".grok", "sessions", encodeURIComponent("/work/grok"), "grok-1")
  type GrokModelUsage = { inputTokens: number; outputTokens: number; cachedReadTokens?: number; cacheCreationTokens?: number; costUsdTicks?: number }
  const turn = (id: string, timestamp: number, modelUsage: Record<string, GrokModelUsage>) => JSON.stringify({
    timestamp,
    method: "_x.ai/session/update",
    params: { sessionId: "grok-1", update: { sessionUpdate: "turn_completed", prompt_id: id, usage: { inputTokens: 1, modelUsage } } },
  })
  await putJsonl(join(grokSession, "updates.jsonl"), [
    turn("p1", 1_787_000_000, {
      "grok-build": { inputTokens: 1_000, outputTokens: 50, cachedReadTokens: 800, cacheCreationTokens: 100, costUsdTicks: 250_000_000 },
      "grok-fast": { inputTokens: 40, outputTokens: 10, cachedReadTokens: 0, cacheCreationTokens: 0, costUsdTicks: 10_000_000 },
    }),
    turn("p1", 1_787_000_000, {
      "grok-build": { inputTokens: 1_000, outputTokens: 50, cachedReadTokens: 800, cacheCreationTokens: 100, costUsdTicks: 250_000_000 },
    }),
    JSON.stringify({ method: "_x.ai/session/update", params: { sessionId: "grok-1", update: { sessionUpdate: "agent_message_chunk" } } }),
  ])
  await putJsonl(join(grokSession, "chat_history.jsonl"), [turn("p2", 1_787_000_100, { "grok-build": { inputTokens: 9_999, outputTokens: 1 } })])
  // A subagent's usage is already in its parent's turn.
  const grokChild = join(grokHome, ".grok", "sessions", encodeURIComponent("/work/grok"), "grok-child")
  await putJsonl(join(grokChild, "updates.jsonl"), [turn("c1", 1_787_000_050, { "grok-build": { inputTokens: 5_000, outputTokens: 5 } })])
  await writeFile(join(grokChild, "summary.json"), JSON.stringify({ info: { id: "grok-child" }, session_kind: "subagent_fork" }))
  // A path too long for a folder name is a slug-hash folder with the path in `.cwd`.
  const hashed = join(grokHome, ".grok", "sessions", "workspace-0123456789abcdef")
  await putJsonl(join(hashed, "grok-2", "updates.jsonl"), [turn("p3", 1_787_000_200, { "grok-build": { inputTokens: 10, outputTokens: 0 } })])
  await writeFile(join(hashed, ".cwd"), "/a/very/long/workspace\n")
  const grokSummary = await usageSummary(usageHarnesses(providerHost), join(root, "no-mako-sessions"), grokHome, undefined, { now: AUGUST_25 })
  const grok = grokSummary.sources?.find((source) => source.source === "Grok")
  assert.equal(grok?.messages, 3, "one event per model per turn; a repeated turn, other files and subagents add nothing")
  assert.equal(grok?.input, 150, "cached input is counted apart from fresh input")
  assert.equal(grok?.cacheRead, 800)
  assert.equal(grok?.cacheWrite, 100)
  assert.equal(grok?.output, 60)
  assert.ok(Math.abs((grok?.reportedCost ?? 0) - 0.026) < 1e-12, "cost ticks are ten-billionths of a dollar")
  assert.deepEqual(grokSummary.projects?.map((project) => project.cwd).sort(), ["/a/very/long/workspace", "/work/grok"])
  assert.deepEqual(grokSummary.models?.map((model) => model.model).sort(), ["grok-build", "grok-fast"])
  console.log("Grok usage: per-model turn totals, cache apart from input, cost from ticks, subagents once, project from the store path or its .cwd")

  await keptLedger(join(root, "ledger"))
  await invalidLedgerState(join(root, "invalid-ledger"))
} finally {
  await rm(root, { recursive: true, force: true })
}

/** A corrupt file cursor is reported without hiding other files or advancing past unread calls. */
async function invalidLedgerState(root: string): Promise<void> {
  const home = join(root, "home")
  const sessions = join(home, ".codex", "sessions")
  await mkdir(sessions, { recursive: true })
  const now = Date.now()
  const at = (offset: number) => new Date(now - 60_000 + offset).toISOString()
  const damaged = join(sessions, "damaged.jsonl")
  await putJsonl(damaged, [
    JSON.stringify({ type: "session_meta", payload: { id: "damaged", cwd: "/work/cursor" } }),
    JSON.stringify({ type: "turn_context", payload: { model: "gpt-6.1-sol" } }),
    codexUsage(at(0), rawCodex(10, 0, 0, 1), rawCodex(10, 0, 0, 1)),
  ])
  const path = join(root, "ledger.sqlite")
  const ledger = new UsageLedger(path)
  const db = new DatabaseSync(path)
  const harnesses = usageHarnesses(providerHost).filter((harness) => harness.provider === "codex")
  const summarize = () => usageSummary(harnesses, join(root, "no-built-in"), home, undefined, { now, ledger })
  try {
    assert.equal((await summarize()).total.input, 10)
    const saved = db.prepare("SELECT state, offset FROM files WHERE source = 'Codex'").get()
    assert.ok(saved)
    const update = db.prepare("UPDATE files SET state = ? WHERE source = 'Codex' AND offset = ?")
    for (const state of ["{", JSON.stringify({ session: "damaged", cwd: "/work/cursor", model: "gpt-6.1-sol", previous: { input: "wrong", output: 1, cacheRead: 0, cacheWrite: 0 } })]) {
      update.run(state, saved.offset)
      assert.equal((await summarize()).truncated, true, "an unchanged file's invalid cursor is still reported")
    }
    await appendFile(damaged, `${codexUsage(at(1), rawCodex(20, 0, 0, 2), rawCodex(10, 0, 0, 1))}\n`)
    await putJsonl(join(sessions, "valid.jsonl"), [codexUsage(at(2), rawCodex(7, 0, 0, 1), rawCodex(7, 0, 0, 1))])
    for (const state of ["{", "null"]) {
      update.run(state, saved.offset)
      const summary = await summarize()
      assert.equal(summary.truncated, true)
      assert.equal(summary.total.input, 17, "another file is counted while the damaged file stays unread")
    }
    update.run(saved.state, saved.offset)
    const repaired = await summarize()
    assert.equal(repaired.truncated, false)
    assert.equal(repaired.total.input, 27, "repair continues from the held cursor and counts the pending call once")
    assert.equal((await summarize()).total.input, 27)
    console.log("Usage cursor validation: malformed JSON and invalid reader state stay unread; other files continue; repaired state resumes once")
  } finally {
    db.close()
    ledger.close()
  }
}

/**
 * Summaries over one kept ledger: each rollout is read from where its last
 * read stopped, wherever it has moved; the window is exactly the 30 days
 * charted; and anything in it left unread is said, every time.
 */
async function keptLedger(root: string): Promise<void> {
  const home = join(root, "home")
  const now = Date.now()
  const today = new Date(now).setUTCHours(0, 0, 0, 0)
  const since = today - 29 * 86_400_000
  const at = (ms: number) => new Date(ms).toISOString()
  const sessions = join(home, ".codex", "sessions")
  await mkdir(sessions, { recursive: true })
  const ledger = new UsageLedger(join(root, "ledger.sqlite"))
  const summarize = () => usageSummary(usageHarnesses(providerHost), join(root, "no-built-in"), home, undefined, { now, ledger })
  const codexOf = (summary: UsageSummary) => {
    const codex = summary.sources?.find((source) => source.source === "Codex")
    return { messages: codex?.messages ?? 0, input: codex?.input ?? 0, cacheRead: codex?.cacheRead ?? 0, output: codex?.output ?? 0 }
  }
  const prefix = (id: string) => [
    JSON.stringify({ type: "session_meta", payload: { id, cwd: "/work/ledger" } }),
    JSON.stringify({ type: "turn_context", payload: { cwd: "/work/ledger", model: "gpt-6.1-sol" } }),
  ]
  const toolOutput = (bytes: number) =>
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(bytes) } })

  try {
    // A 40 MB tool output between two calls: past the old 32 MB cut, read whole now.
    const rollout = join(sessions, "rollout-a.jsonl")
    await putJsonl(rollout, [
      ...prefix("codex-a"),
      codexUsage(at(today + 60_000), rawCodex(1_000, 800, 0, 50), rawCodex(1_000, 800, 0, 50)),
      toolOutput(40 * 1024 * 1024),
      codexUsage(at(today + 120_000), rawCodex(2_100, 1_800, 0, 90), rawCodex(1_100, 1_000, 0, 40)),
    ])
    let summary = await summarize()
    assert.deepEqual(codexOf(summary), { messages: 2, input: 300, cacheRead: 1_800, output: 90 })
    assert.equal(summary.truncated, false)
    assert.ok(Math.abs((summary.total.estimatedCost ?? 0) - 0.00168) < 1e-12, "gpt-6.1-sol is priced")
    assert.equal(summary.sessions, 1)

    // A call still being written is left for the next read, then counted once.
    const third = codexUsage(at(today + 180_000), rawCodex(2_600, 2_200, 0, 100), rawCodex(500, 400, 0, 10))
    await appendFile(rollout, third.slice(0, 40))
    assert.deepEqual(codexOf(await summarize()), { messages: 2, input: 300, cacheRead: 1_800, output: 90 })
    await appendFile(rollout, `${third.slice(40)}\n`)
    assert.deepEqual(codexOf(await summarize()), { messages: 3, input: 400, cacheRead: 2_200, output: 100 })

    // What was read is not read again: a change before the cursor goes unseen, the call after it counts.
    const written = await readFile(rollout, "utf8")
    const handle = await open(rollout, "r+")
    await handle.write('"input_tokens":9000', Buffer.byteLength(written.slice(0, written.indexOf('"input_tokens":1000'))))
    await handle.close()
    await appendFile(rollout, `${codexUsage(at(today + 240_000), rawCodex(2_700, 2_200, 0, 101), rawCodex(100, 0, 0, 1))}\n`)
    assert.deepEqual(codexOf(await summarize()), { messages: 4, input: 500, cacheRead: 2_200, output: 101 })

    // A call a millisecond before the window's first day is out; one at its first instant is in.
    await putJsonl(join(sessions, "rollout-edge.jsonl"), [
      ...prefix("codex-edge"),
      codexUsage(at(since - 1), rawCodex(5_000, 0, 0, 0), rawCodex(5_000, 0, 0, 0)),
      codexUsage(at(since), rawCodex(5_007, 0, 0, 0), rawCodex(7, 0, 0, 0)),
    ])
    summary = await summarize()
    assert.deepEqual(codexOf(summary), { messages: 5, input: 507, cacheRead: 2_200, output: 101 })
    assert.equal(summary.days?.[0]?.date, at(since).slice(0, 10), "the chart starts where the total does")
    assert.equal(summary.days?.[0]?.messages, 1)

    // A rollout Codex archives is the same calls, and keeps its reader's state when it grows there.
    const archived = join(home, ".codex", "archived_sessions")
    await mkdir(archived, { recursive: true })
    await putJsonl(join(sessions, "rollout-b.jsonl"), [...prefix("codex-b"), codexUsage(at(today + 300_000), rawCodex(30, 0, 0, 3), rawCodex(30, 0, 0, 3))])
    const before = codexOf(await summarize())
    assert.equal(before.messages, 6)
    await rename(join(sessions, "rollout-b.jsonl"), join(archived, "rollout-b.jsonl"))
    await appendFile(join(archived, "rollout-b.jsonl"), `${codexUsage(at(today + 360_000), rawCodex(40, 0, 0, 4), rawCodex(10, 0, 0, 1))}\n`)
    summary = await summarize()
    assert.deepEqual(codexOf(summary), { ...before, messages: 7, input: before.input + 10, output: before.output + 1 })
    assert.equal(summary.sessions, 3)

    // A line too long to hold is skipped without a word when it cannot hold usage, and said when it can.
    await putJsonl(join(sessions, "rollout-c.jsonl"), [
      ...prefix("codex-c"),
      toolOutput(65 * 1024 * 1024),
      codexUsage(at(today + 420_000), rawCodex(20, 0, 0, 2), rawCodex(20, 0, 0, 2)),
    ])
    summary = await summarize()
    assert.equal(summary.truncated, false)
    assert.equal(codexOf(summary).messages, 8)
    const huge = JSON.stringify({ type: "event_msg", payload: { type: "token_count", padding: "x".repeat(65 * 1024 * 1024) } })
    await appendFile(join(sessions, "rollout-c.jsonl"), `${huge}\n`)
    assert.equal((await summarize()).truncated, true)
    assert.equal((await summarize()).truncated, true, "still said once the cursor is past it")

    // A harness with no usage store of its own is counted from what Mako's journals measured,
    // read again when the journal's write-ahead log changes, before any checkpoint.
    const harness = usageHarnesses(providerHost).find((candidate) => !candidate.history)
    assert.ok(harness, "some harness is counted from Mako's own measurements")
    const conversations = join(root, "conversations")
    await mkdir(conversations, { recursive: true })
    const journal = new DatabaseSync(join(conversations, "conversation-1.sqlite"))
    journal.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE metadata (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE requests (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    `)
    journal.prepare("INSERT INTO metadata VALUES (1, ?)").run(JSON.stringify({ session: { cwd: "/work/recorded" } }))
    const request = journal.prepare("INSERT INTO requests VALUES (?, ?)")
    const spend = (id: string, ms: number, tokens: { input: number; cacheRead: number; cacheWrite: number; output: number }) =>
      request.run(id, JSON.stringify({ id, spend: { provider: harness.provider, model: "gpt-6.1-sol", at: ms, tokens } }))
    spend("request-1", today + 60_000, { input: 100_000, cacheRead: 200_000, cacheWrite: 0, output: 100_000 })
    spend("request-old", since - 1, { input: 9_999, cacheRead: 0, cacheWrite: 0, output: 0 })
    const recordedSummary = (summary: UsageSummary) => summary.sources?.find((source) => source.source === harness.label)
    const withJournals = () => usageSummary(usageHarnesses(providerHost), join(root, "no-built-in"), home, conversations, { now, ledger })
    let recorded = recordedSummary(await withJournals())
    assert.equal(recorded?.messages, 1)
    near(recorded?.estimatedCost ?? null, 1.22, "a request's spend is a turn's sum")
    spend("request-2", today + 120_000, { input: 10, cacheRead: 0, cacheWrite: 0, output: 0 })
    recorded = recordedSummary(await withJournals())
    assert.equal(recorded?.messages, 2)
    assert.equal(recorded?.input, 100_010)
    journal.close()

    // A needle split across two 4 MB reads, in a line longer than one read, is still found.
    const seam = join(root, "seam.jsonl")
    const straddling = JSON.stringify({ padding: "y".repeat(4 * 1024 * 1024 - 26), type: "token_count" })
    assert.equal(straddling.indexOf('"token_count"'), 4 * 1024 * 1024 - 5)
    await writeFile(seam, `${straddling}\n{"other":1}\n`)
    const seen: number[] = []
    const read = await readAppended(seam, 0, ['"token_count"'], (line) => seen.push(line.length))
    assert.deepEqual(seen, [straddling.length])
    assert.deepEqual(read, { end: straddling.length + 13, oversized: 0 })
    console.log("Kept ledger: appended bytes only, moved rollouts counted once, exact window, long lines whole or reported")
  } finally {
    ledger.close()
  }
}

async function putOpenCodeDatabases(homeRoot: string): Promise<void> {
  const root = join(homeRoot, ".local", "share", "opencode")
  await mkdir(root, { recursive: true })
  const created = Date.parse("2026-08-20T13:00:00.000Z")

  const legacy = new DatabaseSync(join(root, "opencode.db"))
  legacy.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  legacy.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run(
    "project-legacy",
    "/work/opencode-legacy"
  )
  const legacySession = legacy.prepare(
    "INSERT INTO session (id, project_id, directory, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
  )
  legacySession.run(
    "oc-shared",
    "project-legacy",
    "/work/opencode-legacy",
    null,
    created,
    created
  )
  legacySession.run(
    "oc-legacy",
    "project-legacy",
    "/work/opencode-legacy",
    null,
    created,
    created
  )
  const legacyMessage = legacy.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)"
  )
  legacyMessage.run(
    "msg-duplicate",
    "oc-shared",
    created,
    created,
    openCodeLegacyMessage("private-provider", "private-model", 11, 5, 3, 7, 2, 0.25)
  )
  legacyMessage.run(
    "msg-legacy-only",
    "oc-legacy",
    created + 1,
    created + 1,
    openCodeLegacyMessage("anthropic", "claude-sonnet-4-6", 5, 2, 1, 2, 1, 0.02)
  )
  const v2Session = legacy.prepare(
    "INSERT INTO session_v2 (id, project_id, directory, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
  )
  v2Session.run(
    "oc-v2",
    "project-legacy",
    "/work/opencode-v2",
    JSON.stringify({ id: "gpt-5", providerID: "openai" }),
    created,
    created
  )
  v2Session.run(
    "oc-shared",
    "project-legacy",
    "/work/opencode-shadow",
    null,
    created,
    created
  )
  const v2Message = legacy.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)"
  )
  v2Message.run(
    "msg-v2-only",
    "oc-v2",
    1,
    created + 2,
    created + 2,
    openCodeCurrentMessage("gateway", "v2-test", 1, 0, 0, 0, 0)
  )
  v2Message.run(
    "msg-v2-shadow",
    "oc-shared",
    1,
    created + 3,
    created + 3,
    openCodeCurrentMessage("private-provider", "private-model", 999, 999, 999, 999, 999)
  )
  legacy.close()

  const current = new DatabaseSync(join(root, "opencode-next.db"))
  current.exec(`
    CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT NOT NULL);
    CREATE TABLE session (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      directory TEXT NOT NULL,
      model TEXT,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `)
  current.prepare("INSERT INTO project (id, worktree) VALUES (?, ?)").run(
    "project-current",
    "/work/opencode-current"
  )
  const currentSession = current.prepare(
    "INSERT INTO session (id, project_id, directory, model, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?)"
  )
  currentSession.run(
    "oc-shared",
    "project-current",
    "/work/opencode-current",
    null,
    created,
    created
  )
  currentSession.run(
    "oc-next",
    "project-current",
    "/work/opencode-current",
    JSON.stringify({ id: "gpt-5", providerID: "openai" }),
    created,
    created
  )
  const currentMessage = current.prepare(
    "INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, 'assistant', ?, ?, ?, ?)"
  )
  currentMessage.run(
    "msg-duplicate",
    "oc-shared",
    1,
    created,
    created,
    openCodeCurrentMessage("private-provider", "private-model", 11, 5, 3, 7, 2, 0.25)
  )
  currentMessage.run(
    "msg-next-priced",
    "oc-next",
    1,
    created + 1,
    created + 1,
    openCodeCurrentMessage("openai", "gpt-5", 10, 4, 6, 3, 1)
  )
  currentMessage.run(
    "msg-next-unpriced",
    "oc-next",
    2,
    created + 2,
    created + 2,
    openCodeCurrentMessage("gateway", "gpt-5", 2, 1, 2, 1, 0)
  )
  current.close()
}

function openCodeLegacyMessage(
  providerID: string,
  modelID: string,
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
  cost: number
): string {
  return JSON.stringify({
    role: "assistant",
    providerID,
    modelID,
    path: { cwd: "/work/opencode-legacy" },
    time: { created: Date.parse("2026-08-20T13:00:00.000Z") },
    cost,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
    },
  })
}

function openCodeCurrentMessage(
  providerID: string,
  id: string,
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
  cost?: number
): string {
  return JSON.stringify({
    agent: "build",
    model: { providerID, id },
    content: [],
    time: { created: Date.parse("2026-08-20T13:00:00.000Z") },
    cost,
    tokens: {
      input,
      output,
      reasoning,
      cache: { read: cacheRead, write: cacheWrite },
    },
  })
}

async function putJsonl(path: string, rows: string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${rows.join("\n")}\n`)
}

function claudeTurn(
  sessionId: string,
  messageId: string,
  requestId: string,
  uuid: string,
  model: string,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    requestId,
    uuid,
    timestamp: "2026-08-20T11:00:00.000Z",
    cwd: "/work/claude",
    message: {
      id: messageId,
      model,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
      },
    },
  })
}

interface CodexTokens {
  input_tokens: number
  cached_input_tokens: number
  cache_write_input_tokens: number
  output_tokens: number
  total_tokens: number
}

function rawCodex(
  input: number,
  cacheRead: number,
  cacheWrite: number,
  output: number
): CodexTokens {
  return {
    input_tokens: input,
    cached_input_tokens: cacheRead,
    cache_write_input_tokens: cacheWrite,
    output_tokens: output,
    total_tokens: input + output,
  }
}

function codexUsage(
  timestamp: string,
  total: CodexTokens,
  last: CodexTokens
): string {
  return JSON.stringify({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: total,
        last_token_usage: last,
      },
    },
  })
}
