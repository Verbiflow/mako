import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk"
import { ClaudeAgents } from "../electron/providers/claude/sdk-agents.ts"
import { ClaudeProjection } from "../electron/providers/claude/sdk-projection.ts"
import {
  CodexAgents,
  CodexAgentItemSchema,
} from "../electron/providers/codex/agents.ts"
import {
  disconnectNativeAgents,
  observeNativeAgent,
  NATIVE_AGENT_LIMIT,
  type NativeAgent,
  type NativeAgentRoster,
} from "../electron/contracts/native-agents.ts"
import { LiveConversations } from "../electron/live-conversations.ts"
import { LiveJournal } from "../electron/live-journal.ts"
import type { ProviderLiveDriver } from "../electron/providers/live-driver.ts"
import type { HostEvent, LiveSessionState } from "../electron/shared.ts"

const claude = new ClaudeAgents()
const common = { uuid: randomUUID(), session_id: "parent", task_id: "agent-1" }
const started = {
  ...common,
  type: "system",
  subtype: "task_started",
  description: "Inspect routing",
  task_type: "local_agent",
  subagent_type: "Explore",
  tool_use_id: "tool-1",
} satisfies SDKMessage
const progress = {
  ...common,
  type: "system",
  subtype: "task_progress",
  description: "Inspect routing",
  summary: "Reading routes",
  usage: { total_tokens: 90, tool_uses: 2, duration_ms: 1000 },
} satisfies SDKMessage
assert.equal(
  claude.project({
    ...started,
    task_id: "shell",
    task_type: "local_bash",
    subagent_type: undefined,
  }),
  undefined
)
assert.equal(
  claude.project({ ...started, task_id: "ambient", ambient: true }),
  undefined
)
assert.equal(claude.project(started)?.state.kind, "working")
assert.equal(claude.project(progress)?.usage?.tokens, 90)
const completed = {
  ...common,
  type: "system",
  subtype: "task_notification",
  status: "completed",
  output_file: "/unused",
  summary: "Found the route",
} satisfies SDKMessage
assert.deepEqual(claude.project(completed)?.state, {
  kind: "completed",
  summary: "Found the route",
})
assert.equal(
  claude.project(progress),
  undefined,
  "Late progress must not revive a completed agent"
)
assert.deepEqual(
  claude.project({
    ...common,
    type: "system",
    subtype: "task_updated",
    patch: { status: "completed" },
  })?.state,
  { kind: "completed", summary: "Found the route" }
)
assert.equal(
  claude.project(started)?.state.kind,
  "working",
  "A new start explicitly resumes work"
)
const projection = new ClaudeProjection()
assert.deepEqual(
  projection.project({
    type: "user",
    uuid: randomUUID(),
    session_id: "parent",
    parent_tool_use_id: "tool-1",
    message: { role: "user", content: "Nested prompt" },
  }),
  []
)
assert.deepEqual(
  projection.project({
    type: "stream_event",
    uuid: randomUUID(),
    session_id: "parent",
    parent_tool_use_id: "tool-1",
    event: {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Nested answer" },
    },
  }),
  []
)

const codex = new CodexAgents()
const spawn = CodexAgentItemSchema.parse({
  type: "collabAgentToolCall",
  id: "spawn",
  tool: "spawnAgent",
  status: "completed",
  senderThreadId: "parent",
  receiverThreadIds: ["child"],
  prompt: "Inspect tests",
  model: "test-model",
  agentsStates: {},
})
assert.equal(
  codex.project(spawn, false)[0]?.state.kind,
  "working",
  "Completing spawn does not complete its agent"
)
assert.equal(
  codex.project(
    {
      ...spawn,
      tool: "wait",
      agentsStates: { child: { status: "completed", message: "Tests pass" } },
    },
    false
  )[0]?.model,
  "test-model"
)
assert.equal(
  codex.project(
    {
      ...spawn,
      tool: "wait",
      agentsStates: { child: { status: "notFound", message: null } },
    },
    false
  )[0]?.state.kind,
  "unknown"
)
assert.equal(
  new CodexAgents().project(spawn, true)[0]?.state.kind,
  "unknown",
  "Replay cannot assert current activity"
)
assert.equal(
  codex.project(
    {
      type: "subAgentActivity",
      id: "interaction",
      kind: "interacted",
      agentThreadId: "child",
      agentPath: "child",
    },
    false
  ).length,
  0
)

const agent: NativeAgent = {
  nativeId: "one",
  title: "Inspect",
  bindingId: "binding",
  provider: "fixture",
  observedAt: 1,
  requestId: "first",
  state: { kind: "working" },
}
let roster: NativeAgentRoster = observeNativeAgent(undefined, agent)
roster = observeNativeAgent(roster, {
  ...agent,
  requestId: "later",
  state: { kind: "completed", summary: "Done" },
})
assert.equal(roster.agents.length, 1)
assert.equal(roster.agents[0]?.requestId, "first")
roster = observeNativeAgent(roster, { ...agent, bindingId: "other" })
assert.equal(roster.agents.length, 2, "Provider binding is part of identity")
assert.equal(
  disconnectNativeAgents(roster, "binding"),
  roster,
  "Settled observations retain identity"
)
assert.equal(
  disconnectNativeAgents(roster, "other")?.agents[1]?.state.kind,
  "unknown"
)
for (let index = 0; index < NATIVE_AGENT_LIMIT; index++)
  roster = observeNativeAgent(roster, {
    ...agent,
    nativeId: `bounded-${index}`,
  })
assert.equal(roster.agents.length, NATIVE_AGENT_LIMIT)
assert.equal(roster.limited, true)
assert.ok(
  !roster.agents.some(
    (entry) => entry.bindingId === "binding" && entry.nativeId === "one"
  ),
  "Evict settled observations first"
)

const root = mkdtempSync(join(tmpdir(), "mako-agents-"))
const id = randomUUID()
const session: LiveSessionState = {
  id,
  nativeId: "parent",
  harness: "fixture",
  cwd: root,
  status: "ready",
  connection: "connected",
  modes: [],
  currentMode: null,
  configOptions: [],
}
const events: HostEvent[] = []
const driver: ProviderLiveDriver = {
  provider: "fixture",
  canResume: true,
  available: () => true,
  start: async () => session,
  prompt: async () => {},
  permission: async () => {},
  cancel: async () => {},
  setMode: async () => {},
  close() {},
}
const dependencies = {
  root,
  appPath: root,
  driver: () => driver,
  history: async () => null,
  emit: (event: HostEvent) => events.push(event),
}
const owner = new LiveConversations(dependencies)
try {
  await owner.start("fixture", root, { conversationId: id })
  const initial = owner.snapshot(id)
  assert.ok(initial)
  owner.observe({ type: "live-agent", id, agent })
  const observed = owner.snapshot(id)
  assert.equal(observed?.nativeAgents?.agents[0]?.provider, "fixture")
  assert.equal(observed?.blocks, initial.blocks)
  const batch = events.findLast((event) => event.type === "live-batch")
  assert.ok(batch?.type === "live-batch")
  assert.equal(batch.batch.updates.length, 0)
  assert.equal(batch.batch.nativeAgents?.agents.length, 1)
  const journal = new LiveJournal(root, id)
  assert.equal(journal.read()?.nativeAgents?.agents[0]?.nativeId, "one")
  journal.close()
  owner.observe({
    type: "live-agent",
    id: randomUUID(),
    agent: { ...agent, nativeId: "stale" },
  })
  assert.equal(owner.snapshot(id)?.nativeAgents?.agents.length, 1)
  owner.stop()
  const recovered = new LiveConversations(dependencies)
  try {
    assert.equal(
      recovered.snapshot(id)?.nativeAgents?.agents[0]?.state.kind,
      "unknown"
    )
  } finally {
    recovered.stop()
  }
} finally {
  owner.stop()
  rmSync(root, { recursive: true, force: true })
}
console.log(
  "Native agents: provider lifecycle, nested-content isolation, bounded roster, narrow batches, journal and restart passed"
)
