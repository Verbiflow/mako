import assert from "node:assert/strict"
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { GrokProvider } from "../dist/providers/grok.js"

const home = mkdtempSync(join(tmpdir(), "sessions-grok-updates-"))
const jsonl = (value) => `${JSON.stringify(value)}\n`
const apply = (entries, update) =>
  update.replace
    ? [...entries.slice(0, update.replaceFrom ?? 0), ...update.entries]
    : [...entries, ...update.entries]

const notification = (method, update, timestamp, metadata = {}) =>
  jsonl({
    timestamp,
    method,
    params: {
      sessionId: "modern-session",
      update,
      _meta: { agentTimestampMs: timestamp * 1000, ...metadata },
    },
  })

try {
  const modernDir = join(
    home,
    ".grok",
    "sessions",
    "%2Fwork",
    "modern-session"
  )
  const updatesPath = join(modernDir, "updates.jsonl")
  const historyPath = join(modernDir, "chat_history.jsonl")
  await mkdir(modernDir, { recursive: true })
  await writeFile(updatesPath, "")
  await writeFile(
    historyPath,
    jsonl({ type: "user", content: "<user_query>duplicate legacy prompt</user_query>" })
  )
  await writeFile(
    join(modernDir, "summary.json"),
    JSON.stringify({
      info: { id: "modern-session", cwd: "/work" },
      session_summary: "Authoritative updates",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:10:00.000Z",
      current_model_id: "summary-model",
      reasoning_effort: "high",
    })
  )

  const legacyDir = join(
    home,
    ".grok",
    "sessions",
    "%2Fold",
    "legacy-session"
  )
  const legacyPath = join(legacyDir, "chat_history.jsonl")
  await mkdir(legacyDir, { recursive: true })
  await writeFile(
    legacyPath,
    jsonl({ type: "user", content: "<user_query>legacy prompt</user_query>" }) +
      jsonl({ type: "reasoning", summary: [{ text: "legacy thought" }] }) +
      jsonl({
        type: "assistant",
        content: [{ text: "legacy answer" }],
        tool_calls: [{ id: "legacy-tool", name: "shell", arguments: "{}" }],
      }) +
      jsonl({ type: "tool_result", tool_call_id: "legacy-tool", content: "legacy done" })
  )
  await writeFile(
    join(legacyDir, "summary.json"),
    JSON.stringify({
      info: { id: "legacy-session", cwd: "/old" },
      current_model_id: "legacy-model",
    })
  )

  const provider = new GrokProvider(home)
  const discovered = await provider.discover()
  assert.equal(discovered.length, 2, "one native file should be discovered per session")
  assert.deepEqual(
    discovered.map((file) => file.path).sort(),
    [legacyPath, updatesPath].sort(),
    "updates.jsonl must replace, rather than accompany, chat_history.jsonl"
  )

  const modernFile = discovered.find((file) => file.path === updatesPath)
  assert.ok(modernFile)
  const peeked = await provider.peek(modernFile)
  assert.deepEqual(peeked, {
    harness: "grok",
    nativeId: "modern-session",
    path: updatesPath,
    cwd: "/work",
    title: "Authoritative updates",
    model: "summary-model",
    settings: { model: "summary-model", options: { effort: "high" } },
    startedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: new Date(modernFile.mtimeMs).toISOString(),
    bytes: 0,
  })
  const legacyFile = discovered.find((file) => file.path === legacyPath)
  assert.ok(legacyFile)
  assert.equal((await provider.peek(legacyFile))?.title, "legacy prompt")

  const summaryPath = join(modernDir, "summary.json")
  const eventsPath = join(modernDir, "events.jsonl")
  await writeFile(eventsPath, "{}\n")
  assert.equal(
    await provider.peek({ path: summaryPath, bytes: 1, mtimeMs: 0 }),
    null,
    "summary.json is a sidecar, not a session row"
  )
  assert.equal(
    await provider.peek({ path: eventsPath, bytes: 1, mtimeMs: 0 }),
    null,
    "events.jsonl is a sidecar, not a session row"
  )
  assert.equal(
    await provider.peek({ path: historyPath, bytes: 1, mtimeMs: 0 }),
    null,
    "chat_history.jsonl must not peek while updates.jsonl exists"
  )
  assert.equal(provider.watchTarget(summaryPath), updatesPath)
  assert.equal(provider.watchTarget(eventsPath), updatesPath)
  assert.equal(provider.watchTarget(historyPath), updatesPath)
  assert.equal(provider.watchTarget(updatesPath), updatesPath)
  assert.equal(
    provider.watchTarget(join(home, ".grok", "sessions", "%2Fwork", "prompt_history.jsonl")),
    null
  )

  await writeFile(
    summaryPath,
    JSON.stringify({
      info: { id: "modern-session", cwd: "/work" },
      generated_title: "Grok Session Inquiry",
      session_summary: "A later running summary",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:20:00.000Z",
      current_model_id: "summary-model",
      reasoning_effort: "high",
    })
  )
  const renamed = await provider.refine(peeked, 0)
  assert.equal(
    renamed.title,
    "Grok Session Inquiry",
    "generated_title is the session name; session_summary is not"
  )
  assert.equal(renamed.path, updatesPath)

  const firstBatch =
    notification(
      "session/update",
      {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text: "modern prompt" },
      },
      1_767_225_600,
      { promptIndex: 0, modelId: "stale-event-model" }
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "agent_thought_chunk",
        content: [
          { type: "text", text: "think " },
          { type: "content", content: { type: "text", text: "carefully" } },
        ],
      },
      1_767_225_601
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "content", content: { type: "text", text: "working" } },
      },
      1_767_225_602
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "shell",
        rawInput: { command: "pwd" },
      },
      1_767_225_603
    )

  const secondBatch =
    notification(
      "session/update",
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        title: "shell",
        status: "completed",
        content: { type: "text", text: "/work" },
      },
      1_767_225_604
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-2",
        title: "fetch",
        rawInput: { url: "https://example.test" },
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "fetched " } },
          { type: "text", text: "body" },
        ],
      },
      1_767_225_605
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "plan",
        entries: [{ content: "Verify result", priority: "medium", status: "pending" }],
      },
      1_767_225_606
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "plan",
        entries: [{ content: "Verify result", priority: "medium", status: "completed" }],
      },
      1_767_225_607
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "finished" },
      },
      1_767_225_608
    ) +
    notification(
      "_x.ai/session/update",
      {
        sessionUpdate: "turn_completed",
        prompt_id: "prompt-1",
        stop_reason: "end_turn",
        usage: {
          inputTokens: 120,
          outputTokens: 30,
          cachedReadTokens: 80,
          cacheCreationTokens: 10,
          costUsdTicks: 250_000_000,
        },
      },
      1_767_225_609
    )

  const interruptedBatch = notification(
    "_x.ai/session/update",
    {
      sessionUpdate: "turn_completed",
      prompt_id: "prompt-2",
      stop_reason: "cancelled",
    },
    1_767_225_610
  )

  const follower = provider.createFollower(updatesPath, 0)
  let incremental = []
  for (const batch of [firstBatch, secondBatch, interruptedBatch]) {
    await appendFile(updatesPath, batch)
    const update = await follower.next()
    incremental = apply(incremental, update)
    const full = await provider.read(updatesPath)
    assert.ok(full)
    assert.deepEqual(incremental, full.entries, "full reads and following must converge")
  }

  assert.equal(incremental.filter((entry) => entry.kind === "user").length, 1)
  assert.equal(incremental[0].text, "modern prompt")
  assert.ok(
    !incremental.some(
      (entry) => entry.kind === "user" && entry.text === "duplicate legacy prompt"
    ),
    "the legacy log must not be merged into authoritative updates"
  )

  const assistants = incremental.filter((entry) => entry.kind === "assistant")
  assert.equal(assistants.length, 3)
  assert.deepEqual(assistants[0].blocks, [
    { type: "thinking", text: "think carefully" },
    { type: "text", text: "working" },
    { type: "tool", name: "shell", input: '{"command":"pwd"}', output: "/work" },
    {
      type: "tool",
      name: "fetch",
      input: '{"url":"https://example.test"}',
      output: "fetched body",
    },
  ])
  assert.deepEqual(assistants[1].blocks, [{type: "tool", name: "Plan", output: "", details: [{type: "plan", entries: [{content: "Verify result", status: "completed"}]}]}])
  assert.deepEqual(assistants[2], {
    kind: "assistant",
    at: "2026-01-01T00:00:08.000Z",
    usage: { input: 120, output: 30, cacheRead: 80, cacheWrite: 10, costUsd: 0.25 },
    blocks: [{ type: "text", text: "finished" }],
  })
  assert.deepEqual(
    incremental.filter((entry) => entry.kind === "event"),
    [
      {
        kind: "event",
        at: "2026-01-01T00:00:10.000Z",
        label: "Interrupted",
      },
    ]
  )

  const legacy = await provider.read(legacyPath)
  assert.ok(legacy)
  assert.deepEqual(legacy.entries, [
    { kind: "user", text: "legacy prompt" },
    {
      kind: "assistant",
      blocks: [
        { type: "thinking", text: "legacy thought" },
        { type: "text", text: "legacy answer" },
        { type: "tool", name: "shell", input: "{}", output: "legacy done" },
      ],
    },
  ])

  const finalInfo = await stat(updatesPath)
  assert.equal(follower.offset, finalInfo.size)
  console.log("Grok updates tests clean: authority, envelopes, chunks, tools, plans, usage, fallback, and convergence verified.")
} finally {
  rmSync(home, { recursive: true, force: true })
}
