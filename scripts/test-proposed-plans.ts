import {
  renderTranscriptBundle,
  emitClaudeSession,
  emitCodexSession,
  ClaudeProvider,
  CodexProvider,
} from "@mako/sessions"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  ProposedPlanSchema,
  MAX_PROPOSED_PLAN_LENGTH,
} from "@mako/sessions/content"
import { ThreadEntrySchema } from "@mako/sessions/thread-schema"
import {
  LiveBlockSchema,
  reduceLiveUpdates,
} from "../electron/contracts/live-content.ts"
import { LiveJournal } from "../electron/live-journal.ts"
import { liveEntries } from "../electron/live-context.ts"
import { WorkspaceFiles } from "../electron/host-workspace.ts"
import { WorkspaceGit } from "../electron/host-git.ts"
import { claudeProposedPlan } from "../electron/providers/claude/sdk-plan.ts"
import { ClaudePermissions } from "../electron/providers/claude/sdk-permissions.ts"
import { threadToMessages } from "../src/lib/foreign-thread.ts"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.ts"
import { reconcileMessages } from "../src/lib/reconcile.ts"
import { responseText, toExchanges } from "../src/lib/exchanges.ts"
import {
  proposedPlanMarkdown,
  proposedPlanReply,
  appendPlanContext,
  parsePlanContext,
} from "../src/lib/proposed-plan.ts"
import type { LiveDriverEvent, LiveSnapshot } from "../electron/shared.ts"

const text =
  "# Route recovery\n\n1. Preserve the destination.\n2. Test expired sessions.\n"
const plan = ProposedPlanSchema.parse({
  type: "proposed-plan",
  id: "proposal",
  text,
  status: "proposed",
})
const updates = claudeProposedPlan({
  name: "ExitPlanMode",
  input: { plan: text },
  id: plan.id,
})
assert.equal(
  claudeProposedPlan({ name: "Bash", input: { plan: text }, id: plan.id })
    .length,
  0
)
assert.equal(
  claudeProposedPlan({
    name: "ExitPlanMode",
    input: { plan: 123 },
    id: plan.id,
  }).length,
  0
)
const blocks = reduceLiveUpdates([], [...updates, ...updates])
assert.equal(
  blocks.length,
  1,
  "SDK message and permission must not duplicate the same plan"
)
assert.equal(LiveBlockSchema.parse(blocks[0]).type, "proposed-plan")
const canonical = liveEntries(blocks).map((entry) =>
  ThreadEntrySchema.parse(entry)
)
assert.deepEqual(
  threadToMessages(canonical)[0]?.blocks,
  acpBlocksToMessages(blocks, false).messages[0]?.blocks
)
assert.equal(
  responseText(toExchanges(threadToMessages(canonical))[0]!),
  text.trim()
)
const bundle = renderTranscriptBundle({
  ref: { harness: "fixture", nativeId: "fixture", path: "/fixture" },
  entries: canonical,
})
assert.ok(bundle.markdown.includes(text.trim()))
assert.equal(proposedPlanMarkdown(plan), text)
assert.match(proposedPlanReply(plan, "revise"), /Route recovery/)
assert.deepEqual(parsePlanContext(appendPlanContext("Revise it.", [plan])), {
  body: "Revise it.",
  plans: [plan],
})
const changed = { ...plan, text: text.replace("Preserve", "Remember") }
const before = acpBlocksToMessages([plan], false).messages
const after = acpBlocksToMessages([changed], false).messages
assert.notEqual(reconcileMessages(before, after)[0], before[0])
const checklist = (status: string) =>
  acpBlocksToMessages(
    [{ type: "plan", entries: [{ content: "Check routes", status }] }],
    false
  ).messages
const pending = checklist("pending")
assert.notEqual(
  reconcileMessages(pending, checklist("completed"))[0],
  pending[0],
  "Checklist-only changes must invalidate reconciliation"
)
const limited = reduceLiveUpdates(
  [],
  [
    {
      kind: "proposed-plan",
      id: "huge",
      text: "x".repeat(MAX_PROPOSED_PLAN_LENGTH + 10),
      status: "proposed",
    },
  ]
)[0]
assert.ok(limited?.type === "proposed-plan")
assert.equal(limited.text.length, MAX_PROPOSED_PLAN_LENGTH)
assert.equal(limited.truncated, true)
assert.match(proposedPlanMarkdown(limited), /truncated/)
const events: LiveDriverEvent[] = []
const permissions = new ClaudePermissions("fixture", (event) =>
  events.push(event)
)
const signal = new AbortController().signal
const response = permissions.tool(
  "ExitPlanMode",
  { plan: text },
  { signal, requestId: "permission", toolUseID: plan.id }
)
const emittedPlan = events.find((event) => event.type === "live-updates")
assert.ok(emittedPlan?.type === "live-updates")
assert.equal(emittedPlan.updates[0]?.kind, "proposed-plan")
const permission = events.find((event) => event.type === "live-permission")
assert.ok(permission?.type === "live-permission")
assert.equal(permission.request.options[0]?.name, "Approve plan")
permissions.respond("permission", { kind: "choice", optionId: "reject_once" })
const decision = await response
assert.ok(decision)
assert.equal(decision.behavior, "deny")

const root = await mkdtemp(join(tmpdir(), "mako-plans-"))
const outside = await mkdtemp(join(tmpdir(), "mako-plans-outside-"))
try {
  const thread = {
    ref: {
      harness: "fixture",
      nativeId: "fixture",
      path: "/fixture",
      cwd: root,
    },
    entries: [
      ThreadEntrySchema.parse({ kind: "user", text: "Propose a plan." }),
      ...canonical,
    ],
  }
  for (const [emit, provider] of [
    [emitClaudeSession, new ClaudeProvider(root)],
    [emitCodexSession, new CodexProvider(root)],
  ] as const) {
    const emitted = await emit(thread, { home: root, cwd: root })
    const restored = await provider.read(emitted.path)
    assert.ok(restored)
    assert.ok(
      restored.entries.some(
        (entry) =>
          entry.kind === "assistant" &&
          entry.blocks.some(
            (block) => block.type === "text" && block.text.includes(text.trim())
          )
      ),
      "Native continuation must retain the proposed plan"
    )
  }
  const files = new WorkspaceFiles(root, new WorkspaceGit(root))
  const saved = await files.createText(
    root,
    "plan.md",
    proposedPlanMarkdown(plan)
  )
  assert.equal(await readFile(saved, "utf8"), text)
  await assert.rejects(
    files.createText(root, "plan.md", "overwrite"),
    /file already exists/
  )
  assert.equal(await readFile(saved, "utf8"), text)
  await symlink(outside, join(root, "outside"))
  await assert.rejects(
    files.createText(root, "outside/plan.md", text),
    /inside this workspace/
  )
  await assert.rejects(
    files.createText(outside, "other.md", text),
    /workspace changed/
  )
  await assert.rejects(
    files.createText(root, "huge.md", "x".repeat(1_000_001)),
    /save limit/
  )
  const id = randomUUID()
  const snapshot: LiveSnapshot = {
    session: {
      id,
      harness: "fixture",
      cwd: root,
      status: "ready",
      connection: "disconnected",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 1,
    createdAt: 1,
    base: null,
    requests: [],
    permissions: [],
    blocks,
  }
  const journal = new LiveJournal(join(root, "journals"), id)
  journal.commit(snapshot)
  assert.deepEqual(journal.read()?.blocks, blocks)
  journal.close()
} finally {
  await rm(root, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
}
console.log(
  "Proposed plans: SDK permission capture, revisions, canonical conversion, copy/export, limits, journal and non-overwriting workspace save passed"
)
