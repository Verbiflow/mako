import assert from "node:assert/strict"
import { appendFile, mkdir, stat, writeFile } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

import { emitGrokSession } from "../dist/emit.js"
import { GrokProvider } from "../dist/providers/grok.js"

const home = mkdtempSync(join(tmpdir(), "sessions-grok-updates-"))
const jsonl = (value) => `${JSON.stringify(value)}\n`
const apply = (entries, update) =>
  update.replace
    ? [...entries.slice(0, update.replaceFrom ?? 0), ...update.entries]
    : [...entries, ...update.entries]

let events = 0
const notification = (method, update, timestamp, metadata = {}) =>
  jsonl({
    timestamp,
    method,
    params: {
      sessionId: "modern-session",
      update,
      _meta: { eventId: `event-${events++}`, agentTimestampMs: timestamp * 1000, ...metadata },
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
        content: { type: "text", text: "think " },
      },
      1_767_225_601
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "carefully" },
      },
      1_767_225_601
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "working" },
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
        content: [{ type: "content", content: { type: "text", text: "/work" } }],
      },
      1_767_225_604
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "tool_call",
        toolCallId: "tool-2",
        title: "fetch",
        rawInput: { url: "https://example.test" },
      },
      1_767_225_605
    ) +
    notification(
      "session/update",
      {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-2",
        status: "completed",
        content: [
          { type: "content", content: { type: "text", text: "fetched" } },
          { type: "content", content: { type: "text", text: "body" } },
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
    { type: "tool", id: "tool-1", name: "shell", input: '{\n  "command": "pwd"\n}', output: "/work" },
    {
      type: "tool",
      id: "tool-2",
      name: "fetch",
      input: '{\n  "url": "https://example.test"\n}',
      output: "fetched\nbody",
    },
  ])
  assert.deepEqual(assistants[1].blocks, [{type: "tool", name: "Plan", output: "", details: [{type: "plan", entries: [{content: "Verify result", status: "completed"}]}]}])
  assert.deepEqual(assistants[2], {
    kind: "assistant",
    at: "2026-01-01T00:00:08.000Z",
    usage: { input: 30, output: 30, cacheRead: 80, cacheWrite: 10, costUsd: 0.025 },
    blocks: [{ type: "text", text: "finished" }],
  })
  assert.deepEqual(
    incremental.filter((entry) => entry.kind === "event"),
    [
      {
        kind: "event",
        at: "2026-01-01T00:00:10.000Z",
        label: "Interrupted",
        source: { harness: "grok", record: "event-12" },
      },
    ],
    "a turn end cites the notification's eventId, as the live marker does"
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

  // Recorded from grok 1.0.44: an automatic compaction in the middle of a
  // turn, and the reminder that wakes Grok when a background subagent ends.
  const compactedDir = join(home, ".grok", "sessions", "%2Fwork", "compacted-session")
  const compactedPath = join(compactedDir, "updates.jsonl")
  await mkdir(compactedDir, { recursive: true })
  await writeFile(join(compactedDir, "summary.json"), JSON.stringify({ info: { id: "compacted-session", cwd: "/work" }, session_summary: "Compacted" }))
  const vendor = (update, timestamp) => jsonl({ timestamp, method: "_x.ai/session/update", params: { sessionId: "compacted-session", update } })
  const standard = (update, timestamp, meta) => jsonl({ timestamp, method: "session/update", params: { sessionId: "compacted-session", update: meta ? { ...update, _meta: meta } : update } })
  const wake = `<system-reminder>\nWhile you were idle, 1 background subagent completed:\n- [general-purpose] "Sleep 20 then reply" — completed successfully (32.9s, 2 tool calls)\n=== Task 01a0c67b ===\nCommand: [subagent:general-purpose] Sleep 20 then reply\nStatus: completed\n\n=== Output ===\nCHILD_DONE_GROK_A\n</system-reminder>`
  await writeFile(
    compactedPath,
    standard({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "Refactor the build" } }, 1_790_296_400) +
      standard({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Reading the scripts." } }, 1_790_296_401) +
      vendor({ sessionUpdate: "auto_compact_started", tokens_used: 403803, context_window: 500000, percentage: 81, reason: "Context window 81% full" }, 1_790_296_465) +
      vendor({ sessionUpdate: "compaction_checkpoint", checkpoint_id: "c8858747" }, 1_790_296_560) +
      vendor({ sessionUpdate: "auto_compact_completed", tokens_before: 403803, tokens_after: 21289, elapsed_ms: 94952, summary_preview: null }, 1_790_296_560) +
      standard({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Continuing." } }, 1_790_296_561) +
      vendor({ sessionUpdate: "turn_completed", prompt_id: "p1", stop_reason: "end_turn" }, 1_790_296_562) +
      standard({ sessionUpdate: "user_message_chunk", content: { type: "text", text: wake } }, 1_790_296_600, { promptIndex: 1, hideFromScrollback: true }) +
      standard({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "The subagent replied." } }, 1_790_296_601)
  )
  const compacted = await provider.read(compactedPath)
  assert.deepEqual(
    compacted.entries.map((entry) => entry.kind === "event" ? `event:${entry.opensTurn ? "opens:" : ""}${entry.label}${entry.detail ? ` — ${entry.detail}` : ""}` : entry.kind),
    [
      "user",
      "assistant",
      "event:Context compacted — Automatic · 404k → 21k tokens · took 1m 34s",
      "assistant",
      'event:opens:Subagent "Sleep 20 then reply" completed',
      "assistant",
    ],
    "a compaction marks where it happened, and a subagent's wake opens the turn it starts instead of reading as the user's words"
  )
  const compactedFollower = provider.createFollower(compactedPath, 0)
  assert.deepEqual(apply([], await compactedFollower.next()), compacted.entries, "following converges with a full read")

  // Grok 1.0.46 saves why it ended a turn in the `_meta` of `turn_completed`
  // (`cancellationCategory`, `cancelTrigger`), as live sends it.
  const endedDir = join(home, ".grok", "sessions", "%2Fwork", "ended-session")
  const endedPath = join(endedDir, "updates.jsonl")
  await mkdir(endedDir, { recursive: true })
  await writeFile(join(endedDir, "summary.json"), JSON.stringify({ info: { id: "ended-session", cwd: "/work" }, session_summary: "Ended" }))
  const said = (text, timestamp) => jsonl({ timestamp, method: "session/update", params: { sessionId: "ended-session", update: { sessionUpdate: "user_message_chunk", content: { type: "text", text } } } })
  const ended = (stop, meta, timestamp) => jsonl({ timestamp, method: "_x.ai/session/update", params: { sessionId: "ended-session", update: { sessionUpdate: "turn_completed", prompt_id: `p${timestamp}`, stop_reason: stop }, _meta: { eventId: `e${timestamp}`, ...meta } } })
  await writeFile(
    endedPath,
    said("Deploy it", 1_790_300_000) +
      jsonl({ timestamp: 1_790_300_001, method: "_x.ai/session/update", params: { sessionId: "ended-session", update: { sessionUpdate: "hook_annotation", message: "\u26a0 Prompt blocked by deploy-guard: Deploys need a ticket number", kind: "note" } } }) +
      ended("cancelled", { cancellationCategory: "HookDenied", cancellationContext: { hookName: "deploy-guard", reason: "Deploys need a ticket number" } }, 1_790_300_002) +
      said("Delete the cache", 1_790_300_010) +
      ended("cancelled", { cancellationCategory: "PermissionRejected" }, 1_790_300_011) +
      said("Keep going", 1_790_300_020) +
      ended("cancelled", { cancellationCategory: "max_turns_reached" }, 1_790_300_021) +
      said("Tidy up", 1_790_300_030) +
      ended("end_turn", { cancellationCategory: "action_stationarity" }, 1_790_300_031) +
      said("Run the suite", 1_790_300_040) +
      ended("cancelled", { cancellationCategory: "MidTurnAbort", cancelTrigger: "session_close" }, 1_790_300_041) +
      said("Run it again", 1_790_300_050) +
      ended("cancelled", { cancellationCategory: "MidTurnAbort", cancelTrigger: "esc" }, 1_790_300_051)
  )
  const endings = await provider.read(endedPath)
  assert.deepEqual(
    endings.entries.filter((entry) => entry.kind === "event").map(({ label, detail, tone }) => [label, detail, tone]),
    [
      ["Hook", "Prompt blocked by deploy-guard: Deploys need a ticket number", "warning"],
      ["Turn ended", "A permission was denied", undefined],
      ["Turn ended", "Reached the turn limit", "warning"],
      ["Turn ended", "Grok stopped making progress", "warning"],
      ["Interrupted", "The session closed", undefined],
      ["Interrupted", undefined, undefined],
    ],
    "a turn Grok ended by its own rule says which rule, a blocked prompt is explained once by its hook, and only a person's stop reads as Interrupted alone"
  )
  // A conversation moved into Grok: Grok restores and lists it from the
  // update stream, then appends its own turn there, numbering its prompt
  // after the moved-in ones (grok 1.0.46).
  const imported = await emitGrokSession(
    {
      ref: { harness: "claude", path: "/elsewhere.jsonl", title: "Moved in" },
      entries: [
        { kind: "user", at: "2026-01-02T00:00:00.000Z", text: "My codename is LANTERN." },
        { kind: "assistant", at: "2026-01-02T00:00:01.000Z", blocks: [{ type: "text", text: "Noted." }] },
        { kind: "user", at: "2026-01-02T00:00:02.000Z", text: "Remember it." },
        { kind: "assistant", at: "2026-01-02T00:00:03.000Z", blocks: [{ type: "text", text: "I will." }] },
      ],
    },
    { cwd: "/work", home }
  )
  assert.equal(basename(imported.path), "updates.jsonl", "a moved conversation is named by the file Grok restores it from")
  assert.ok((await provider.discover()).some((file) => file.path === imported.path))
  const grokTurn = (update, timestamp, metadata) => jsonl({ timestamp, method: update.sessionUpdate === "turn_completed" ? "_x.ai/session/update" : "session/update", params: { sessionId: imported.sessionId, update: metadata ? { ...update, _meta: metadata } : update } })
  await appendFile(
    imported.path,
    grokTurn({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "What codename did I give?" } }, 1_767_312_010, { promptIndex: 2 }) +
      grokTurn({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "LANTERN." } }, 1_767_312_011) +
      grokTurn({ sessionUpdate: "turn_completed", prompt_id: "p-live", stop_reason: "end_turn" }, 1_767_312_012)
  )
  const moved = await provider.read(imported.path)
  assert.deepEqual(
    moved.entries.map((entry) => entry.kind === "user" ? `user:${entry.text}` : entry.kind === "assistant" ? `assistant:${entry.blocks.map((block) => block.text).join("")}` : entry.kind),
    ["user:My codename is LANTERN.", "assistant:Noted.", "user:Remember it.", "assistant:I will.", "user:What codename did I give?", "assistant:LANTERN."],
    "the moved-in turns read before the one Grok ran after loading them"
  )
  assert.equal(moved.entries[0].at, "2026-01-02T00:00:00.000Z", "a moved-in turn keeps its time")
  assert.ok(moved.entries.every((entry) => entry.kind !== "event"), "a moved-in turn ends without a marker")

  console.log("Grok updates tests clean: authority, envelopes, chunks, tools, plans, usage, fallback, moved-in sessions, and convergence verified.")
} finally {
  rmSync(home, { recursive: true, force: true })
}
