import assert from "node:assert/strict"
import { mkdir } from "node:fs/promises"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

import { SessionCatalog } from "../dist/catalog.js"
import { OpenCodeProvider } from "../dist/providers/opencode.js"

// A caller-supplied home isolates fixtures from the user's native configuration.
const configuredHome = join(tmpdir(), "opencode-configured-root-test")
assert.deepEqual(new OpenCodeProvider(configuredHome).roots(), [join(configuredHome, ".local", "share", "opencode")])
assert.deepEqual(new OpenCodeProvider(configuredHome, { XDG_DATA_HOME: "/custom/data" }).roots(), ["/custom/data/opencode"])
assert.deepEqual(new OpenCodeProvider(configuredHome, { OPENCODE_DB: "/custom/exact.db" }).roots(), ["/custom"])
assert.deepEqual(new OpenCodeProvider(configuredHome, { OPENCODE_DB: ":memory:" }).roots(), [])

const home = mkdtempSync(join(tmpdir(), "sessions-opencode-"))
const root = join(home, ".local", "share", "opencode")
const legacyPath = join(root, "opencode.db")
const currentPath = join(root, "opencode-next.db")
const json = (value) => JSON.stringify(value)
const apply = (entries, update) =>
  update.replace
    ? [...entries.slice(0, update.replaceFrom ?? 0), ...update.entries]
    : [...entries, ...update.entries]

await mkdir(root, { recursive: true })
const legacy = new DatabaseSync(legacyPath)
const current = new DatabaseSync(currentPath)

try {
  legacy.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, title TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX message_session_idx ON message(session_id, time_created, id);
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX part_session_idx ON part(session_id);
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, title TEXT NOT NULL, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX session_v2_message_seq_idx ON session_message(session_id, seq);
  `)
  current.exec(`
    CREATE TABLE project (
      id TEXT PRIMARY KEY, worktree TEXT NOT NULL, name TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL
    );
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, parent_id TEXT,
      directory TEXT NOT NULL, title TEXT NOT NULL, model TEXT,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL,
      time_archived INTEGER
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE part (
      id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE UNIQUE INDEX session_message_seq_idx ON session_message(session_id, seq);
    CREATE TABLE session_pending (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL,
      data TEXT NOT NULL, delivery TEXT NOT NULL, admitted_seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL
    );
  `)

  legacy.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?)").run(
    "legacy-project",
    "/projects/legacy-root",
    "Legacy project",
    1000,
    1000
  )
  const insertLegacySession = legacy.prepare(
    "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  )
  insertLegacySession.run(
    "ses_legacy",
    "legacy-project",
    null,
    "/projects/legacy-root/app",
    "Legacy root session",
    1000,
    3000,
    null
  )
  insertLegacySession.run(
    "ses_legacy_child",
    "legacy-project",
    "ses_legacy",
    "/projects/legacy-root/app",
    "Search files (@explore subagent)",
    1100,
    2100,
    null
  )
  insertLegacySession.run(
    "ses_other",
    "legacy-project",
    null,
    "/projects/other",
    "Other session",
    1200,
    2200,
    null
  )
  const insertMessage = legacy.prepare(
    "INSERT INTO message VALUES (?, ?, ?, ?, ?)"
  )
  const insertPart = legacy.prepare(
    "INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)"
  )
  insertMessage.run(
    "msg_legacy_user",
    "ses_legacy",
    1000,
    1000,
    json({
      role: "user",
      time: { created: 1000 },
      agent: "build",
      model: { modelID: "claude-legacy", providerID: "anthropic" },
      system: "LEGACY_SYSTEM_SECRET",
    })
  )
  insertPart.run(
    "prt_001",
    "msg_legacy_user",
    "ses_legacy",
    1000,
    1000,
    json({ type: "text", text: "legacy prompt" })
  )
  insertPart.run(
    "prt_002",
    "msg_legacy_user",
    "ses_legacy",
    1001,
    1001,
    json({ type: "text", text: "LEGACY_SYNTHETIC_SECRET", synthetic: true })
  )
  insertMessage.run(
    "msg_legacy_assistant",
    "ses_legacy",
    2000,
    2000,
    json({
      role: "assistant",
      time: { created: 2000, completed: 2600 },
      modelID: "claude-legacy",
      providerID: "anthropic",
      cost: 0.125,
      tokens: {
        input: 100,
        output: 25,
        reasoning: 5,
        cache: { read: 40, write: 10 },
      },
      error: { name: "MessageAbortedError", data: { message: "request aborted" } },
    })
  )
  insertPart.run(
    "prt_010",
    "msg_legacy_assistant",
    "ses_legacy",
    2000,
    2000,
    json({ type: "reasoning", text: "legacy reasoning", time: { start: 2000 } })
  )
  insertPart.run(
    "prt_011",
    "msg_legacy_assistant",
    "ses_legacy",
    2100,
    2100,
    json({
      type: "tool",
      callID: "call_legacy",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/projects/legacy-root/app",
        title: "pwd",
        metadata: {},
        time: { start: 2100, end: 2200 },
      },
    })
  )
  insertPart.run(
    "prt_012",
    "msg_legacy_assistant",
    "ses_legacy",
    2300,
    2300,
    json({ type: "text", text: "legacy answer" })
  )
  insertMessage.run(
    "msg_legacy_compaction",
    "ses_legacy",
    3000,
    3000,
    json({
      role: "user",
      time: { created: 3000 },
      system: "COMPACTION_PROTOCOL_SECRET",
    })
  )
  insertPart.run(
    "prt_020",
    "msg_legacy_compaction",
    "ses_legacy",
    3000,
    3000,
    json({ type: "compaction", auto: true })
  )
  insertMessage.run(
    "msg_other_user",
    "ses_other",
    1200,
    1200,
    json({ role: "user", time: { created: 1200 } })
  )
  insertPart.run(
    "prt_other",
    "msg_other_user",
    "ses_other",
    1200,
    1200,
    json({ type: "text", text: "other prompt" })
  )
  insertMessage.run(
    "msg_child_user",
    "ses_legacy_child",
    1300,
    1300,
    json({ role: "user", time: { created: 1300 } })
  )
  insertPart.run(
    "prt_child",
    "msg_child_user",
    "ses_legacy_child",
    1300,
    1300,
    json({ type: "text", text: "subagent protocol" })
  )

  const insertV2Session = legacy.prepare(
    "INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  insertV2Session.run(
    "ses_legacy",
    "legacy-project",
    null,
    "/projects/legacy-root/app",
    "Legacy shadow projection",
    json({ id: "shadow-model", providerID: "shadow-provider" }),
    1000,
    3000,
    null
  )
  insertV2Session.run(
    "ses_v2",
    "legacy-project",
    null,
    "/projects/v2-root",
    "OpenCode 2 session",
    json({ id: "gpt-v2", providerID: "openai", variant: "low" }),
    6000,
    7000,
    null
  )
  legacy.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "msg_v2_user",
    "ses_v2",
    "user",
    0,
    6000,
    6000,
    json({ text: "v2 prompt", files: [], agents: [], time: { created: 6000 } })
  )
  legacy.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    "msg_v2_assistant",
    "ses_v2",
    "assistant",
    1,
    6500,
    7000,
    json({
      agent: "build",
      model: { id: "gpt-v2", providerID: "openai" },
      content: [
        { type: "text", text: "v2 answer" },
        { type: "file", uri: "data:image/png;base64,cHJvb2Y=", mime: "image/png" },
      ],
      finish: "stop",
      tokens: { input: 12, output: 4, reasoning: 1, cache: { read: 2, write: 0 } },
      time: { created: 6500, completed: 7000 },
    })
  )

  current.prepare("INSERT INTO project VALUES (?, ?, ?, ?, ?)").run(
    "current-project",
    "/projects/current-root",
    "Current project",
    4000,
    4000
  )
  const insertCurrentSession = current.prepare(
    "INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  insertCurrentSession.run(
    "ses_current",
    "current-project",
    null,
    "/projects/current-root/pkg",
    "Current root session",
    json({ id: "gpt-current", providerID: "openai" }),
    4000,
    8000,
    8100
  )
  insertCurrentSession.run(
    "ses_current_child",
    "current-project",
    "ses_current",
    "/projects/current-root/pkg",
    "Current child",
    null,
    4100,
    4200,
    null
  )
  const insertCurrent = current.prepare(
    "INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)"
  )
  insertCurrent.run(
    "msg_current_user",
    "ses_current",
    "user",
    0,
    4000,
    4000,
    json({
      text: "current prompt",
      files: [],
      agents: [],
      time: { created: 4000 },
      metadata: { hiddenProtocol: "CURRENT_USER_METADATA_SECRET" },
    })
  )
  insertCurrent.run(
    "msg_current_assistant",
    "ses_current",
    "assistant",
    1,
    5000,
    6000,
    json({
      agent: "build",
      model: { id: "gpt-current", providerID: "openai" },
      content: [
        { type: "reasoning", id: "reason_1", text: "current reasoning" },
        {
          type: "tool",
          id: "tool_1",
          name: "read",
          state: {
            status: "completed",
            input: { path: "README.md" },
            content: [{ type: "text", text: "current tool output" }],
            structured: {},
          },
          time: { created: 5100, completed: 5200 },
        },
        { type: "text", id: "text_1", text: "current answer" },
      ],
      finish: "stop",
      cost: 0.25,
      tokens: {
        input: 200,
        output: 50,
        reasoning: 10,
        cache: { read: 80, write: 20 },
      },
      time: { created: 5000, completed: 6000 },
    })
  )
  insertCurrent.run(
    "msg_current_system",
    "ses_current",
    "system",
    2,
    6100,
    6100,
    json({ text: "CURRENT_SYSTEM_SECRET", time: { created: 6100 } })
  )
  insertCurrent.run(
    "msg_current_compaction",
    "ses_current",
    "compaction",
    3,
    7000,
    7000,
    json({
      reason: "manual",
      summary: "CURRENT_COMPACTION_SECRET",
      recent: "CURRENT_RECENT_SECRET",
      time: { created: 7000 },
    })
  )
  insertCurrent.run(
    "msg_current_interrupted",
    "ses_current",
    "assistant",
    4,
    8000,
    8000,
    json({
      agent: "build",
      model: { id: "gpt-current", providerID: "openai" },
      content: [{ type: "text", id: "text_2", text: "partial answer" }],
      error: { type: "unknown", message: "generation interrupted" },
      time: { created: 8000 },
    })
  )
  insertCurrent.run(
    "msg_current_child_user",
    "ses_current_child",
    "user",
    0,
    4100,
    4100,
    json({ text: "current child protocol", files: [], agents: [], time: { created: 4100 } })
  )
  current
    .prepare("INSERT INTO session_pending VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(
      "pending_current",
      "ses_current",
      "prompt",
      json({ text: "queued" }),
      "steer",
      1,
      8100
    )

  const provider = new OpenCodeProvider(home)
  const discovered = await provider.discover()
  assert.equal(discovered.length, 4)
  assert.deepEqual(
    discovered.map((file) => file.path).sort(),
    [
      `${legacyPath}#ses_legacy`,
      `${legacyPath}#ses_other`,
      `${legacyPath}#v2:ses_v2`,
      `${currentPath}#ses_current`,
    ].sort()
  )
  assert.ok(discovered.every((file) => Number.isSafeInteger(file.bytes)))
  assert.deepEqual(
    (await provider.discover()).map((file) => file.path).sort(),
    discovered.map((file) => file.path).sort()
  )

  const legacyFile = discovered.find((file) => file.path.endsWith("#ses_legacy"))
  const currentFile = discovered.find((file) => file.path.endsWith("#ses_current"))
  const v2File = discovered.find((file) => file.path.endsWith("#v2:ses_v2"))
  assert.ok(legacyFile)
  assert.ok(currentFile)
  assert.ok(v2File)
  const legacyRef = await provider.peek(legacyFile)
  const currentRef = await provider.peek(currentFile)
  const v2Ref = await provider.peek(v2File)
  assert.equal(legacyRef.cwd, "/projects/legacy-root/app")
  assert.equal(legacyRef.title, "Legacy root session")
  assert.equal(legacyRef.model, "anthropic/claude-legacy")
  assert.equal(legacyRef.modelProvider, "anthropic")
  assert.equal(legacyRef.archived, false)
  assert.equal(currentRef.cwd, "/projects/current-root/pkg")
  assert.equal(currentRef.model, "openai/gpt-current")
  assert.equal(currentRef.modelProvider, "openai")
  assert.equal(currentRef.archived, true)
  assert.equal(currentRef.active, undefined, "A persisted pending row is not a live process status")
  current.prepare("DELETE FROM session_pending WHERE id = ?").run("pending_current")
  assert.equal((await provider.peek(currentFile))?.active, undefined)
  assert.equal(v2Ref.cwd, "/projects/v2-root")
  assert.equal(v2Ref.title, "OpenCode 2 session")
  assert.equal(v2Ref.model, "openai/gpt-v2")
  assert.equal(v2Ref.modelProvider, "openai")
  assert.deepEqual(v2Ref.settings, {model:"openai/gpt-v2",options:{effort:"low"}})

  const v2Thread = await provider.read(v2File.path)
  assert.deepEqual(v2Thread?.entries, [
    { kind: "user", id: "msg_v2_user", attachments: [], at: "1970-01-01T01:40:00.000Z", text: "v2 prompt" },
    {
      kind: "assistant",
      at: "1970-01-01T01:48:20.000Z",
      model: "gpt-v2",
      usage: { input: 12, output: 4, cacheRead: 2, cacheWrite: 0 },
      blocks: [
        { type: "text", text: "v2 answer" },
        { type: "attachment", name: "Attachment", mimeType: "image/png", source: { kind: "inline", data: "cHJvb2Y=" } },
      ],
    },
  ])

  const legacyThread = await provider.read(legacyFile.path)
  assert.ok(legacyThread)
  assert.equal(legacyThread.ref.modelProvider, "anthropic")
  assert.deepEqual(legacyThread.entries, [
    { kind: "user", id: "msg_legacy_user", attachments: [], at: "1970-01-01T00:16:40.000Z", text: "legacy prompt" },
    {
      kind: "assistant",
      at: "1970-01-01T00:33:20.000Z",
      model: "claude-legacy",
      usage: { input: 100, output: 25, cacheRead: 40, cacheWrite: 10, costUsd: 0.125 },
      blocks: [
        { type: "thinking", text: "legacy reasoning" },
        {
          type: "tool",
          name: "bash",
          id: "call_legacy",
          input: '{"command":"pwd"}',
          output: "/projects/legacy-root/app",
        },
        { type: "text", text: "legacy answer" },
      ],
    },
    { kind: "event", at: "1970-01-01T00:33:20.000Z", label: "Interrupted" },
    {
      kind: "event",
      at: "1970-01-01T00:50:00.000Z",
      label: "Context compacted",
      detail: "Automatic",
    },
  ])
  const legacySerialized = JSON.stringify(legacyThread)
  assert.ok(!legacySerialized.includes("LEGACY_SYSTEM_SECRET"))
  assert.ok(!legacySerialized.includes("LEGACY_SYNTHETIC_SECRET"))
  assert.ok(!legacySerialized.includes("COMPACTION_PROTOCOL_SECRET"))

  const currentThread = await provider.read(currentFile.path)
  assert.ok(currentThread)
  assert.deepEqual(currentThread.entries, [
    { kind: "user", id: "msg_current_user", attachments: [], at: "1970-01-01T01:06:40.000Z", text: "current prompt" },
    {
      kind: "assistant",
      at: "1970-01-01T01:23:20.000Z",
      model: "gpt-current",
      usage: { input: 200, output: 50, cacheRead: 80, cacheWrite: 20, costUsd: 0.25 },
      blocks: [
        { type: "thinking", text: "current reasoning" },
        {
          type: "tool",
          name: "read",
          id: "tool_1",
          input: '{"path":"README.md"}',
          output: "current tool output",
        },
        { type: "text", text: "current answer" },
      ],
    },
    {
      kind: "event",
      at: "1970-01-01T01:56:40.000Z",
      label: "Context compacted",
      detail: "Manual",
    },
    {
      kind: "assistant",
      at: "1970-01-01T02:13:20.000Z",
      model: "gpt-current",
      blocks: [{ type: "text", text: "partial answer" }],
    },
    { kind: "event", at: "1970-01-01T02:13:20.000Z", label: "Interrupted" },
  ])
  const currentSerialized = JSON.stringify(currentThread)
  assert.ok(!currentSerialized.includes("CURRENT_SYSTEM_SECRET"))
  assert.ok(!currentSerialized.includes("CURRENT_COMPACTION_SECRET"))
  assert.ok(!currentSerialized.includes("CURRENT_RECENT_SECRET"))
  assert.ok(!currentSerialized.includes("CURRENT_USER_METADATA_SECRET"))

  const isolatedFollower = provider.createFollower(legacyFile.path, legacyThread.ref.bytes)
  const beforeIsolation = new Map(
    discovered.map((file) => [file.path, file.bytes])
  )
  legacy.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(3500, "ses_other")
  insertMessage.run(
    "msg_other_assistant",
    "ses_other",
    3500,
    3500,
    json({ role: "assistant", modelID: "other-model", providerID: "other-provider", time: { created: 3500 } })
  )
  insertPart.run(
    "prt_other_answer",
    "msg_other_assistant",
    "ses_other",
    3500,
    3500,
    json({ type: "text", text: "other answer" })
  )
  const isolated = await isolatedFollower.next()
  assert.deepEqual(isolated, {
    entries: [],
    nextByte: legacyThread.ref.bytes,
    replace: false,
  })
  const afterIsolation = new Map(
    (await provider.discover()).map((file) => [file.path, file.bytes])
  )
  assert.equal(afterIsolation.get(legacyFile.path), beforeIsolation.get(legacyFile.path))
  assert.notEqual(
    afterIsolation.get(`${legacyPath}#ses_other`),
    beforeIsolation.get(`${legacyPath}#ses_other`)
  )

  let legacyIncremental = structuredClone(legacyThread.entries)
  insertMessage.run(
    "msg_legacy_append",
    "ses_legacy",
    4000,
    4000,
    json({
      role: "assistant",
      modelID: "claude-legacy",
      providerID: "anthropic",
      time: { created: 4000 },
    })
  )
  insertPart.run(
    "prt_030",
    "msg_legacy_append",
    "ses_legacy",
    4000,
    4000,
    json({ type: "text", text: "appended answer" })
  )
  legacy.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(4000, "ses_legacy")
  const legacyAppend = await isolatedFollower.next()
  assert.equal(legacyAppend.replace, false)
  assert.deepEqual(legacyAppend.entries, [
    {
      kind: "assistant",
      at: "1970-01-01T01:06:40.000Z",
      model: "claude-legacy",
      blocks: [{ type: "text", text: "appended answer" }],
    },
  ])
  legacyIncremental = apply(legacyIncremental, legacyAppend)

  legacy.prepare("UPDATE part SET time_updated = ?, data = ? WHERE id = ?").run(
    5000,
    json({
      type: "tool",
      callID: "call_legacy",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "pwd" },
        output: "/projects/replaced",
        title: "pwd",
        metadata: {},
        time: { start: 2100, end: 5000 },
      },
    }),
    "prt_011"
  )
  legacy.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(5000, "ses_legacy")
  const legacyReplace = await isolatedFollower.next()
  assert.equal(legacyReplace.replace, true)
  assert.equal(legacyReplace.replaceFrom, 1)
  legacyIncremental = apply(legacyIncremental, legacyReplace)
  assert.deepEqual(legacyIncremental, (await provider.read(legacyFile.path)).entries)

  const currentFollower = provider.createFollower(currentFile.path, currentThread.ref.bytes)
  let currentIncremental = structuredClone(currentThread.entries)
  insertCurrent.run(
    "msg_current_append",
    "ses_current",
    "user",
    5,
    9000,
    9000,
    json({ text: "follow-up", files: [], agents: [], time: { created: 9000 } })
  )
  current.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(9000, "ses_current")
  const currentAppend = await currentFollower.next()
  assert.equal(currentAppend.replace, false)
  assert.deepEqual(currentAppend.entries, [
    { kind: "user", id: "msg_current_append", at: "1970-01-01T02:30:00.000Z", text: "follow-up", attachments: [] },
  ])
  currentIncremental = apply(currentIncremental, currentAppend)

  const replacedAssistant = {
    agent: "build",
    model: { id: "gpt-current", providerID: "openai" },
    content: [
      { type: "reasoning", id: "reason_1", text: "revised reasoning" },
      {
        type: "tool",
        id: "tool_1",
        name: "read",
        state: {
          status: "error",
          input: { path: "README.md" },
          content: [],
          structured: {},
          error: { type: "unknown", message: "read failed" },
        },
        time: { created: 5100, completed: 10_000 },
      },
      {
        type: "tool",
        id: "tool_2",
        name: "shell",
        state: {
          status: "error",
          input: { command: "sleep 45" },
          error: { type: "aborted", message: "Tool execution interrupted" },
        },
        time: { created: 5200, completed: 10_000 },
      },
      { type: "text", id: "text_1", text: "revised answer" },
    ],
    finish: "stop",
    cost: 0.3,
    tokens: {
      input: 210,
      output: 55,
      reasoning: 12,
      cache: { read: 82, write: 21 },
    },
    time: { created: 5000, completed: 10_000 },
  }
  current.prepare("UPDATE session_message SET time_updated = ?, data = ? WHERE id = ?").run(
    10_000,
    json(replacedAssistant),
    "msg_current_assistant"
  )
  current.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(10_000, "ses_current")
  const currentReplace = await currentFollower.next()
  assert.equal(currentReplace.replace, true)
  assert.equal(currentReplace.replaceFrom, 1)
  currentIncremental = apply(currentIncremental, currentReplace)
  const currentFull = await provider.read(currentFile.path)
  assert.deepEqual(currentIncremental, currentFull.entries)
  const [replacedTool, stoppedTool] = currentFull.entries
    .filter((entry) => entry.kind === "assistant")
    .flatMap((entry) => entry.blocks)
    .filter((block) => block.type === "tool")
  assert.deepEqual(stoppedTool, {
    type: "tool",
    name: "shell",
    id: "tool_2",
    input: '{"command":"sleep 45"}',
    output: "Tool execution interrupted",
    canceled: true,
  }, "a call the user stopped reads as cancelled, not failed")
  assert.deepEqual(replacedTool, {
    type: "tool",
    name: "read",
    id: "tool_1",
    input: '{"path":"README.md"}',
    output: "read failed",
    error: true,
  })

  const catalog = new SessionCatalog([provider])
  try {
    await catalog.scan()
    const viewed = await catalog.open(currentFile.path)
    const updates = []
    catalog.follow(currentFile.path, viewed.ref.bytes, entries => updates.push(...entries))
    catalog.startWatching()
    for (const watcher of catalog.watchers.values()) watcher.close()
    current.exec("PRAGMA journal_mode=WAL")
    current.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "msg_observed", "ses_current", "user", 6, 11000, 11000,
      json({ text: "observed through WAL", files: [], agents: [], time: { created: 11000 } })
    )
    current.prepare("UPDATE session SET time_updated = ? WHERE id = ?").run(11000, "ses_current")
    const deadline = Date.now() + 2000
    while (!updates.some(entry => entry.kind === "user" && entry.text === "observed through WAL")) {
      assert.ok(Date.now() < deadline, "OpenCode WAL update delivered without directory events")
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    console.log("OpenCode native WAL observation delivered without directory events")
  } finally { await catalog.stop() }

  console.log("OpenCode provider tests clean: V1, V2, projected sessions, roots, metadata, tools, reasoning, usage, interruption, compaction, isolation, and follower diffs verified.")
} finally {
  legacy.close()
  current.close()
  rmSync(home, { recursive: true, force: true })
}
