import { providerHost } from "../electron/providers/index.ts"
import { syncThreadStatus } from "../src/state/acp-live.ts"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  clampCompanionWidth,
  clampDockHeight,
  fitsBeside,
} from "../src/components/stage/stage-width.ts"
import {
  decodeFileCitation,
  linkFileCitations,
  markdownFileTarget,
} from "../src/lib/file-citations.ts"
import {
  argAt,
  isSubagentLaunch,
  normalizeToolOutput,
  parseToolExecutionOutput,
  subagentResultId,
  subagentResultText,
  summarizeToolWork,
  toolLabel,
} from "../src/lib/tools.ts"
import {
  activeThreadRefs,
  applyThreadActivity,
  applyThreadRun,
  markThreadReviewed,
  recentThreadActivityDuration,
  threadStatus,
  threadStatusPriority,
  threadsStore,
  uniqueThreadRefs,
} from "../src/state/threads.ts"
import { cacheOf, dropCache, writeCache } from "../src/state/tabs.ts"
import {
  appendOptimisticReply,
  removeOptimisticReply,
} from "../src/state/thread-queue.ts"
import {
  groupThreadFolders,
  orderThreadFolders,
  stableFolderRanks,
  stableThreadRanks,
  threadBelongsToWorkspace,
  threadFolderKey,
  visibleThreadFolders,
  type RailRanks,
} from "../src/lib/thread-folders.ts"
import {
  boardBucketOf,
  groupThreadBoard,
  liveBoardBucket,
} from "../src/lib/thread-board.ts"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.ts"
import { runningTerminalForWorkspace } from "../src/state/terminal.ts"
import { workspaceFocusOf } from "../src/components/stage/workspace-focus-context.ts"
import {
  composerActionKind,
  composerEnterAction,
  composerRunningPlaceholder,
  composerTurnRunning,
} from "../src/lib/composer-action.ts"
import { responseSections } from "../src/lib/exchanges.ts"
import {
  pendingThreadInput,
  threadToMessages,
} from "../src/lib/foreign-thread.ts"
import { acp, acpStore, type LiveAcpConversation } from "../src/state/acp.ts"
import { applyLiveBatch, hydrateLiveSummaries } from "../src/state/live-recovery.ts"
import { notificationsStore } from "../src/state/notifications.ts"
import { acknowledgeThread } from "../src/state/thread-lifecycle.ts"
import type {
  LiveUpdate,
  LivePermissionRequest,
  LiveSessionState,
} from "../src/lib/types.ts"
function applySession(session: LiveSessionState) {
  applyLiveBatch({
    id: session.id,
    revision: (acpStore.get().conversations[session.id]?.revision ?? 0) + 1,
    updates: [],
    session,
  })
}
function applyUpdates(id: string, updates: LiveUpdate[]) {
  applyLiveBatch({
    id,
    revision: (acpStore.get().conversations[id]?.revision ?? 0) + 1,
    updates,
  })
}
function applyPermission(request: LivePermissionRequest) {
  applyLiveBatch({
    id: request.sessionId,
    revision:
      (acpStore.get().conversations[request.sessionId]?.revision ?? 0) + 1,
    updates: [],
    permissions: [request],
  })
}
import {
  canonicalThreadRefs,
  sameAcpPresence,
  selectAcpPresence,
} from "../src/state/acp-presence.ts"
import type {
  ChatMessage,
  TerminalSession,
  ThreadEntry,
  ThreadRef,
} from "../src/lib/types.ts"

const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8")
const threadViewerSource = readFileSync(
  new URL("../src/components/viewer/thread-viewer.tsx", import.meta.url),
  "utf8"
)
const threadViewingSource = readFileSync(
  new URL("../src/state/thread-viewing.ts", import.meta.url),
  "utf8"
)
// Decorative motion is allowed only on the ocean layers, paused until the
// visible scene opts in. Transcript and workspace chrome must never loop.
const motionLayers = new Set([
  ".ocean-light",
  ".ocean-light .ocean-engraving",
  ".ocean-grain",
  ".ocean-fin-glint",
])
const stateFeedback = new Map([
  ["[data-commit-box][data-busy] .commit-editor::after", "git-progress"],
  ['[data-push-state="pushing"] > svg', "git-upload"],
])
const cssWithoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "")
const rules = [...cssWithoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
for (const [, selector, declarations] of rules) {
  if (
    !/\banimation(?:-iteration-count)?\s*:[^;]*\binfinite\b/.test(declarations!)
  )
    continue
  const feedback = stateFeedback.get(selector!.trim())
  if (feedback) {
    assert.ok(declarations!.includes(`animation: ${feedback} `))
    continue
  }
  assert.ok(
    motionLayers.has(selector!.trim()),
    `Unexpected looping animation: ${selector!.trim()}`
  )
  assert.match(declarations!, /animation-play-state:\s*paused\s*;/)
}
const reducedMotion = [
  ...cssWithoutComments.matchAll(
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/g
  ),
]
for (const selector of stateFeedback.keys()) {
  assert.ok(reducedMotion.some(([, body]) => body!.includes(selector) && /animation:\s*none\s*;/.test(body!)), `${selector} respects reduced motion`)
}
for (const layer of motionLayers) {
  assert.ok(
    rules.some(
      ([, selectors, declarations]) =>
        selectors!
          .split(",")
          .map((value) => value.trim())
          .includes(`.ocean-scene[data-water-moving] ${layer}`) &&
        /animation-play-state:\s*running\s*;/.test(declarations!)
    ),
    `${layer} runs only through the scene's motion gate`
  )
  assert.ok(
    rules.some(
      ([, selectors, declarations]) =>
        selectors!.includes(
          `.agent-surface:has(.composer-input:focus) ${layer}`
        ) && /animation-play-state:\s*paused\s*;/.test(declarations!)
    ),
    `${layer} pauses while composing`
  )
  assert.ok(
    reducedMotion.some(
      ([, body]) => body!.includes(layer) && /animation:\s*none\s*;/.test(body!)
    ),
    `${layer} respects reduced motion`
  )
}
const composerSource = readFileSync(
  new URL("../src/components/composer/composer.tsx", import.meta.url),
  "utf8"
)
const liveControlsSource = readFileSync(
  new URL("../src/components/composer/live-controls.tsx", import.meta.url),
  "utf8"
)
const conversationSettingsSource = readFileSync(
  new URL("../src/components/settings/conversation-section.tsx", import.meta.url),
  "utf8"
)
const oceanSource = readFileSync(
  new URL("../src/components/ui/ocean-scene.tsx", import.meta.url),
  "utf8"
)
assert.match(
  oceanSource,
  /motion && visible && !document\.hidden && !media\.matches/
)
assert.match(threadViewerSource, /Loading messages…/)
assert.match(threadViewerSource, /Syncing messages…/)
assert.doesNotMatch(threadViewerSource, /Opening \{opening/)
assert.match(threadViewingSource, /Showing saved messages/)
assert.equal(composerActionKind({ running: false, hasContent: false }), "send")
assert.equal(composerActionKind({ running: false, hasContent: true }), "send")
assert.equal(composerActionKind({ running: true, hasContent: false }), "stop")
assert.equal(composerActionKind({ running: true, hasContent: true }), "queue")
// The word on screen must be the Enter action: steering needs a steerable
// running turn and the preference, and the placeholder names Enter first.
assert.equal(composerEnterAction({ canSteer: true, steerOnEnter: true }), "steer")
assert.equal(composerEnterAction({ canSteer: true, steerOnEnter: false }), "queue")
assert.equal(composerEnterAction({ canSteer: false, steerOnEnter: true }), "queue")
assert.equal(
  composerRunningPlaceholder("Claude", "steer", true),
  "Steer Claude — Cmd+Enter queues instead"
)
assert.equal(
  composerRunningPlaceholder("Claude", "queue", true),
  "Queue a message for Claude — Cmd+Enter steers instead"
)
assert.equal(
  composerRunningPlaceholder("Grok", "queue", false),
  "Queue a message for Grok"
)
// The composer carries no Queue/Steer control at all: the placeholder and the
// button's icon say what Enter does, and the preference is a Settings row.
assert.doesNotMatch(composerSource, /label="What Enter does"/)
assert.doesNotMatch(composerSource, /\{steerOnEnter \? "Queue" : "Steer"\}/)
assert.doesNotMatch(liveControlsSource, /steerOnEnter/)
assert.match(conversationSettingsSource, /togglePref\("steerOnEnter"\)/)
assert.equal(
  composerTurnRunning({
    builtinRunning: false,
    livePresent: true,
    liveRunning: true,
    liveThreadPath: "/live",
    viewingPath: "/live",
    viewingRunning: false,
  }),
  true
)
assert.equal(
  composerTurnRunning({
    builtinRunning: false,
    livePresent: true,
    liveRunning: true,
    liveThreadPath: "/live",
    viewingPath: "/other",
    viewingRunning: false,
  }),
  false
)

assert.deepEqual(
  workspaceFocusOf({
    sessionCwd: "/repo/mako",
    sessionTitle: "Mako",
    viewing: {
      path: "/sessions/arca.jsonl",
      cwd: "/repo/arca",
      title: "Arca audit",
    },
  }),
  {
    cwd: "/repo/arca",
    title: "Arca audit",
    identity: "thread:/sessions/arca.jsonl",
    ready: false,
  }
)
assert.deepEqual(
  workspaceFocusOf({
    sessionCwd: "/repo/arca",
    viewing: { path: "/sessions/arca.jsonl", cwd: "/repo/arca" },
    live: { id: "live-1", cwd: "/repo/arca", title: "Live arca" },
    liveThreadPath: "/sessions/arca.jsonl",
  }),
  {
    cwd: "/repo/arca",
    title: "Live arca",
    identity: "live:live-1",
    ready: true,
  }
)

const duplicateThreadBase: ThreadRef = {
  harness: "codex",
  nativeId: "parent-session",
  path: "/sessions/parent.jsonl",
  cwd: "/repo/arca",
  updatedAt: "2026-08-25T01:00:00.000Z",
}
assert.deepEqual(
  uniqueThreadRefs([
    duplicateThreadBase,
    {
      ...duplicateThreadBase,
      path: "/sessions/subagent.jsonl",
      updatedAt: "2026-08-25T01:01:00.000Z",
    },
  ]).map((ref) => `${ref.harness}:${ref.nativeId}`),
  ["codex:parent-session"]
)

const terminalSession = (
  id: string,
  cwd: string,
  status: TerminalSession["status"]
): TerminalSession => ({
  id,
  cwd,
  status,
  title: id,
  createdAt: 1,
  updatedAt: 1,
  cols: 80,
  rows: 24,
  sequence: 0,
})
const restoredTerminals = [
  terminalSession("dead-current", "/repo/a", "exited"),
  terminalSession("live-other", "/repo/b", "running"),
]
assert.equal(
  runningTerminalForWorkspace(restoredTerminals, "/repo/a"),
  undefined
)
assert.equal(
  runningTerminalForWorkspace(restoredTerminals, "/repo/b")?.id,
  "live-other"
)

for (const id of ["perf-a", "perf-b", "perf-c"]) {
  writeCache(id, {
    messages: [{ id, role: "user", blocks: [{ type: "text", text: id }] }],
  })
}
assert.deepEqual(cacheOf("perf-a").messages, [])
for (const id of ["perf-a", "perf-b", "perf-c"]) dropCache(id)

assert.equal(
  clampCompanionWidth({ width: 520, available: 1400, min: 400 }),
  520
)
assert.equal(clampCompanionWidth({ width: 520, available: 800, min: 400 }), 400)
assert.equal(fitsBeside(851, 400), true)
assert.equal(fitsBeside(850, 400), false)
assert.equal(clampDockHeight({ height: 280, available: 900, min: 180 }), 280)
assert.equal(clampDockHeight({ height: 600, available: 500, min: 180 }), 240)
assert.equal(clampDockHeight({ height: 120, available: 300, min: 180 }), 180)
assert.equal(
  clampDockHeight({ height: 350, available: undefined, min: 180 }),
  350
)

const subagentEnvelope =
  '<subagent sessionID="ses_test" state="completed"> mako </subagent>'
assert.equal(subagentResultId(subagentEnvelope), "ses_test")
assert.equal(subagentResultText(subagentEnvelope), "mako")
assert.equal(
  subagentResultText("<task_result>finished cleanly</task_result>"),
  "finished cleanly"
)
assert.equal(
  subagentResultText("<task_error>failed cleanly</task_error>"),
  "failed cleanly"
)
assert.equal(
  subagentResultText('<subagent sessionID="ses_partial">'),
  "Subagent result was incomplete."
)
assert.equal(
  argAt('{"description":"Read package name"}', "description"),
  "Read package name"
)
assert.equal(
  isSubagentLaunch({ id: "1", name: "TaskUpdate", pending: false }),
  false
)
assert.equal(
  isSubagentLaunch({ id: "2", name: "Subagent", pending: true }),
  true
)
assert.equal(toolLabel("exec_command"), "Shell")
assert.equal(toolLabel("TaskUpdate"), "Update task")
assert.equal(toolLabel("WAIT"), "Wait for command")
assert.equal(
  isSubagentLaunch({
    id: "wait",
    name: "wait",
    arguments: { cell_id: "706" },
    pending: false,
  }),
  false
)
assert.equal(
  normalizeToolOutput(
    JSON.stringify([
      {
        type: "input_text",
        text: "Script completed\nWall time 0.0 seconds\nOutput:\n",
      },
      { type: "input_text", text: "step_name status\nassemble running" },
    ])
  ),
  "Script completed\nWall time 0.0 seconds\nOutput:\n\nstep_name status\nassemble running"
)
assert.equal(
  normalizeToolOutput(
    JSON.stringify({
      chunk_id: "chunk",
      wall_time_seconds: 1,
      session_id: 7,
      output: "final output",
    })
  ),
  "final output"
)
assert.deepEqual(
  parseToolExecutionOutput(
    "Script completed\nWall time 0.0 seconds\nOutput:\nrows: 390"
  ),
  {
    status: "Script completed",
    duration: "0.0 seconds",
    output: "rows: 390",
  }
)
const linkedCitation = linkFileCitations(
  'Final cleaned CSV: :codex-file-citation{path="/work/output.csv" purpose="output"}'
)
const citationHref = /\((mako-citation:[^)]+)\)/.exec(linkedCitation)?.[1]
assert.deepEqual(decodeFileCitation(citationHref), {
  path: "/work/output.csv",
  purpose: "output",
})
assert.deepEqual(markdownFileTarget("/work/src/index.ts#L12-L18"), {
  path: "/work/src/index.ts",
  line: 12,
  endLine: 18,
})
assert.deepEqual(
  summarizeToolWork([
    {
      id: "edit-a",
      name: "edit",
      arguments: { file_path: "src/a.ts" },
      pending: false,
    },
    {
      id: "edit-a-2",
      name: "write",
      arguments: { path: "src/a.ts" },
      pending: false,
    },
    { id: "shell", name: "exec_command", pending: false },
    { id: "read", name: "read", pending: false },
    { id: "search", name: "grep", pending: false },
    { id: "skill", name: "skill", pending: false },
    { id: "agent", name: "run_subagent", pending: false },
    { id: "plan", name: "TodoWrite", pending: false, isError: true },
  ]),
  {
    tools: 8,
    changedFiles: 1,
    commands: 1,
    reads: 1,
    searches: 1,
    skills: 1,
    agents: 1,
    plans: 1,
    other: 0,
    failed: 1,
  }
)

const acpConversation = acpBlocksToMessages(
  [
    { type: "user", text: "Inspect it" },
    { type: "thinking", text: "Checking" },
    {
      type: "tool",
      id: "tool-1",
      title: "Read file",
      toolKind: "read_file",
      status: "completed",
      input: '{"path":"README.md"}',
      output: "Mako",
    },
    { type: "text", text: "Done" },
    {
      type: "plan",
      entries: [{ content: "Inspect", status: "completed" }],
    },
  ],
  true,
  "cursor"
)
assert.deepEqual(
  acpConversation.messages.map((message) => message.role),
  ["user", "assistant"]
)
assert.equal(acpConversation.messages[1]?.provider, "cursor")
assert.equal(
  threadToMessages(
    [{ kind: "assistant", blocks: [{ type: "text", text: "Done" }] }],
    0,
    "devin"
  )[0]?.provider,
  "devin"
)
assert.equal(
  threadToMessages([
    {
      kind: "assistant",
      blocks: [{ type: "tool", name: "shell", canceled: true }],
    },
  ])[0]?.blocks.find((block) => block.type === "toolResult")?.isCanceled,
  true
)
assert.deepEqual(
  acpConversation.messages[1]?.blocks.map((block) => block.type),
  ["thinking", "toolCall", "toolResult", "text", "toolResult"]
)
assert.deepEqual(acpConversation.messages[1]?.blocks.at(-1), {
  type: "toolResult",
  id: "plan-4",
  name: "Plan",
  text: "",
  details: [
    { type: "plan", entries: [{ content: "Inspect", status: "completed" }] },
  ],
})
assert.equal(acpConversation.messages[1]?.streaming, true)
assert.deepEqual(acpConversation.plan, [
  { content: "Inspect", status: "completed" },
])
const canceledTool = acpBlocksToMessages(
  [
    {
      type: "tool",
      id: "tool-canceled",
      title: "Run command",
      toolKind: "exec_command",
      status: "canceled",
    },
  ],
  false
)
assert.equal(
  canceledTool.messages[0]?.blocks.find((block) => block.type === "toolResult")
    ?.isCanceled,
  true
)

const acpEcho = {
  kind: "live",
  key: "acp-echo",
  hydrated: true,
  revision: 0,
  draftKey: "draft-echo",
  harness: "grok",
  cwd: "/repo",
  blocks: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  session: {
    id: "acp-echo",
    connection: "connected",
    harness: "grok",
    cwd: "/repo",
    status: "running",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
  permission: null,
  sending: false,
  canceling: false,
  queued: [],
} satisfies LiveAcpConversation
acpStore.set({
  activeKey: acpEcho.key,
  conversations: { [acpEcho.key]: acpEcho },
})
applyUpdates("acp-echo", [
  { kind: "user", text: "same prompt" },
  { kind: "user", text: "same prompt" },
])
assert.deepEqual(acpStore.get().conversations[acpEcho.key]?.blocks, [
  {
    type: "user",
    text: "same prompt",
    attachments: undefined,
    provider: undefined,
    requestId: undefined,
    contextFiles: undefined,
  },
  {
    type: "user",
    text: "same prompt",
    attachments: undefined,
    provider: undefined,
    requestId: undefined,
    contextFiles: undefined,
  },
])
const backgroundA = {
  ...acpEcho,
  key: "acp-background-a",
  harness: "claude",
  draftKey: "draft-background-a",
  threadPath: "/background-a",
  blocks: [],
  session: {
    ...acpEcho.session,
    id: "acp-background-a",
    harness: "claude",
    status: "running",
  },
} satisfies LiveAcpConversation
const backgroundB = {
  ...acpEcho,
  key: "acp-background-b",
  harness: "codex",
  draftKey: "draft-background-b",
  threadPath: "/background-b",
  blocks: [],
  session: {
    ...acpEcho.session,
    id: "acp-background-b",
    harness: "codex",
    status: "running",
  },
} satisfies LiveAcpConversation
threadsStore.set({ working: {}, attention: {} })
acpStore.set({
  activeKey: backgroundB.key,
  conversations: {
    [backgroundA.key]: backgroundA,
    [backgroundB.key]: backgroundB,
  },
})
const stableBackgroundB = acpStore.get().conversations[backgroundB.key]
const presenceBeforeToken = selectAcpPresence(acpStore.get())
applyUpdates(backgroundA.key, [{ kind: "text", text: "Background token" }])
assert.deepEqual(acpStore.get().conversations[backgroundA.key]?.blocks, [
  { type: "text", text: "Background token", id: undefined },
])
assert.equal(
  sameAcpPresence(presenceBeforeToken, selectAcpPresence(acpStore.get())),
  true,
  "token updates must not repaint the rail"
)
assert.equal(
  acpStore.get().conversations[backgroundB.key],
  stableBackgroundB,
  "a background token must not replace the active conversation object"
)
applyPermission({
  id: "permission-a",
  sessionId: backgroundA.key,
  title: "Run tests",
  options: [{ optionId: "allow", name: "Allow" }],
})
assert.equal(
  acpStore.get().conversations[backgroundA.key]?.kind === "live"
    ? acpStore.get().conversations[backgroundA.key]?.permission?.id
    : undefined,
  "permission-a"
)
assert.equal(
  threadsStore.get().attention["/background-a"]?.kind,
  "needs-permission"
)
assert.equal(acpStore.get().activeKey, backgroundB.key)
assert.equal(acp.activateThread({ path: "/background-a" }), true)
assert.equal(acpStore.get().activeKey, backgroundA.key)
assert.equal(
  threadsStore.get().attention["/background-a"]?.kind,
  "needs-permission"
)
acpStore.set({ activeKey: backgroundB.key })
const queuedA = acpStore.get().conversations[backgroundA.key]
if (!queuedA || queuedA.kind !== "live") throw new Error("missing background A")
acpStore.set({
  conversations: {
    ...acpStore.get().conversations,
    [backgroundA.key]: {
      ...queuedA,
      permission: null,
      queued: [{ text: "Keep me", attachments: [] }],
    },
  },
})
applySession({ ...backgroundA.session, status: "ready" })
await Promise.resolve()
await Promise.resolve()
const restoredA = acpStore.get().conversations[backgroundA.key]
assert.equal(
  restoredA?.kind === "live" ? restoredA.queued[0]?.text : undefined,
  "Keep me",
  "a failed background queue drain must restore the prompt"
)
if (restoredA?.kind === "live") {
  acpStore.set({
    conversations: {
      ...acpStore.get().conversations,
      [backgroundA.key]: {
        ...restoredA,
        session: { ...restoredA.session, status: "running" },
        queued: [],
      },
    },
  })
}
applySession({ ...backgroundA.session, status: "ready" })
assert.equal(threadsStore.get().attention["/background-a"]?.kind, "review")
assert.equal(acpStore.get().activeKey, backgroundB.key)
acpStore.set({
  activeKey: null,
  conversations: {},
})
threadsStore.set({ working: {}, attention: {} })
const interleavedResponse = [
  {
    id: "work-before",
    role: "assistant",
    blocks: [{ type: "toolCall", id: "one", name: "read" }],
  },
  {
    id: "commentary",
    role: "assistant",
    blocks: [
      { type: "toolCall", id: "two", name: "exec" },
      { type: "text", text: "The catalog is healthy." },
    ],
  },
  {
    id: "work-after",
    role: "assistant",
    blocks: [{ type: "toolCall", id: "three", name: "read" }],
  },
] satisfies ChatMessage[]
const interleavedSections = responseSections(interleavedResponse)
assert.deepEqual(
  interleavedSections.map((section) => section.kind),
  ["work", "prose", "work"]
)
assert.equal(
  interleavedSections[0]?.kind === "work"
    ? interleavedSections[0].messages.length
    : 0,
  2
)
assert.equal(
  interleavedSections[1]?.kind === "prose"
    ? interleavedSections[1].message.blocks[0]?.text
    : undefined,
  "The catalog is healthy."
)
assert.equal(
  interleavedSections[2]?.kind === "work"
    ? interleavedSections[2].messages.length
    : 0,
  1
)
const waitingEntries: ThreadEntry[] = [
  {
    kind: "assistant",
    blocks: [
      {
        type: "tool",
        name: "ask_user_question",
        input: '{"question":"Continue?"}',
      },
    ],
  },
]
assert.equal(pendingThreadInput(waitingEntries), "ask_user_question")
assert.equal(
  pendingThreadInput([
    {
      kind: "assistant",
      blocks: [
        {
          type: "tool",
          name: "ask_user_question",
          input: '{"question":"Continue?"}',
          output: "Continue",
        },
      ],
    },
  ]),
  null
)

const folderRefs = [
  {
    harness: "opencode",
    nativeId: "one",
    path: "/one",
    cwd: "/repo/packages/app",
    workspace: "/repo",
    updatedAt: "2026-01-02T00:00:00.000Z",
  },
  {
    harness: "codex",
    nativeId: "two",
    path: "/two",
    cwd: "/repo",
    workspace: "/repo",
    updatedAt: "2026-01-03T00:00:00.000Z",
  },
] satisfies ThreadRef[]
assert.equal(threadFolderKey(folderRefs[0]), "/repo")
assert.equal(
  threadFolderKey({
    harness: "claude",
    nativeId: "temp",
    path: "/temp",
    cwd: "/private/tmp/session",
  }),
  ""
)
const homeRef = {
  harness: "claude",
  nativeId: "home",
  path: "/home",
  cwd: "/Users/kashyab",
} satisfies ThreadRef
assert.equal(threadFolderKey(homeRef), "/Users/kashyab")
assert.equal(
  threadBelongsToWorkspace(
    { ...homeRef, cwd: "/Users/kashyab/repos/nu/arca" },
    "/Users/kashyab"
  ),
  true
)
assert.equal(
  threadBelongsToWorkspace(
    { ...homeRef, cwd: "/Users/kashyab-other/repo" },
    "/Users/kashyab"
  ),
  false
)
assert.deepEqual(
  groupThreadFolders({
    refs: [],
    currentCwd: "/Users/kashyab",
    pinnedThreads: [],
    pinnedFolders: [],
    sortBy: "recent",
  }).map((folder) => ({
    cwd: folder.cwd,
    name: folder.name,
    count: folder.refs.length,
    current: folder.current,
  })),
  [{ cwd: "/Users/kashyab", name: "Home", count: 0, current: true }]
)
assert.deepEqual(
  groupThreadFolders({
    refs: folderRefs,
    currentCwd: "/repo/packages/app",
    pinnedThreads: [],
    pinnedFolders: [],
    sortBy: "recent",
  }).map((folder) => ({ cwd: folder.cwd, count: folder.refs.length })),
  [{ cwd: "/repo", count: 2 }]
)
assert.deepEqual(
  groupThreadFolders({
    refs: [folderRefs[1]!],
    currentCwd: "/repo/packages/unknown",
    pinnedThreads: [],
    pinnedFolders: ["/repo/"],
    sortBy: "recent",
  }).map((folder) => ({
    cwd: folder.cwd,
    current: folder.current,
    pinned: folder.pinned,
  })),
  [{ cwd: "/repo", current: true, pinned: true }]
)
assert.deepEqual(
  groupThreadFolders({
    refs: folderRefs,
    currentCwd: "/repo",
    pinnedThreads: [],
    pinnedFolders: [],
    priorities: { "/one": 5 },
    sortBy: "recent",
  })[0]?.refs.map((ref) => ref.path),
  ["/two", "/one"],
  "urgency changes a row's mark, never its place"
)
const activeFolders = groupThreadFolders({
  refs: [
    {
      ...folderRefs[0]!,
      path: "/quiet",
      cwd: "/quiet",
      workspace: "/quiet",
      updatedAt: "2026-08-30T12:00:00Z",
    },
    {
      ...folderRefs[1]!,
      path: "/live",
      cwd: "/live",
      workspace: "/live",
      updatedAt: "2026-08-29T12:00:00Z",
    },
  ],
  pinnedThreads: [],
  pinnedFolders: [],
  priorities: { "/live": 2 },
  activity: { "/live": { running: true } },
  sortBy: "recent",
})
assert.deepEqual(
  activeFolders.map((folder) => folder.cwd),
  ["/quiet", "/live"],
  "a working thread does not lift its folder"
)
const liveFolder = activeFolders.find((folder) => folder.cwd === "/live")
assert.equal(liveFolder?.running, 1)
assert.equal(liveFolder?.priority, 2)
assert.deepEqual(
  visibleThreadFolders(activeFolders, 1).map((folder) => folder.cwd),
  ["/quiet", "/live"],
  "a busy folder past the page limit stays visible in its own place"
)
const stableFolders = groupThreadFolders({
  refs: Array.from({ length: 8 }, (_, index) => ({
    harness: "codex" as const,
    nativeId: `stable-${index}`,
    path: `/stable-${index}`,
    cwd: `/project-${index}`,
    updatedAt: `2026-09-${String(9 - index).padStart(2, "0")}T12:00:00Z`,
  })),
  currentCwd: "/project-3",
  pinnedThreads: [],
  pinnedFolders: [],
  sortBy: "recent",
})
assert.deepEqual(
  stableFolders.map((folder) => folder.cwd),
  Array.from({ length: 8 }, (_, index) => `/project-${index}`),
  "Selecting a visible project must not move its row"
)
assert.deepEqual(
  visibleThreadFolders(stableFolders, 6).map((folder) => folder.cwd),
  Array.from({ length: 6 }, (_, index) => `/project-${index}`)
)
const offPageCurrent = stableFolders.map((folder) => ({
  ...folder,
  current: folder.cwd === "/project-7",
}))
assert.deepEqual(
  visibleThreadFolders(offPageCurrent, 6).map((folder) => folder.cwd),
  [
    ...Array.from({ length: 6 }, (_, index) => `/project-${index}`),
    "/project-7",
  ],
  "An off-page current project must remain visible without displacing rows"
)

// Recency holds still while agents work: a busy thread keeps its rank on
// every appended byte, climbs once when it starts, and settles once when it
// finishes. Two busy projects therefore never swap on each other's tokens.
const busyRef = (path: string, cwd: string, updatedAt: string): ThreadRef => ({
  harness: "codex",
  nativeId: path,
  path,
  cwd,
  workspace: cwd,
  updatedAt,
})
const firstSeen = stableThreadRanks(
  [busyRef("/a", "/one", "2026-09-11T10:00:00Z"), busyRef("/b", "/two", "2026-09-11T10:01:00Z")],
  { "/a": { running: true }, "/b": { running: true } },
  {}
)
assert.deepEqual(firstSeen, {
  "/a": { at: "2026-09-11T10:00:00Z", active: true },
  "/b": { at: "2026-09-11T10:01:00Z", active: true },
})
const stillBusy = stableThreadRanks(
  [busyRef("/a", "/one", "2026-09-11T10:05:00Z"), busyRef("/b", "/two", "2026-09-11T10:01:00Z")],
  { "/a": { running: true }, "/b": { running: true } },
  firstSeen
)
assert.equal(stillBusy["/a"]?.at, "2026-09-11T10:00:00Z", "a working thread keeps its rank while its file grows")
const ordered = (ranks: RailRanks, refs: ThreadRef[]) =>
  groupThreadFolders({ refs, pinnedThreads: [], pinnedFolders: [], priorities: { "/a": 2, "/b": 2 }, activity: { "/a": { running: true }, "/b": { running: true } }, ranks, sortBy: "recent" }).map((folder) => folder.cwd)
assert.deepEqual(ordered(stillBusy, [busyRef("/a", "/one", "2026-09-11T10:05:00Z"), busyRef("/b", "/two", "2026-09-11T10:01:00Z")]), ["/two", "/one"], "the newer file does not move its project above the other busy project")
const woke = stableThreadRanks(
  [busyRef("/a", "/one", "2026-09-11T10:00:00Z"), busyRef("/b", "/two", "2026-09-11T10:06:00Z")],
  { "/a": { running: true }, "/b": { running: true } },
  { "/a": { at: "2026-09-11T10:00:00Z", active: true }, "/b": { at: "2026-09-11T10:01:00Z", active: false } }
)
assert.equal(woke["/b"]?.at, "2026-09-11T10:06:00Z", "a thread that starts working climbs once")
const settled = stableThreadRanks(
  [busyRef("/a", "/one", "2026-09-11T10:09:00Z")],
  { "/a": { running: false } },
  { "/a": { at: "2026-09-11T10:00:00Z", active: true } }
)
assert.deepEqual(settled["/a"], { at: "2026-09-11T10:09:00Z", active: false }, "a finished thread settles at its real time")
const observedHolds = stableThreadRanks(
  [busyRef("/a", "/one", "2026-09-11T10:12:00Z")],
  { "/a": { observed: true } },
  { "/a": { at: "2026-09-11T10:09:00Z", active: true } }
)
assert.equal(observedHolds["/a"]?.at, "2026-09-11T10:09:00Z", "a thread another app keeps writing holds its rank too")
const idleFollows = stableThreadRanks(
  [busyRef("/a", "/one", "2026-09-11T10:20:00Z")],
  {},
  { "/a": { at: "2026-09-11T10:09:00Z", active: false } }
)
assert.equal(idleFollows["/a"]?.at, "2026-09-11T10:20:00Z", "an idle thread still follows outside activity")

// Folders hold their place from first sight. An agent's reply does not lift
// one; your own prompt there does; a pinned folder stays above both.
const heldRefs = [busyRef("/a", "/one", "2026-09-11T10:00:00Z"), busyRef("/b", "/two", "2026-09-11T09:00:00Z")]
const heldFolders = groupThreadFolders({ refs: heldRefs, pinnedThreads: [], pinnedFolders: [], sortBy: "recent" })
const firstFolderRanks = stableFolderRanks(heldFolders, {}, {})
assert.deepEqual(firstFolderRanks, { "/one": "2026-09-11T10:00:00Z", "/two": "2026-09-11T09:00:00Z" })
const grownFolders = groupThreadFolders({
  refs: [busyRef("/a", "/one", "2026-09-11T10:00:00Z"), busyRef("/b", "/two", "2026-09-11T11:00:00Z")],
  pinnedThreads: [],
  pinnedFolders: [],
  sortBy: "recent",
})
assert.deepEqual(grownFolders.map((folder) => folder.cwd), ["/two", "/one"], "unheld, the newer reply would lead")
const heldFolderRanks = stableFolderRanks(grownFolders, {}, firstFolderRanks)
assert.equal(heldFolderRanks["/two"], "2026-09-11T09:00:00Z", "an agent's reply does not lift its folder")
assert.deepEqual(orderThreadFolders(grownFolders, heldFolderRanks, "recent").map((folder) => folder.cwd), ["/one", "/two"], "the folder order is the held order")
const usedFolderRanks = stableFolderRanks(grownFolders, { "/two": "2026-09-11T12:00:00Z" }, heldFolderRanks)
assert.equal(usedFolderRanks["/two"], "2026-09-11T12:00:00Z", "your own prompt lifts the folder")
assert.deepEqual(orderThreadFolders(grownFolders, usedFolderRanks, "recent").map((folder) => folder.cwd), ["/two", "/one"])
assert.deepEqual(orderThreadFolders(grownFolders, usedFolderRanks, "name").map((folder) => folder.cwd), ["/one", "/two"], "by-name order ignores held ranks")
const pinnedHeld = groupThreadFolders({ refs: heldRefs, pinnedThreads: [], pinnedFolders: ["/two"], sortBy: "recent" })
assert.deepEqual(
  orderThreadFolders(pinnedHeld, stableFolderRanks(pinnedHeld, { "/one": "2026-09-12T00:00:00Z" }, {}), "recent").map((folder) => folder.cwd),
  ["/two", "/one"],
  "a pinned folder stays above a folder you just used"
)
const newFolderRanks = stableFolderRanks(
  groupThreadFolders({ refs: [...heldRefs, busyRef("/c", "/three", "2026-09-11T10:30:00Z")], pinnedThreads: [], pinnedFolders: [], sortBy: "recent" }),
  {},
  usedFolderRanks
)
assert.equal(newFolderRanks["/three"], "2026-09-11T10:30:00Z", "a folder first seen enters at its own time")

// The status board: fixed sections, newest change first, empty ones absent.
const board = groupThreadBoard([
  { key: "d1", bucket: "done", at: "2026-09-11T10:00:00Z", item: 1 },
  { key: "w1", bucket: "working", at: "2026-09-11T10:05:00Z", item: 2 },
  { key: "n1", bucket: "needs-input", at: "2026-09-11T10:01:00Z", item: 3 },
  { key: "n2", bucket: "needs-input", at: "2026-09-11T10:02:00Z", item: 4 },
  { key: "r1", bucket: "review", at: "2026-09-11T10:03:00Z", item: 5 },
])
assert.deepEqual(
  board.map((section) => [section.key, section.rows.map((row) => row.key)]),
  [["needs-input", ["n2", "n1"]], ["review", ["r1"]], ["working", ["w1"]], ["done", ["d1"]]]
)
assert.deepEqual(boardBucketOf({ kind: "needs-permission", since: Date.parse("2026-09-11T10:01:00Z") }), { bucket: "needs-input", at: "2026-09-11T10:01:00.000Z" })
assert.deepEqual(boardBucketOf({ kind: "review", at: 1, unread: false }), { bucket: "done" })
assert.deepEqual(boardBucketOf({ kind: "external-active" }), { bucket: "working" })
assert.deepEqual(boardBucketOf({ kind: "observed" }), { bucket: "done" })
assert.equal(liveBoardBucket("needs-permission"), "needs-input")
assert.equal(liveBoardBucket("starting"), "working")
assert.ok(
  threadStatusPriority({ kind: "needs-permission", since: 1 }) >
    threadStatusPriority({ kind: "working", since: 1 })
)

const statusState = threadsStore.get()
const openCodeRef = {
  harness: "opencode" as const,
  nativeId: "session",
  path: "/session",
}
assert.deepEqual(threadStatus({ ...openCodeRef, active: true }, statusState), {
  kind: "external-active",
})
assert.deepEqual(
  threadStatus(
    { ...openCodeRef, active: false },
    { ...statusState, observed: { "/session": true } }
  ),
  { kind: "idle" }
)
const liveCodexRefs = [
  {
    harness: "codex",
    nativeId: "codex-one",
    path: "/codex-one",
    cwd: "/other-project",
    updatedAt: "2026-08-30T13:05:00Z",
  },
  {
    harness: "codex",
    nativeId: "codex-two",
    path: "/codex-two",
    cwd: "/other-project",
    updatedAt: "2026-08-30T13:05:01Z",
  },
] satisfies ThreadRef[]
const activityNow = Date.parse("2026-08-30T13:05:30Z")
assert.equal(
  recentThreadActivityDuration(liveCodexRefs[0]!, activityNow),
  30_000
)
assert.equal(
  recentThreadActivityDuration(
    { ...liveCodexRefs[0]!, active: false },
    activityNow
  ),
  null
)
assert.deepEqual(
  activeThreadRefs(liveCodexRefs, {
    ...statusState,
    observed: { "/codex-one": true, "/codex-two": true },
  }).map((ref) => ref.nativeId),
  []
)
threadsStore.set({
  threads: liveCodexRefs,
  externalActivity: {},
  observed: {},
  working: {},
  attention: {},
})
applyThreadActivity("/codex-one", {
  provider: "codex",
  since: 10,
  status: "needs-input",
  detail: "permission prompt",
})
assert.deepEqual(
  threadsStore.get().threads.map((ref) => ref.nativeId),
  ["codex-one", "codex-two"]
)
assert.deepEqual(threadStatus(liveCodexRefs[0]!, threadsStore.get()), {
  kind: "needs-permission",
  since: 10,
  detail: "permission prompt",
})
applyThreadActivity("/codex-one", null)

const backgroundRef = {
  harness: "grok",
  nativeId: "background",
  path: "/background",
} satisfies ThreadRef
threadsStore.set({
  viewing: { ref: openCodeRef, entries: [] },
  attention: {},
  working: {},
})
applyThreadRun({
  path: backgroundRef.path,
  harness: backgroundRef.harness,
  status: "running",
})
applyThreadRun({
  path: backgroundRef.path,
  harness: backgroundRef.harness,
  status: "done",
})
const backgroundAttention = threadsStore.get().attention[backgroundRef.path]
assert.equal(backgroundAttention?.kind, "review")
assert.equal(
  backgroundAttention?.kind === "review" && backgroundAttention.unread,
  true
)
markThreadReviewed(backgroundRef.path)
assert.equal(threadsStore.get().attention[backgroundRef.path], undefined)
threadsStore.set({
  viewing: { ref: backgroundRef, entries: [] },
  attention: {},
})
applyThreadRun({
  path: backgroundRef.path,
  harness: backgroundRef.harness,
  status: "done",
})
assert.equal(threadsStore.get().attention[backgroundRef.path], undefined)

const queuedRef = {
  harness: "codex",
  nativeId: "queued",
  path: "/queued",
} satisfies ThreadRef
threadsStore.set({ viewing: { ref: queuedRef, entries: [] } })
assert.equal(appendOptimisticReply(queuedRef, "move now"), true)
assert.equal(threadsStore.get().viewing?.entries.length, 1)
removeOptimisticReply(queuedRef, "move now")
assert.equal(threadsStore.get().viewing?.entries.length, 0)

console.log(
  "stage layout, tool mapping, subagent formatting, and explicit activity passed"
)

const aliases = [
  { path: "/source" },
  { path: "/destination" },
  { path: "/unrelated" },
]
const canonicalPresence = [
  {
    ...presenceBeforeToken[0]!,
    threadPath: "/destination",
    nativePaths: ["/source", "/destination"],
  },
]
assert.deepEqual(canonicalThreadRefs(aliases, canonicalPresence, []), [
  aliases[1],
  aliases[2],
])
assert.deepEqual(
  canonicalThreadRefs(aliases, canonicalPresence, ["/source"]),
  [aliases[0], aliases[2]],
  "a pinned native alias remains the canonical row"
)
assert.equal(
  sameAcpPresence(
    canonicalPresence,
    canonicalPresence.map((presence) => ({
      ...presence,
      nativePaths: [...presence.nativePaths],
    }))
  ),
  true
)

// Every registered provider must obey the same renderer lifecycle rules.
for (const { provider: harness } of providerHost.liveDrivers.list()) {
  const path = `/activity/${harness}`
  const ref: ThreadRef = { harness, nativeId: harness, path }
  threadsStore.set({
    working: {},
    attention: {},
    externalActivity: {},
    observed: { [path]: true },
  })
  assert.deepEqual(
    activeThreadRefs([{ ...ref, locked: true }]),
    [],
    `${harness}: open + recently changed does not mean running`
  )
  const conversation: LiveAcpConversation = {
    ...acpEcho,
    key: harness,
    harness,
    threadPath: path,
    session: { ...acpEcho.session, id: harness, harness, status: "running" },
  }
  syncThreadStatus(conversation, "ready")
  assert.equal(
    activeThreadRefs([ref]).length,
    1,
    `${harness}: real turn start is running`
  )
  syncThreadStatus(
    { ...conversation, session: { ...conversation.session, status: "ready" } },
    "running"
  )
  assert.equal(
    activeThreadRefs([ref]).length,
    0,
    `${harness}: turn completion clears running`
  )
  threadsStore.set({
    attention: { [path]: { kind: "needs-permission", since: 1 } },
  })
  syncThreadStatus(
    { ...conversation, session: { ...conversation.session, status: "closed" } },
    "running"
  )
  assert.equal(
    activeThreadRefs([ref]).length,
    0,
    `${harness}: closure clears stale permission state`
  )
  threadsStore.set({
    attention: { [path]: { kind: "review", at: 1, unread: true } },
    externalActivity: {
      [path]: { provider: harness, status: "active", since: 2 },
    },
  })
  assert.equal(
    threadStatus(ref).kind,
    "external-active",
    `${harness}: a new external run supersedes an old completion badge`
  )
  threadsStore.set({
    externalActivity: {},
    working: {},
    attention: {},
    observed: {},
  })
}
console.log(
  "Every registered harness: open/recent, running, completed, closed while waiting, and restarted externally verified"
)

// A failure is an outcome you acknowledge by opening the thread, not a state
// the row wears for as long as the session exists. Before this, a live
// session that failed (a host restart mid-turn, a provider error) painted
// its row and its folder's "1 failed" chip red until the next prompt,
// whatever you clicked.
{
  const failedRef: ThreadRef = {
    harness: "cursor",
    nativeId: "failed-live",
    path: "/rail/failed-live",
    cwd: "/repo",
    updatedAt: "2026-09-13T00:00:00.000Z",
  }
  const workingRef: ThreadRef = {
    harness: "cursor",
    nativeId: "working-live",
    path: "/rail/working-live",
    cwd: "/repo",
    updatedAt: "2026-09-13T00:01:00.000Z",
  }
  const failing: LiveAcpConversation = {
    ...acpEcho,
    key: "failed-live",
    harness: "cursor",
    threadPath: failedRef.path,
    session: {
      ...acpEcho.session,
      id: "failed-live",
      harness: "cursor",
      nativeId: "failed-live",
      status: "running",
    },
  }
  const elsewhere: LiveAcpConversation = {
    ...acpEcho,
    key: "working-live",
    harness: "cursor",
    threadPath: workingRef.path,
    session: {
      ...acpEcho.session,
      id: "working-live",
      harness: "cursor",
      nativeId: "working-live",
      status: "running",
    },
  }
  threadsStore.set({
    threads: [failedRef, workingRef],
    viewing: null,
    working: {},
    attention: {},
    externalActivity: {},
    observed: {},
  })
  acpStore.set({
    activeKey: elsewhere.key,
    conversations: { [failing.key]: failing, [elsewhere.key]: elsewhere },
  })
  syncThreadStatus(failing, "ready")
  syncThreadStatus(elsewhere, "ready")
  const folderCounts = () => {
    const activity = Object.fromEntries(
      [failedRef, workingRef].map((ref) => {
        const status = threadStatus(ref)
        return [
          ref.path,
          {
            running: status.kind === "working",
            failed: status.kind === "failed",
            unread: status.kind === "review" && status.unread,
          },
        ]
      })
    )
    const [folder] = groupThreadFolders({
      refs: [failedRef, workingRef],
      pinnedThreads: [],
      pinnedFolders: [],
      activity,
      sortBy: "recent",
    })
    return { running: folder!.running, failed: folder!.failed }
  }

  applySession({
    ...failing.session,
    status: "failed",
    error: "The host restarted before completion was confirmed.",
  })
  assert.equal(
    threadStatus(failedRef).kind,
    "failed",
    "a failure on a thread you are not looking at marks the row"
  )
  assert.deepEqual(
    folderCounts(),
    { running: 1, failed: 1 },
    "the folder chip counts the unseen failure"
  )

  // A later batch on the still-failed session is not a second failure.
  applyLiveBatch({
    id: failing.key,
    revision: (acpStore.get().conversations[failing.key]?.revision ?? 0) + 1,
    updates: [],
    requests: [],
  })
  assert.equal(threadStatus(failedRef).kind, "failed")

  acp.activate(failing.key)
  assert.equal(
    threadStatus(failedRef).kind,
    "idle",
    "opening the failed thread acknowledges it; the row shows its time again"
  )
  assert.deepEqual(
    folderCounts(),
    { running: 1, failed: 0 },
    "the folder chip reports the working thread once the failure is seen"
  )
  acp.activate(elsewhere.key)
  applyLiveBatch({
    id: failing.key,
    revision: (acpStore.get().conversations[failing.key]?.revision ?? 0) + 1,
    updates: [],
    requests: [],
  })
  assert.equal(
    threadStatus(failedRef).kind,
    "idle",
    "a batch on a session that stays failed does not re-arm a seen failure"
  )

  // The next prompt starts a new turn; a second failure is news again.
  applySession({ ...failing.session, status: "running" })
  assert.equal(threadStatus(failedRef).kind, "working")
  applySession({ ...failing.session, status: "failed", error: "Provider exited" })
  const second = threadStatus(failedRef)
  assert.equal(second.kind, "failed")
  assert.equal(
    second.kind === "failed" && second.detail,
    "Provider exited",
    "a new failure after a seen one is news again, with its own reason"
  )

  // A failure you watched happen is already seen.
  acp.activate(failing.key)
  applySession({ ...failing.session, status: "running" })
  applySession({ ...failing.session, status: "failed", error: "Watched" })
  assert.equal(
    threadStatus(failedRef).kind,
    "idle",
    "the conversation on screen does not mark its own failure"
  )

  // A session that failed before it had a store has only its presence row.
  const unbound: LiveAcpConversation = {
    ...acpEcho,
    key: "unbound-failed",
    harness: "devin",
    threadPath: undefined,
    session: {
      ...acpEcho.session,
      id: "unbound-failed",
      harness: "devin",
      status: "failed",
      error: "Sign-in required",
    },
  }
  acpStore.set({
    activeKey: elsewhere.key,
    conversations: { [unbound.key]: unbound, [elsewhere.key]: elsewhere },
  })
  const presenceOf = (key: string) =>
    selectAcpPresence(acpStore.get()).find((presence) => presence.key === key)
  assert.equal(presenceOf(unbound.key)?.status, "failed")
  acp.activate(unbound.key)
  assert.equal(
    presenceOf(unbound.key)?.status,
    "ready",
    "opening an unbound failed conversation stands its row down"
  )
  acp.activate(elsewhere.key)
  applySession({ ...unbound.session, status: "running" })
  applySession({ ...unbound.session, status: "failed", error: "Again" })
  assert.equal(
    presenceOf(unbound.key)?.status,
    "failed",
    "a new failure after a seen one is new"
  )

  // Native runs follow the same rule.
  const nativeRef: ThreadRef = {
    harness: "codex",
    nativeId: "native-failed",
    path: "/rail/native-failed",
  }
  acpStore.set({ activeKey: null, conversations: {} })
  threadsStore.set({
    viewing: { ref: workingRef, entries: [] },
    attention: {},
    working: {},
  })
  applyThreadRun({ path: nativeRef.path, harness: "codex", status: "running" })
  applyThreadRun({
    path: nativeRef.path,
    harness: "codex",
    status: "failed",
    error: "exit 1",
  })
  assert.equal(threadStatus(nativeRef).kind, "failed")
  markThreadReviewed(nativeRef.path)
  assert.equal(
    threadStatus(nativeRef).kind,
    "idle",
    "opening a natively failed thread acknowledges the failure"
  )
  threadsStore.set({ viewing: { ref: nativeRef, entries: [] } })
  applyThreadRun({ path: nativeRef.path, harness: "codex", status: "running" })
  applyThreadRun({
    path: nativeRef.path,
    harness: "codex",
    status: "failed",
    error: "exit 1",
  })
  assert.equal(
    threadStatus(nativeRef).kind,
    "idle",
    "a native failure on the viewed thread is already seen"
  )
  assert.equal(
    threadsStore.get().run?.status,
    "failed",
    "the viewer still knows the run failed"
  )
  threadsStore.set({
    viewing: null,
    run: null,
    attention: {},
    working: {},
    threads: [],
  })
  acpStore.set({ activeKey: null, conversations: {} })
}

// An unread answer survives the batches a finished session keeps sending,
// and a turn that ended while the renderer was away is still read as one.
{
  const ref: ThreadRef = {
    harness: "cursor",
    nativeId: "quiet-finish",
    path: "/rail/quiet-finish",
    cwd: "/repo",
  }
  const running: LiveAcpConversation = {
    ...acpEcho,
    key: "quiet-finish",
    harness: "cursor",
    threadPath: ref.path,
    session: {
      ...acpEcho.session,
      id: "quiet-finish",
      harness: "cursor",
      nativeId: "quiet-finish",
      status: "running",
    },
  }
  threadsStore.set({
    threads: [ref],
    viewing: null,
    working: {},
    attention: {},
    externalActivity: {},
    observed: {},
  })
  acpStore.set({ activeKey: null, conversations: { [running.key]: running } })
  syncThreadStatus(running, "ready")
  applySession({ ...running.session, status: "ready", lastStop: "end_turn" })
  assert.equal(threadStatus(ref).kind, "review", "the finished turn marks the row")
  // The agent reports its mode after the turn; the request settles; a
  // setting is acknowledged. None of these is the user reading the answer.
  applySession({ ...running.session, status: "ready", lastStop: "end_turn", currentMode: "agent" })
  applyLiveBatch({
    id: running.key,
    revision: (acpStore.get().conversations[running.key]?.revision ?? 0) + 1,
    updates: [],
    requests: [],
  })
  assert.equal(
    threadStatus(ref).kind,
    "review",
    "later batches on the finished session leave the unread mark alone"
  )
  markThreadReviewed(ref.path)
  assert.equal(threadStatus(ref).kind, "idle", "opening the thread clears it")

  // Away while it finished: the reconnect summary is the only word.
  applySession({ ...running.session, status: "running", lastStop: undefined })
  assert.equal(threadStatus(ref).kind, "working")
  hydrateLiveSummaries(
    [
      {
        session: { ...running.session, status: "ready", lastStop: "end_turn" },
        revision: (acpStore.get().conversations[running.key]?.revision ?? 0) + 5,
        createdAt: 1,
        threadPath: ref.path,
      },
    ],
    true
  )
  assert.equal(
    threadStatus(ref).kind,
    "review",
    "a turn that ended while the renderer was disconnected still marks its row"
  )
  const { items } = notificationsStore.get()
  const replay = items.find((item) => item.subject.target.kind === "thread" && item.subject.target.path === ref.path && item.kind === "ready")
  assert.ok(replay, "the reconnect replay reaches the badge")

  // Putting the thread away is a dismissal: the row's mark stands down and
  // the pill stops counting it, without the thread ever being opened.
  const unseenFor = (path: string) =>
    notificationsStore
      .get()
      .items.filter(
        (item) =>
          !item.seen &&
          ((item.subject.target.kind === "thread" && item.subject.target.path === path) ||
            (item.subject.target.kind === "live" && item.subject.target.key === running.key))
      ).length
  assert.ok(unseenFor(ref.path) > 0, "the unread answer counts before it is archived")
  acknowledgeThread({ kind: "live", id: running.key })
  assert.equal(threadStatus(ref).kind, "idle", "archiving clears the row's unread mark")
  assert.equal(unseenFor(ref.path), 0, "archiving clears the thread from the pill")

  // A failed thread archived by its file identity settles the same way.
  applySession({ ...running.session, status: "running", lastStop: undefined })
  applySession({ ...running.session, status: "failed", error: "exit 1" })
  assert.equal(threadStatus(ref).kind, "failed")
  assert.ok(unseenFor(ref.path) > 0, "the failure counts before it is archived")
  acknowledgeThread({ kind: "file", path: ref.path })
  assert.equal(threadStatus(ref).kind, "idle", "archiving a failed thread acknowledges the failure")
  assert.equal(unseenFor(ref.path), 0, "the archived failure leaves the pill")
  const dismissed = acpStore.get().conversations[running.key]
  assert.equal(
    dismissed?.kind === "live" && dismissed.failureSeen,
    true,
    "the live conversation remembers its failure was dismissed"
  )
  threadsStore.set({ threads: [], attention: {}, working: {} })
  acpStore.set({ activeKey: null, conversations: {} })
}

// The unread mark is one class, styled once, and animates only when fresh.
assert.match(css, /\.review-dot\s*\{/)
assert.match(css, /\.review-dot\[data-new\]\s*\{\s*animation:/)
assert.doesNotMatch(
  css,
  /\.review-dot\s*\{[^}]*box-shadow:[^;]*\d+px\s+\d+px\s+[1-9]/,
  "the mark's ring is spread only, never a blurred shadow"
)
console.log("Failed threads acknowledge on open; the unread mark is styled once")
