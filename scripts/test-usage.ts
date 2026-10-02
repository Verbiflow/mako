import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { usageSummary } from "../electron/usage.js"
import { estimateUsageCost } from "../electron/usage-pricing.js"

// Fable 5.1 and Fable 5 share list prices but not cache reads, and the
// per-turn cache read is the token class an agent session is made of.
const cacheRead = { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 }
assert.equal(estimateUsageCost("claude-fable-5-1[1m]", cacheRead), 0.25)
assert.equal(estimateUsageCost("claude-fable-5", cacheRead), 1)
assert.equal(estimateUsageCost("claude-5-fable-low", cacheRead), 1)

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

  const summary = await usageSummary(sessionsRoot, homeRoot)

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
  type GrokModelUsage = { inputTokens: number; outputTokens: number; cachedReadTokens: number; cacheCreationTokens: number; costUsdTicks: number }
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
  const grokSummary = await usageSummary(join(root, "no-mako-sessions"), grokHome)
  const grok = grokSummary.sources?.find((source) => source.source === "Grok")
  assert.equal(grok?.messages, 2, "one event per model per turn; a repeated turn and other files add nothing")
  assert.equal(grok?.input, 140, "cached input is counted apart from fresh input")
  assert.equal(grok?.cacheRead, 800)
  assert.equal(grok?.cacheWrite, 100)
  assert.equal(grok?.output, 60)
  assert.ok(Math.abs((grok?.reportedCost ?? 0) - 0.026) < 1e-12, "cost ticks are ten-billionths of a dollar")
  assert.equal(grokSummary.projects?.[0]?.cwd, "/work/grok")
  assert.deepEqual(grokSummary.models?.map((model) => model.model).sort(), ["grok-build", "grok-fast"])
  console.log("Grok usage: per-model turn totals, cache apart from input, cost from ticks, project from the store path")
} finally {
  await rm(root, { recursive: true, force: true })
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
