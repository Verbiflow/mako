import { mcpServerFailedEvent, type TranscriptEvent } from "@mako/sessions/events"
import { ProposedPlanCard } from "../src/components/transcript/proposed-plan"
import { CompactionControl } from "../src/components/composer/compaction-control"
import { fixtureCapabilities, fixtureDeclarations } from "../src/dev/harness-fixtures"
import { harnessLacks } from "@mako/host/contracts/harness-capabilities"
import { Exchange } from "../src/components/transcript/exchange"
import { Prose } from "../src/components/transcript/markdown"
import type { SentProse } from "../src/lib/prompt-markdown"
import { attachmentReference } from "../src/lib/attachment-references"
import { writeDraft } from "../src/lib/context/draft"
import { RetainedRequests } from "../src/components/viewer/acp-panel"
import { continueTurnPrompt, makoPrompts, recoverableRequests, recoveriesByPlace, turnStops } from "../src/state/prompt-delivery"
import { toExchanges, turnRequest } from "../src/lib/exchanges"
import { FailedRequestsContext } from "../src/components/transcript/failed-requests"
import { FailureRow } from "../src/components/transcript/failure-row"
import { requestRecovery } from "../src/state/request-recovery"
import { agentActivity, startLabel } from "../src/state/agent-activity"
import { cn } from "../src/lib/utils"
import { ActivityMark } from "../src/components/ui/activity-mark"
import { FolderActivity } from "../src/components/rail/rail-activity"
import { ThreadStatusMark } from "../src/components/rail/thread-status"
import type { ThreadFolder } from "../src/lib/thread-folders"
import { AttachmentStrip, InlineAttachment } from "../src/components/composer/attachments"
import { MentionMenu } from "../src/components/composer/mention-menu"
import type { Attachment } from "../src/lib/attachments"
import type { LiveRequest, LiveSessionUsage } from "../src/lib/types"
import type { TurnSpend } from "@mako/host/contracts/usage-ledger"
import { projectDraftKey } from "../src/state/drafts"
import { TranscriptSourceContext } from "../src/components/transcript/source-context"
import { draftPlanReply } from "../src/state/plans"
import { planBuildsStore, recordPlanBuild } from "../src/state/plan-builds"
import {
  draftText,
  rememberDraft,
  draftsStore,
  clearCapturedDraft,
  restoreEmptyDraft,
  retainRejectedDraft,
  takeRejectedDraft,
  appendRecoveredDraft,
} from "../src/state/drafts"
import { AgentRow } from "../src/components/inspector/agents-panel"
import { applyLiveSnapshot, applyLiveBatch } from "../src/state/live-recovery"
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { acpStore, type LiveAcpConversation } from "../src/state/acp"
import { LiveActionStatus } from "../src/components/viewer/live-action-status"
import { AcpPanel } from "../src/components/viewer/acp-panel"
import { ProducedNotice } from "../src/components/composer/composer-notices"
import { useApprovalStatusNotice } from "../src/components/viewer/approval-status-notice"
import type { ApprovalResponse } from "@mako/host/contracts/approval-response"
import { folderTrustRequest } from "@mako/host/harnesses/grok/folder-trust"
import { AccessModeList, LiveComposerControls, NextSessionModePicker } from "../src/components/composer/live-controls"
import { ContextMeter, UsageDetails } from "../src/components/composer/context-meter"
import { TooltipProvider } from "../src/components/ui/tooltip"
import { fixtureHarnesses } from "../src/dev/harness-fixtures"
import { threadsStore } from "../src/state/threads"
import { viewedThread } from "../src/state/thread-viewing"
import { TransferStatus } from "../src/components/viewer/transfer-status"
import { ConversationRelations } from "../src/components/viewer/conversation-relations"
import { savedMessageDraft } from "../src/lib/saved-message-draft"

const id = "11111111-1111-4111-8111-111111111111"
const control: NonNullable<LiveAcpConversation["control"]> = {
  activeBindingId: id,
  bindings: [],
  merges: [],
  transfers: [],
  actions: [],
}
const conversation: LiveAcpConversation = {
  key: id,
  draftKey: id,
  kind: "live",
  harness: "claude",
  cwd: "/disposable",
  blocks: [],
  queued: [],
  hiddenUserPrompt: null,
  createdAt: 1,
  updatedAt: 1,
  permission: null,
  sending: false,
  canceling: false,
  control,
  session: {
    id,
    harness: "claude",
    cwd: "/disposable",
    connection: "connected",
    status: "ready",
    modes: [],
    currentMode: null,
    configOptions: [],
  },
}
function publish() {
  acpStore.set({
    activeKey: id,
    conversations: { [id]: { ...conversation, control: { ...control } } },
  })
}
conversation.session = { ...conversation.session, status: "starting", connection: "starting" }
conversation.permission = { id: "sign-in", sessionId: id, kind: "authentication", title: "Provider requires sign-in", options: [{ optionId: "browser", name: "Log in with browser", kind: "allow_once" }] }
publish()
const authenticationMarkup = renderToStaticMarkup(<AcpPanel />)
assert.match(authenticationMarkup, /Log in with browser/)
assert.match(authenticationMarkup, /Cancel sign-in/)
assert.match(authenticationMarkup, /Your prompt waits until sign-in succeeds/)
assert.doesNotMatch(authenticationMarkup, /Choose how long to allow it/)
conversation.session = { ...conversation.session, status: "ready", connection: "connected" }
const trustAsk = folderTrustRequest({ sessionId: id, cwd: "/disposable", workspace: "/disposable", configKinds: ["mcp", "hooks"] })!.ask.request
conversation.permission = { id: "trust", sessionId: id, ...trustAsk }
publish()
const trustMarkup = renderToStaticMarkup(<AcpPanel />)
assert.match(trustMarkup, /data-request-detail[^>]*>Grok ignores the MCP servers and hooks in \/disposable until you trust it\./, "a request that isn't for a tool says what it asks")
assert.match(trustMarkup, /Trust project/)
assert.match(trustMarkup, /Not now/)
assert.doesNotMatch(trustMarkup, /Choose how long to allow it/)
// Answering a tool approval: the host saves the answer as sending and, for a connection that takes it at once, as handed
// over in the same moment. Nothing above the composer says the sending: a bar there would be drawn for a frame, empty
// as it faded in. What still needs the person after the hold, or ever, is said in words.
{
  const origin = { nativeRequestId: "call-1", bindingId: id, epoch: "fixture", generation: 1, connectionGeneration: 1 }
  const asked = { id: "33333333-3333-4333-8333-333333333333", sessionId: id, kind: "execute", title: "npm test -- --run src/router", origin,
    options: [{ optionId: "once", name: "Allow once", kind: "allow_once" as const }, { optionId: "always", name: "Always allow", kind: "allow_always" as const }] }
  const answered = (state: ApprovalResponse["state"], permission: typeof asked | null) => {
    const receipt: ApprovalResponse = { id: asked.id, origin, digest: "a".repeat(64), createdAt: 1, state }
    acpStore.set({ activeKey: id, conversations: { [id]: { ...conversation, session: { ...conversation.session, status: "running" }, permission, control: { ...control, approvalResponses: [receipt] } } } })
    return renderToStaticMarkup(<ProducedNotice use={useApprovalStatusNotice} />)
  }
  assert.equal(answered({ kind: "dispatching" }, asked), "", "an answer just sent draws no bar above the composer")
  assert.equal(answered({ kind: "submitted", source: "callback" }, null), "", "an answer handed over draws nothing")
  assert.match(answered({ kind: "uncertain", reason: "Lost" }, asked), /data-approval-recovery[^>]*>.*Answer delivery unknown/s, "an answer that may not have arrived says so, in words")
  assert.match(answered({ kind: "not-submitted", pending: false, reason: "request-ended" }, null), /Approval is no longer waiting/)
}
conversation.permission = null
conversation.session = { ...conversation.session, status: "ready", connection: "connected" }
for (const descriptor of fixtureHarnesses) {
  const request = { id: `auth-${descriptor.provider}`, text: "Native carrier", displayText: "Review this file [Attachment 1]", attachments: [
    { name: "report.pdf", mimeType: "application/pdf", size: 123, path: "/disposable/report.pdf" },
    { name: "image.png", mimeType: "image/png", size: 4, data: "YWJjZA==" },
  ], status: "failed" as const, failure: "auth" as const, nativeDelivery: {
    attemptId: "attempt", bindingId: id, ownerEpoch: "epoch",
    evidence: { kind: "accepted" as const, source: "native-response" as const },
  } }
  conversation.harness = descriptor.provider
  conversation.session = { ...conversation.session, harness: descriptor.provider }
  conversation.requests = [request]
  publish()
  // The history disclosure deliberately defers its body; the newest recovery
  // notice exposes the action when reviewed in browser acceptance below.
  const prepared = savedMessageDraft(request)
  assert.match(prepared.text, /Review this file/)
  assert.doesNotMatch(prepared.text, /Native carrier/)
  assert.deepEqual(prepared.attachments.map((file) => [file.stagedPath, file.data]), [["/disposable/report.pdf", undefined], [undefined, "YWJjZA=="]])
  assert.equal(request.status, "failed")
  assert.equal(request.nativeDelivery.evidence.kind, "accepted")
  const markup = renderToStaticMarkup(<FailureRow conversationId={id} request={request} />)
  assert.match(markup, /Sign-in required/)
  assert.match(markup, /data-recovery-primary="sign-in"/)
  assert.doesNotMatch(markup, /Use in new thread|Send again|Send another copy/)
  assert.deepEqual(requestRecovery(request, { provider: descriptor.displayName }).more.map((action) => action.kind), ["restore", "copy", "settings"], "a signed-out account offers no repeat and no new thread")
}
const duplicateFiles = savedMessageDraft({ id: "duplicates", text: "Keep both", attachments: [
  { name: "same.pdf", mimeType: "application/pdf", size: 1, path: "/a/same.pdf" },
  { name: "same.pdf", mimeType: "application/pdf", size: 2, path: "/b/same.pdf" },
] })
assert.notEqual(attachmentReference(duplicateFiles.attachments[0]!), attachmentReference(duplicateFiles.attachments[1]!))
const literalAppendix = "Example\n---\n[Attachment 9] private.pdf — application/pdf, 1 KB. Saved at /private.pdf; read it from there."
assert.equal(savedMessageDraft({ id: "literal", text: literalAppendix, attachments: [] }).text, literalAppendix)
assert.match(savedMessageDraft({ id: "missing", text: "Keep a missing file", attachments: [{ name: "missing.pdf", mimeType: "application/pdf", size: 2 }] }).attachments[0]?.error ?? "", /Attach it again/)
conversation.harness = "claude"
conversation.session = { ...conversation.session, harness: "claude" }
conversation.requests = []
// The access picker shows one ladder: tier labels in tier order, the
// provider's own name beside them, and who enforces a host-made tier.
threadsStore.set({
  descriptors: fixtureHarnesses.map((entry) => entry.provider === "claude" ? { ...entry, canSteer: true, steering: "step", recovery: { compaction: { kind: "supported" } } } : entry),
})
conversation.session = {
  ...conversation.session,
  currentMode: "access:full",
  modes: [
    { id: "agent", name: "Agent", access: "ask", enforcement: "provider" },
    { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
    { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
    { id: "access:auto", name: "Auto review", access: "auto", enforcement: "launch" },
    { id: "verbose", name: "Verbose", description: "Provider-only switch" },
  ],
}
publish()
const triggerMarkup = renderToStaticMarkup(<LiveComposerControls />)
assert.match(triggerMarkup, /aria-label="Access: Full access"/)
// The steer/queue preference is a Settings row, not a checkbox in the composer's menu.
assert.doesNotMatch(triggerMarkup, /steers/)
const controlsMarkup = renderToStaticMarkup(
  <AccessModeList modes={conversation.session.modes} current="access:full" harness="claude" onSelect={() => {}} />
)
const order = ["Plan", "Ask before acting", "Auto review", "Full access", "Verbose"].map((label) => controlsMarkup.indexOf(`<span class="truncate">${label}</span>`))
assert.ok(order.every((index) => index >= 0), `every mode renders: ${order.join(",")}`)
assert.deepEqual([...order].sort((a, b) => a - b), order, "the ladder renders least to most permissive, provider-only modes last")
assert.match(controlsMarkup, /claude: Agent/)
assert.doesNotMatch(controlsMarkup, /Mako approves/)
assert.match(controlsMarkup, /Set when the session starts/)
assert.match(controlsMarkup, /Provider-only switch/)
// A one-mode provider (Cursor) offers nothing to choose: the chip names the
// one level there is with nothing saved or remembered, and opens no ladder.
conversation.session = {
  ...conversation.session,
  currentMode: null,
  modes: [{ id: "full-access", name: "Agent", access: "full", enforcement: "provider" }],
}
publish()
const singleModeMarkup = renderToStaticMarkup(<LiveComposerControls />)
assert.match(singleModeMarkup, /aria-label="Access: Full access"/)
assert.doesNotMatch(singleModeMarkup, /<button[^>]*aria-label="Access:/)
const originalAccessDescriptors = threadsStore.get().descriptors
threadsStore.set({
  descriptors: [{ provider: "cursor", displayName: "Cursor", resumable: true, live: true, ...fixtureDeclarations("cursor"), modes: conversation.session.modes }],
  composerHarness: "cursor",
})
const nextSessionMarkup = renderToStaticMarkup(<NextSessionModePicker />)
assert.match(nextSessionMarkup, /aria-label="Access: Full access"/)
assert.doesNotMatch(nextSessionMarkup, /<button/)
// A declared factory default cannot certify a native configured policy.
// Without an explicit/remembered choice, report native configuration honestly.
threadsStore.set({
  descriptors: [{
    provider: "grok",
    displayName: "Grok",
    resumable: true,
    live: true,
    ...fixtureDeclarations("grok"),
    modes: [
      { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
      { id: "access:ask", name: "Ask before acting", access: "ask", enforcement: "launch" },
      { id: "access:auto", name: "Auto review", access: "auto", enforcement: "launch" },
      { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
    ],
    defaultMode: "access:ask",
  }],
  composerHarness: "grok",
})
const defaultedMarkup = renderToStaticMarkup(<NextSessionModePicker />)
assert.match(defaultedMarkup, /aria-label="Access: Native default"/)
assert.doesNotMatch(defaultedMarkup, /aria-label="Access: Ask before acting"/)
assert.match(defaultedMarkup, /native configuration/)
// The thread's own remembered level still outranks the provider default.
threadsStore.set({
  viewing: viewedThread({
    ref: { harness: "grok", nativeId: "ses", path: "/tmp/ses.jsonl", accessMode: "access:full" },
    entries: [],
  }),
})
const rememberedMarkup = renderToStaticMarkup(<NextSessionModePicker />)
assert.match(rememberedMarkup, /aria-label="Access: Full access"/)
threadsStore.set({ viewing: null, descriptors: originalAccessDescriptors, composerHarness: "claude" })
conversation.session = { ...conversation.session, currentMode: null, modes: [] }
control.actions = [
  {
    input: { kind: "compact", id },
    digest: "test",
    bindingId: id,
    createdAt: 1,
    state: { kind: "completed" },
  },
]
publish()
assert.equal(renderToStaticMarkup(<LiveActionStatus />), "")
assert.match(
  renderToStaticMarkup(<LiveActionStatus history />),
  /Compaction completed/
)
control.actions[0]!.state = { kind: "accepted" }
publish()
assert.match(renderToStaticMarkup(<LiveActionStatus />), /Compaction in progress/)
control.actions[0]!.state = {
  kind: "uncertain",
  reason: "Connection lost after dispatch",
}
publish()
assert.match(
  renderToStaticMarkup(<LiveActionStatus />),
  /Disconnect and keep history/
)
assert.match(renderToStaticMarkup(<LiveActionStatus />), /aria-expanded="false"/)
assert.doesNotMatch(renderToStaticMarkup(<LiveActionStatus />), /Connection lost after dispatch/, "details mount only when opened; interactive coverage lives in test-recovery-notice-ui")
control.transfers = [
  {
    input: { id, provider: "claude", text: "saved request", attachments: [] },
    createdAt: 1,
    state: {
      kind: "accepted",
      bindingId: id,
      manifest: {
        file: "/disposable/context.md",
        digest: "test",
        sourceRevision: 1,
        fromBlock: 0,
        toBlock: 1,
        includesBase: true,
        losses: [],
      },
    },
  },
]
publish()
assert.equal(renderToStaticMarkup(<TransferStatus />), "")
assert.match(
  renderToStaticMarkup(<TransferStatus history />),
  /Inspect transferred context/
)
control.transfers[0]!.state = {
  kind: "uncertain",
  error: "Acceptance not confirmed",
}
publish()
assert.match(
  renderToStaticMarkup(<TransferStatus />),
  /Acceptance not confirmed/
)
assert.match(renderToStaticMarkup(<TransferStatus />), /aria-expanded="true"/)
assert.match(renderToStaticMarkup(<TransferStatus />), /saved request/)
control.ancestry = {
  kind: "fork",
  parentId: id,
  sourceRevision: 1,
  point: "before",
}
publish()
const relations = renderToStaticMarkup(<ConversationRelations />)
assert.match(relations, />Forked</)
assert.doesNotMatch(relations, /<textarea|<form|<select/)
console.log(
  "Rendered controls: completed receipts are on demand; pending/uncertain actions and saved input remain visible; the closed task dialog adds no form to the transcript"
)

const nativeAgent = {
  nativeId: "child",
  bindingId: id,
  provider: "claude",
  title: "Inspect routing",
  observedAt: 1,
  state: { kind: "completed" as const, summary: "Found the route" },
  usage: { tokens: 100, toolUses: 2 },
}
const row = renderToStaticMarkup(<AgentRow agent={nativeAgent} />)
assert.match(row, /Found the route/)
assert.match(row, /100 tokens/)
assert.match(row, /2 tool uses/)
assert.doesNotMatch(row, /aria-expanded/, "a row with nothing more to show does not offer to expand")
const command = renderToStaticMarkup(<AgentRow conversation={id} agent={{
  ...nativeAgent, nativeId: "shell", title: "Build the app", work: "command", detail: "npm run build", background: true, stoppable: true,
  startedAt: 1, state: { kind: "working" as const }, usage: undefined,
}} />)
assert.match(command, /data-native-work="command"/)
assert.match(command, /Running/)
assert.match(command, /aria-expanded="false"/, "a command opens onto its command line")
assert.match(command, /aria-label="Stop Build the app"/, "a task its provider can stop alone offers Stop")
const ended = renderToStaticMarkup(<AgentRow conversation={id} agent={{
  ...nativeAgent, nativeId: "shell", title: "Build the app", work: "command", stoppable: false, startedAt: 1_000, settledAt: 13_000,
  state: { kind: "completed" as const, summary: "Exited with code 0" }, output: "built in 12s", usage: undefined,
}} />)
assert.match(ended, /Done/)
assert.match(ended, /12s/, "a settled task shows how long it ran")
assert.doesNotMatch(ended, /aria-label="Stop/)
applyLiveSnapshot({
  session: conversation.session,
  blocks: [],
  requests: [],
  permissions: [],
  revision: 1,
  createdAt: 1,
  base: null,
})
const beforeAgents = acpStore.get().conversations[id]
assert.ok(beforeAgents?.kind === "live")
applyLiveBatch({
  id,
  revision: 2,
  updates: [],
  nativeAgents: { agents: [nativeAgent], limited: false },
})
const afterAgents = acpStore.get().conversations[id]
assert.ok(afterAgents?.kind === "live")
assert.equal(
  afterAgents.projection,
  beforeAgents.projection,
  "Agent-only events must preserve the transcript projection"
)
assert.equal(afterAgents.nativeAgents?.agents[0]?.nativeId, "child")
console.log(
  "Agent details render; agent-only batches preserve the transcript projection"
)

const proposal = {
  type: "proposed-plan" as const,
  id: "plan-1",
  text: "# Route recovery\n\nKeep the requested destination.",
  status: "proposed" as const,
}
const planCard = renderToStaticMarkup(
  <TooltipProvider>
    <TranscriptSourceContext value={{ liveId: id }}>
      <ProposedPlanCard plan={proposal} />
    </TranscriptSourceContext>
  </TooltipProvider>
)
assert.match(planCard, /Route recovery/)
assert.match(planCard, /aria-label="Open in a tab"/)
assert.match(planCard, /aria-label="Copy as Markdown"/)
assert.match(planCard, /aria-label="Build in a new session"/)
assert.doesNotMatch(planCard, />Build<\/button>/, "Build and Revise live in the composer's decision bar, not on the card")
assert.doesNotMatch(planCard, /Built in/)
recordPlanBuild(proposal, { conversation: id })
const builtHere = renderToStaticMarkup(
  <TooltipProvider>
    <TranscriptSourceContext value={{ liveId: id }}>
      <ProposedPlanCard plan={proposal} />
    </TranscriptSourceContext>
  </TooltipProvider>
)
assert.match(builtHere, />Built</, "a plan built here says so once, beside its title")
assert.equal(builtHere.match(/>Built</g)?.length, 1)
assert.doesNotMatch(builtHere, /Open that session/, "a plan built here links nowhere")
recordPlanBuild(proposal, { conversation: "another-session" })
const builtElsewhere = renderToStaticMarkup(
  <TooltipProvider>
    <TranscriptSourceContext value={{ liveId: id }}>
      <ProposedPlanCard plan={proposal} />
    </TranscriptSourceContext>
  </TooltipProvider>
)
assert.match(builtElsewhere, /Built in another session/)
assert.doesNotMatch(builtElsewhere, /Open that session/, "a session that is gone is not offered")
planBuildsStore.set({ builds: {} })
rememberDraft(id, "Also preserve accessibility.")
draftPlanReply({ liveId: id }, proposal, "implement")
const preparedPlan = draftText(id)
assert.ok(preparedPlan.startsWith("Also preserve accessibility."))
assert.ok(!preparedPlan.includes(proposal.text))
assert.equal(
  draftsStore.get().drafts.find((entry) => entry.key === id)?.plans?.[0]?.text,
  proposal.text
)
draftPlanReply({ liveId: id }, proposal, "implement")
assert.equal(
  draftText(id),
  preparedPlan,
  "Repeated clicks must not duplicate the same prepared reply"
)
assert.throws(
  () => draftPlanReply({ liveId: "other" }, proposal, "implement"),
  /Open the plan's conversation/
)
assert.equal(draftText(id), preparedPlan)
draftPlanReply({ liveId: id }, proposal, "revise")
assert.ok(draftText(id).startsWith("Also preserve accessibility."))
assert.ok(!draftText(id).includes("Implement the proposed plan:"))
assert.ok(
  draftText(id).includes("Keep planning until I approve implementation.")
)
draftPlanReply({ liveId: id }, proposal, "implement")
assert.equal(draftText(id), preparedPlan)
assert.throws(
  () =>
    draftPlanReply(
      { liveId: id },
      { ...proposal, truncated: true },
      "implement"
    ),
  /complete plan/
)
console.log(
  "Plan reply preparation preserves existing drafts, rejects stale conversations, and avoids duplicate insertion"
)

const planDraft = draftsStore.get().drafts.find((entry) => entry.key === id)
assert.ok(planDraft)
rememberDraft(id, "A newer paragraph")
clearCapturedDraft(id, planDraft.text, planDraft.plans)
assert.equal(draftText(id), "A newer paragraph")
assert.equal(restoreEmptyDraft(id, planDraft.text, planDraft.plans), false)
retainRejectedDraft(id, planDraft.text, [], planDraft.plans)
const rejectedPlan = draftsStore.get().rejected.at(-1)
assert.ok(rejectedPlan)
const recoveredPlan = takeRejectedDraft(rejectedPlan.id)
assert.ok(recoveredPlan)
appendRecoveredDraft(id, recoveredPlan)
assert.ok(draftText(id).startsWith("A newer paragraph"))
assert.equal(
  draftsStore.get().drafts.find((entry) => entry.key === id)?.plans?.[0]?.text,
  proposal.text
)
const finalDraft = draftsStore.get().drafts.find((entry) => entry.key === id)
assert.ok(finalDraft)
clearCapturedDraft(id, finalDraft.text, finalDraft.plans)
assert.equal(
  draftsStore.get().drafts.find((entry) => entry.key === id),
  undefined
)
assert.equal(restoreEmptyDraft(id, finalDraft.text, finalDraft.plans), true)
console.log(
  "Plan context survives refused sends and newer edits; accepted sends clear only their own captured draft"
)

const screenshot: Attachment = {
  id: "screenshot", index: 1, kind: "image", mimeType: "image/png", name: "Screenshot.png",
  preview: "blob:fixture-image", stagedPath: "/retained/image.png", size: 42,
}
const clip: Attachment = { ...screenshot, id: "clip", name: "Clip.mp4", kind: "binary", mimeType: "video/mp4", preview: "blob:fixture-video" }
const inline = renderToStaticMarkup(<InlineAttachment item={screenshot} reference="[Screenshot.png]" />)
assert.match(inline.replace(/<[^>]+>/g, ""), /\[Screenshot\.png\]/, "the reference reads as its token, whatever spans style the brackets")
assert.doesNotMatch(inline, /<button|Remove|role="button"/)
const previews = renderToStaticMarkup(<AttachmentStrip items={[screenshot, clip]} onRemove={() => {}} />)
assert.match(previews, /role="img" aria-label="Screenshot\.png"/, "an image tile is an image named for its file, however it is painted")
assert.match(previews, /<video/)
assert.equal((previews.match(/aria-label="Remove /g) ?? []).length, 2)
assert.doesNotMatch(previews, /autoplay/i)
rememberDraft(projectDraftKey("/project"), "Unfinished project prompt")
rememberDraft(projectDraftKey("/other"), "Other project")
assert.equal(draftText(projectDraftKey("/project/")), "Unfinished project prompt")
assert.equal(draftText(projectDraftKey("/other")), "Other project")
console.log("Composer: native inline references, one remove control per preview, image/video previews, and project-scoped drafts verified")

const formattedPrompt = "- **85** still have no usable office street candidate.\n\n\n\n\nNo way dude. This is fucking not possible. We have to figure this out. Either the office address or sometimes the office address, maybe also their first address where they incorporated, or whatever it is. California must have that address or Delaware or something. They must have that address. We should get that shit. Come on man"
const formatted = renderToStaticMarkup(<Exchange exchange={{id:"format", prompt:{id:"format", role:"user", blocks:[{type:"text",text:formattedPrompt}]}, response:[], system:[]}} />)
assert.match(formatted, /<ul>/)
assert.match(formatted, /<strong>85<\/strong>/)
assert.doesNotMatch(formatted, /\*\*85\*\*/)
assert.match(formatted, /prompt-prose whitespace-normal/)
assert.match(formatted, /aria-label="Copy question"/)
const sentFiles: SentProse = { items: [{ n: 1, kind: "file", file: { name: "Screenshot.png", mimeType: "image/png", path: "/retained/Screenshot.png" } }], records: new Map() }
const references = renderToStaticMarkup(<Prose text="Use **@src/file.ts** with [Image 1: Screenshot.png] and $review." sent={sentFiles} />)
assert.match(references, /data-copy-file="src\/file.ts"/)
assert.match(references, /data-copy-file="\/retained\/Screenshot.png"/)
assert.match(references, /Skill: review/)
const literal = renderToStaticMarkup(<Prose text={'```text\n@src/file.ts [Image 1: Screenshot.png]\n```'} sent={sentFiles} />)
assert.doesNotMatch(literal, /data-copy-file=/)
const screenshotName = "CleanShot 2026-09-09 at 1.01.59 AM@2x.png"
const screenshotRecord = { id: "shot", index: 1, name: screenshotName, mimeType: "image/png", kind: "image" as const, stagedPath: "/retained/shot.png" }
const screenshotPrompt = writeDraft({ draft: attachmentReference(screenshotRecord), records: [screenshotRecord] }).text
const namedScreenshot = renderToStaticMarkup(<Exchange exchange={{id:"named-shot", prompt:{id:"named-shot",role:"user",blocks:[{type:"text",text:screenshotPrompt},{type:"attachment",name:screenshotName,mimeType:"image/png",source:{kind:"file",path:"/retained/shot.png"}}]},response:[],system:[]}} />)
assert.match(namedScreenshot, /data-copy-file="\/retained\/shot.png"/)
assert.doesNotMatch(namedScreenshot, /mailto:/)
console.log("Prompt Markdown: the reported bullet/bold case, normal paragraph flow, copy controls, rich references, screenshot names with @2x, and literal code verified")
conversation.blocks = [{type:"user",requestId:"stopped",text:"Keep this original question"}]
conversation.requests = [{id:"stopped",text:"Keep this original question",attachments:[],status:"interrupted"}]
publish()
assert.equal(renderToStaticMarkup(<RetainedRequests />), "")
assert.equal(recoverableRequests(conversation).length, 0)
assert.equal(recoveriesByPlace(conversation).onTurns.size, 0, "a stopped turn says so in its own footer, not in a failure row")
const stoppedMarkup = renderToStaticMarkup(<Exchange interrupted exchange={{id:"stopped",prompt:{id:"stopped",role:"user",requestId:"stopped",blocks:[{type:"text",text:"Keep this original question"}]},response:[],system:[]}} />)
assert.match(stoppedMarkup, /data-turn-stopped="stopped"/)
assert.match(stoppedMarkup, />Stopped</)
assert.doesNotMatch(stoppedMarkup, /Continue turn/, "a user's Stop offers nothing")
assert.equal(stoppedMarkup.split("Keep this original question").length - 1, 1)
// A turn Mako itself cut short says so and, on the newest turn with the
// session idle, offers to pick it up; the offer needs a live conversation to send to.
const stoppedExchange = {id:"stopped",prompt:{id:"stopped",role:"user" as const,requestId:"stopped",blocks:[{type:"text" as const,text:"Keep this original question"}]},response:[],system:[]}
const quitMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange interrupted={{ reason: "host-quit", continuable: true, automatic: false }} exchange={stoppedExchange} />
  </TranscriptSourceContext>
)
assert.match(quitMarkup, /data-turn-stopped="host-quit"/)
assert.match(quitMarkup, /Interrupted when Mako quit/)
assert.match(quitMarkup, /<button[^>]*>[^]*?Continue turn/)
const crashedMarkup = renderToStaticMarkup(<Exchange interrupted={{ reason: "host-crashed", continuable: false, automatic: false }} exchange={stoppedExchange} />)
assert.match(crashedMarkup, /Interrupted when Mako closed unexpectedly/)
assert.doesNotMatch(crashedMarkup, /Continue turn/, "an older interrupted turn is described, not offered")
// A turn Mako stopped because it couldn't save the conversation ends on its failure row, live and reopened alike:
// what happened, that the agent's work stands, Continue turn, and what failed under Details. Never "Stopped".
const unsavedRequest: LiveRequest = { id: "stopped", text: "Keep this original question", attachments: [], status: "interrupted", interruption: { reason: "not-saved", at: 1 }, error: "database or disk is full" }
conversation.requests = [unsavedRequest]
publish()
const unsavedPlaces = recoveriesByPlace(conversation)
assert.deepEqual([...unsavedPlaces.onTurns.keys()], ["stopped"])
const unsavedMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <FailedRequestsContext value={unsavedPlaces.onTurns}>
      <Exchange interrupted={turnStops([unsavedRequest], false).get("stopped")} exchange={stoppedExchange} />
    </FailedRequestsContext>
  </TranscriptSourceContext>
)
assert.match(unsavedMarkup, /data-failure-row="stopped"[^>]*data-failure-tone="danger"/)
assert.match(unsavedMarkup, /Mako couldn&#x27;t save this conversation/)
assert.match(unsavedMarkup, /Mako stopped Claude Code rather than let it work on with nothing saved; what it did so far stands\. Once Mako can save again, often after freeing disk space, continue the turn\./)
assert.match(unsavedMarkup, /data-recovery-primary="continue"[^>]*>Continue turn</)
assert.doesNotMatch(unsavedMarkup, /data-turn-stopped/, "the footer doesn't say it again")
assert.doesNotMatch(unsavedMarkup, />Stopped</, "never the person's Stop")
conversation.requests = []
publish()
// A goal's turn Mako stopped at the token budget the person set: the footer says so, as quietly as a Stop, with the
// goal's mark, and offers nothing.
const budgetMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange interrupted={{ reason: "goal-budget", continuable: false, automatic: false }} exchange={stoppedExchange} />
  </TranscriptSourceContext>
)
assert.match(budgetMarkup, /data-turn-stopped="goal-budget"[^>]*>[^]*?lucide-target/)
assert.match(budgetMarkup, /Stopped at the goal&#x27;s token budget/)
assert.doesNotMatch(budgetMarkup, />Stopped</, "not the person's Stop")
assert.doesNotMatch(budgetMarkup, /text-caution|Continue turn/, "an outcome the person set, not an alarm")
// A turn the provider ended on its own dropped connection names that
// provider's connection and offers to go on, since the work so far stands.
const droppedMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange interrupted={{ reason: "connection-lost", continuable: true, automatic: false }} exchange={stoppedExchange} />
  </TranscriptSourceContext>
)
assert.match(droppedMarkup, /data-turn-stopped="connection-lost"/)
assert.match(droppedMarkup, /The connection to Claude Code dropped/)
assert.match(droppedMarkup, /<button[^>]*>[^]*?Continue turn/)
// While the host has scheduled its own continuation there is nothing to
// press: the footer says the turn is continuing and carries the live mark.
const continuingMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange interrupted={{ reason: "connection-lost", continuable: false, automatic: true }} exchange={stoppedExchange} />
  </TranscriptSourceContext>
)
assert.match(continuingMarkup, /The connection to Claude Code dropped/)
assert.match(continuingMarkup, /data-turn-continuing[^>]*>[^]*?continuing automatically/)
assert.doesNotMatch(continuingMarkup, /Continue turn/, "a scheduled continuation is not also offered")
// Once a stopped turn is continued, by Mako or by the person's Continue turn, it goes on as one turn: the stop it went
// on from leaves no footer, there is nothing where the continuation was sent, and its words are never the person's.
for (const sender of ["mako", "person"] as const) {
  const stopped: LiveRequest = { id: "stopped", text: "Keep this original question", attachments: [], status: "interrupted", interruption: { reason: "connection-lost", at: 1 } }
  const continuation: LiveRequest = { id: "continued", text: continueTurnPrompt("connection-lost", sender), attachments: [], status: "completed", ...sender === "mako" && { continues: { requestId: "stopped", reason: "connection-lost" as const, auto: true } } }
  const [turn, ...others] = toExchanges([
    stoppedExchange.prompt,
    { id: "cut-answer", role: "assistant", blocks: [{ type: "text", text: "Fixing the footer." }] },
    { id: "continued", role: "user", requestId: "continued", timestamp: 1_700_000_000_000, blocks: [{ type: "text", text: continuation.text }] },
    { id: "went-on", role: "assistant", blocks: [{ type: "text", text: "The footer is fixed." }] },
  ])
  assert.equal(others.length, 0, `${sender}: one turn`)
  const stops = turnStops([stopped, continuation], false)
  const markup = renderToStaticMarkup(
    <TranscriptSourceContext value={{ liveId: conversation.key }}>
      <Exchange exchange={turn!} interrupted={stops.get(turnRequest(turn!) ?? "")} sentByMako={makoPrompts([stopped, continuation]).get(turn!.prompt?.requestId ?? "")} />
    </TranscriptSourceContext>
  )
  assert.match(markup, /Keep this original question/)
  assert.match(markup, /The footer is fixed/)
  assert.doesNotMatch(markup, /data-turn-stopped|dropped|Continue turn/, `${sender}: the stop it went on from is over`)
  assert.doesNotMatch(markup, /data-turn-continued|continued the turn|Continue where you left off/, `${sender}: nothing where the continuation was sent`)
  assert.equal(markup.match(/aria-label="Copy question"/g)?.length, 1, `${sender}: one prompt, the person's`)
}
// Anything else the person typed stays their prompt.
const typedMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange exchange={stoppedExchange} />
  </TranscriptSourceContext>
)
assert.match(typedMarkup, /Keep this original question/)
assert.doesNotMatch(typedMarkup, /data-turn-continued/)
conversation.requests.push({id:"unsent",text:"Do not lose a pre-dispatch stop",attachments:[],status:"interrupted"})
conversation.requests.push({id:"failed",text:"Failed input remains recoverable",attachments:[],status:"failed"})
publish()
const recoveries = renderToStaticMarkup(<RetainedRequests />)
assert.match(recoveries, /Saved messages \(2\)/)
assert.doesNotMatch(recoveries, /Do not lose a pre-dispatch stop|Failed input remains recoverable|Keep this original question|Send again/, "the archive's rows mount only when opened")
assert.deepEqual(recoverableRequests(conversation).map(request => request.id), ["unsent", "failed"], "both saved messages remain available behind the disclosure")
// Neither reached the transcript, so both are drawn after its last turn, quoting their words.
assert.deepEqual(recoveriesByPlace(conversation).apart.map((request) => request.id), ["unsent", "failed"])
const apart = renderToStaticMarkup(<FailureRow conversationId={id} request={conversation.requests.find((request) => request.id === "failed")!} quoted />)
assert.match(apart, /Failed input remains recoverable/)
assert.match(apart, /data-recovery-primary="resend"[^>]*>Send another copy</, "no delivery evidence: a repeat is another copy")
// A classified failure is described for the provider and offers Send again
// only when a repeat can work.
conversation.requests.push({id:"rejected",text:"Once more",attachments:[],status:"failed",failure:"transcript-rejected",error:"reasoning encrypted_content was not issued to this caller"})
conversation.requests.push({id:"quit-unsent",text:"Cut short before it ran",attachments:[],status:"interrupted",interruption:{reason:"host-quit",at:1}})
publish()
const classified = renderToStaticMarkup(<FailureRow conversationId={id} request={conversation.requests.find((request) => request.id === "rejected")!} />)
assert.match(classified, /Session history was rejected/)
assert.match(classified, /data-recovery-primary="fresh"[^>]*>Use in new thread</, "a history the model refuses is escaped only by a new thread")
assert.doesNotMatch(classified, /Send again/)
assert.doesNotMatch(classified, /encrypted_content was not issued/, "the provider's words wait behind Details, mounted when opened")
assert.deepEqual(recoverableRequests(conversation).map(request => request.id), ["unsent", "failed", "rejected", "quit-unsent"])
conversation.requests.splice(-2, 2)
publish()
const savedDescriptors = threadsStore.get().descriptors
threadsStore.set({ descriptors: [{ provider: "claude", displayName: "Claude Code", resumable: true, live: true, ...fixtureDeclarations("claude") }] })
const savedSession = conversation.session
const savedActions = control.actions
const compactionRequest = conversation.requests.find((request) => request.id === "failed")!
const savedFailure = compactionRequest.failure
compactionRequest.failure = "context-exhausted"
conversation.session = { ...conversation.session, status: "failed", connection: "connected" }
control.actions = []
publish()
assert.doesNotMatch(renderToStaticMarkup(<CompactionControl requestId="failed" />), /disabled=""/)
control.actions = [{ input: { kind: "compact", id, requestId: "failed" }, digest: "fixture", bindingId: id, createdAt: 1, state: { kind: "accepted" } }]
publish()
assert.match(renderToStaticMarkup(<CompactionControl requestId="failed" />), /disabled=""/)
control.actions[0].state = { kind: "completed" }
publish()
// Once its compaction finished, a full context may fit: the row offers the repeat.
assert.match(renderToStaticMarkup(<FailureRow conversationId={id} request={compactionRequest} />), /data-recovery-primary="resend"/)
// The unsupported-provider case must not inherit the completed compaction above.
control.actions = []
publish()
threadsStore.set({ descriptors: [{ provider: "claude", displayName: "Fixture", resumable: true, live: true,
  ...fixtureDeclarations("claude"), capabilities: { ...fixtureCapabilities("claude"), compaction: harnessLacks("Fixture cannot compact") } }] })
assert.doesNotMatch(renderToStaticMarkup(<FailureRow conversationId={id} request={compactionRequest} />), /Fixture cannot compact|Compact and retry/)
assert.doesNotMatch(renderToStaticMarkup(<CompactionControl />), /<button/)
// A harness that compacts on its own says so, and offers no Compact of its own.
threadsStore.set({ descriptors: [{ provider: "claude", displayName: "Fixture", resumable: true, live: true,
  ...fixtureDeclarations("claude"), capabilities: { ...fixtureCapabilities("claude"), compaction: fixtureCapabilities("cursor").compaction } }] })
const automatic = renderToStaticMarkup(<CompactionControl />)
assert.equal(fixtureCapabilities("cursor").compaction.state, "default")
assert.match(automatic, /summarizes the conversation on its server/)
assert.doesNotMatch(automatic, /<button|Start a new thread/)
threadsStore.set({ descriptors: savedDescriptors })
conversation.session = savedSession
control.actions = savedActions
compactionRequest.failure = savedFailure
publish()
for (const size of ["label", "ui", "title", "prose", "welcome"]) assert.equal(cn(`text-${size}`, "text-foreground"), `text-${size} text-foreground`)
assert.equal(cn("text-ui", "text-prose", "text-transparent"), "text-prose text-transparent")
const activityBase = {waiting:false,connecting:false,preparing:false}
assert.equal(agentActivity({...activityBase,blocks:[{type:"text",text:""}]}).kind,"working")
assert.equal(agentActivity({...activityBase,blocks:[{type:"thinking",text:""}]}).kind,"working")
assert.equal(agentActivity({...activityBase,blocks:[{type:"thinking",text:"Reasoning"}]}).kind,"reasoning")
assert.equal(agentActivity({...activityBase,blocks:[{type:"text",text:"Answer"}]}).kind,"responding")
for (const [toolKind, expected] of [["search","searching"],["execute","executing"],["edit","editing"]] as const) {
  const activity = agentActivity({...activityBase,blocks:[{type:"tool",id:toolKind,toolKind,title:toolKind,input:"{}",output:"",status:"pending"}]})
  assert.equal(activity.kind,expected)
  assert.match(renderToStaticMarkup(<ActivityMark state={activity.kind} size={64} />), /<canvas/)
  assert.doesNotMatch(renderToStaticMarkup(<ActivityMark state={activity.kind} />), /<canvas/)
}
assert.doesNotMatch(renderToStaticMarkup(<ActivityMark state="waiting" size={64} />), /<canvas/)
const pendingTool = {type:"tool" as const,id:"build",toolKind:"execute",title:"npm run build",input:"{}",output:"",status:"pending"}
assert.equal(agentActivity({...activityBase,blocks:[pendingTool],quietForMs:59_999}).label,"npm run build","a minute of quiet is ordinary")
assert.deepEqual(agentActivity({...activityBase,blocks:[pendingTool],quietForMs:3*60_000+10_000}),{kind:"executing",label:"No output for 3m · npm run build"})
assert.deepEqual(agentActivity({...activityBase,blocks:[{type:"thinking",text:"Weighing"}],quietForMs:65*60_000}),{kind:"reasoning",label:"No output for 1h 5m"})
assert.deepEqual(agentActivity({...activityBase,blocks:[],connecting:true,makingWorktree:true}),{kind:"connecting",label:"Checking out files"},"a checkout made on the spot is named until the provider starts")
assert.equal(agentActivity({...activityBase,blocks:[],connecting:true,makingWorktree:true,worktreeStep:"carry"}).label,"Copying files from your folder","each step the host reports is named")
assert.equal(agentActivity({...activityBase,blocks:[],connecting:true}).label,"Starting","a start says the harness is starting, local or cloud")
assert.equal(agentActivity({...activityBase,blocks:[],connecting:true,starting:startLabel("Codex")}).label,"Starting Codex")
assert.deepEqual(agentActivity({...activityBase,blocks:[{type:"text",text:"Half an ans"}],quietForMs:2*60_000}),{kind:"working",label:"No output for 2m"},
  "a reply that stopped mid-stream stops reading as responding")
assert.equal(agentActivity({...activityBase,blocks:[],quietForMs:120*60_000}).label,"No output for 2h")
assert.equal(agentActivity({...activityBase,waiting:true,blocks:[pendingTool],quietForMs:10*60_000}).label,"Waiting for your approval",
  "a turn waiting on the user is not quiet")
assert.deepEqual(agentActivity({...activityBase,blocks:[pendingTool],native:{kind:"compacting",since:5},quietForMs:3*60_000}),
  {kind:"working",label:"Compacting context",detail:"Making room to continue",since:5},
  "a provider compacting says so, counting from when it began, instead of reading as silent")
assert.deepEqual(agentActivity({...activityBase,blocks:[],native:{kind:"retrying",since:0,attempt:2,maxAttempts:10,reason:"Overloaded (529)",retryAt:9}}),
  {kind:"working",label:"Retrying",detail:"attempt 2 of 10 · Overloaded (529)",since:0,retryAt:9})
assert.equal(agentActivity({...activityBase,blocks:[],native:{kind:"retrying",since:0}}).detail,undefined)
assert.deepEqual(agentActivity({...activityBase,blocks:[],native:{kind:"waiting",since:3,label:"Reviewing the approval"}}),{kind:"working",label:"Reviewing the approval",since:3})
const markerExchange = (...notes: TranscriptEvent[]) => renderToStaticMarkup(<Exchange exchange={{id:"marker",prompt:{id:"marker",role:"user",blocks:[{type:"text",text:"Go"}]},response:[],
  system:notes.map((note,index) => ({after:0,message:{id:`note-${index}`,role:"system",blocks:[{type:"text",text:note.label}],note}}))}} />)
const compactedMarkup = markerExchange({label:"Context compacted",detail:"Automatic · 182k → 24k tokens",body:"## Kept\nThe plan"})
assert.match(compactedMarkup, /Context compacted<\/span><span class="[^"]*">Automatic · 182k → 24k tokens/, "the marker reads its label and detail on one line")
assert.match(compactedMarkup, /<button[^>]*aria-expanded="false"/, "a marker with a body opens onto it")
assert.doesNotMatch(compactedMarkup, /The plan/, "the body stays unmounted until it is opened")
const failedMarkup = markerExchange({label:"Turn failed",detail:"Server overloaded",tone:"error"})
assert.match(failedMarkup, /class="[^"]*text-negative">Turn failed/, "a failure reads in its tone")
assert.doesNotMatch(failedMarkup, /aria-expanded/, "a marker without a body is not a control")
const setupMarkup = markerExchange(mcpServerFailedEvent("linear", "could not connect"), mcpServerFailedEvent("drive", "sign-in required"),
  {label:"Model changed",detail:"gpt-5 → gpt-5-mini"})
assert.match(setupMarkup, /2 MCP servers didn&#x27;t start<\/span><span class="[^"]*">linear, drive</, "setup notices that arrive together read as one line naming the servers")
assert.equal(setupMarkup.match(/aria-expanded/g)?.length, 1, "the setup line opens onto each server; the turn marker beside it stays its own line")
assert.doesNotMatch(setupMarkup, /could not connect/, "each server's reason stays unmounted until the line is opened")
const activeFolder: ThreadFolder = {key:"flage",name:"flage",cwd:"/flage",refs:[],current:false,pinned:false,pinRank:-1,latest:"",order:"",priority:1,running:0,active:1,needsInput:0,failed:0,unread:0}
const folderMarkup = renderToStaticMarkup(<FolderActivity folder={activeFolder} />)
assert.match(folderMarkup, /1 running/)
assert.match(folderMarkup, /running outside this Mako/)
assert.match(folderMarkup, /data-size="20"/)
assert.doesNotMatch(folderMarkup, /1 active|animate-spin|lucide-loader/)
assert.match(renderToStaticMarkup(<FolderActivity folder={{...activeFolder,running:2}} />), /3 running/)
assert.equal(renderToStaticMarkup(<FolderActivity folder={{...activeFolder,active:0}} />), "")
assert.doesNotMatch(renderToStaticMarkup(<FolderActivity folder={{...activeFolder,failed:1}} />), /<canvas/)
assert.match(renderToStaticMarkup(<ThreadStatusMark status={{kind:"external-active"}} />), /data-size="20"/)
const openMarkup = renderToStaticMarkup(<ThreadStatusMark status={{kind:"external-open", app:"codex"}} updatedAt={new Date(Date.now() - 5 * 60_000).toISOString()} />)
assert.doesNotMatch(openMarkup, /<canvas/)
assert.match(openMarkup, /Open in Codex/)
assert.match(openMarkup, />5m</, "the open state keeps the time")

// Commands the provider advertised lead the slash menu, in its own words
// and named by provider — nothing the session did not report is shown.
conversation.session = {
  ...conversation.session,
  commands: [
    { name: "compact", description: "Summarize the conversation so far", hint: "instructions" },
    { name: "review" },
  ],
}
publish()
const commandsMarkup = renderToStaticMarkup(
  <MentionMenu kind="/" leading query="" onPick={() => {}} onDismiss={() => {}} />
)
assert.match(commandsMarkup, /Claude Code commands/)
assert.match(commandsMarkup, /compact/)
assert.match(commandsMarkup, /Summarize the conversation so far/)
const filteredCommands = renderToStaticMarkup(
  <MentionMenu kind="/" leading query="rev" onPick={() => {}} onDismiss={() => {}} />
)
// Mako's own review stands in for the harness's `review`, so "rev" finds
// one review row, Mako's, and no second group repeating it.
assert.match(filteredCommands, /Review changes, a branch or a commit/)
assert.doesNotMatch(filteredCommands, /Claude Code commands/)
assert.doesNotMatch(filteredCommands, /compact/)
const midSentence = renderToStaticMarkup(
  <MentionMenu kind="/" leading={false} query="" onPick={() => {}} onDismiss={() => {}} />
)
assert.doesNotMatch(midSentence, /Claude Code commands|Review changes/, "a / later in a sentence offers skills and MCP, not commands")
conversation.session = { ...conversation.session, commands: undefined }
publish()

// The meter shows what the harness declares it reports (`HarnessUsage`), each
// field filled in by the provider's own reading and never by guessing. Three
// numbers stay apart: what the window holds now, what this conversation's
// turns spent, and the harness's own count for its session.
const meterDescriptors = threadsStore.get().descriptors
threadsStore.set({ descriptors: fixtureHarnesses })
const spentTurn = (spend: TurnSpend, id = "turn"): LiveRequest => ({ id, text: "", attachments: [], status: "completed", spend })
const turnTokens = { input: 1_200, cacheRead: 410_000, cacheWrite: 38_000, output: 9_400, reasoning: 2_100 }
conversation.session = {
  ...conversation.session,
  usage: { used: 164_000, size: 200_000, tokens: turnTokens, cost: { amount: 0.42, currency: "USD" } },
}
conversation.requests = [spentTurn({ provider: "claude", at: 1, tokens: turnTokens, cost: 0.42 })]
publish()
const details = (usage: LiveSessionUsage, harness: string, requests: readonly LiveRequest[] = conversation.requests ?? []) =>
  renderToStaticMarkup(<UsageDetails usage={usage} harness={harness} conversationId={conversation.session.id} requests={requests} />)
const readingMarkup = details(conversation.session.usage!, "claude")
assert.match(readingMarkup, /164k of 200k tokens in the window now/)
assert.match(readingMarkup, />82%</)
assert.match(readingMarkup, /Spent in this conversation/)
assert.match(readingMarkup, /1 turn/)
assert.match(readingMarkup, /Cache read.*410k/)
assert.match(readingMarkup, /Output.*2\.1k reasoning.*9\.4k/)
assert.match(readingMarkup, /Total.*459k/)
assert.match(readingMarkup, /Cost, as Claude Code priced it.*\$0\.42/)
assert.doesNotMatch(readingMarkup, /≈|data-cost-estimate/, "a reported cost is never shown as an estimate")
const meterMarkup = renderToStaticMarkup(<TooltipProvider><ContextMeter /></TooltipProvider>)
assert.match(meterMarkup, /aria-label="Context 82% full"/)
// Spend sums each turn's own record, the running turn as far as it has gone, so a reopened conversation reads the same.
const twoTurns = [
  spentTurn({ provider: "claude", at: 1, tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 }, cost: 0.1 }, "a"),
  { ...spentTurn({ provider: "claude", at: 2 }, "b"), spend: undefined, status: "dispatching" as const, usageFrom: { tokens: { input: 100, cacheRead: 0, cacheWrite: 0, output: 50 }, cost: { amount: 0.1, currency: "USD" } } },
]
const running = details({ used: 1_000, size: 200_000, tokens: { input: 300, cacheRead: 0, cacheWrite: 0, output: 150 }, cost: { amount: 0.25, currency: "USD" } }, "claude", twoTurns)
assert.match(running, /2 turns, one running/)
assert.match(running, /Total.*450/)
assert.match(running, /\$0\.25/)
// Changes made sit beside the spend once the attribution journal counts them; without them, nothing, never a zero.
assert.match(renderToStaticMarkup(<UsageDetails usage={conversation.session.usage!} harness="claude" conversationId={conversation.session.id} requests={conversation.requests ?? []} changes={{ files: 3, added: 120, removed: 40 }} />), /data-changes[^>]*>.*Changes made.*3 files · \+120 −40/)
assert.doesNotMatch(readingMarkup, /data-changes/)
// Side questions are the harness's spend outside the turns: said so, never folded in.
assert.match(renderToStaticMarkup(<UsageDetails usage={conversation.session.usage!} harness="claude" conversationId={conversation.session.id} requests={conversation.requests ?? []} sideQuestions={2} />), /data-side-spend[^>]*>The 2 side questions aren&#x27;t in these totals; Claude Code’s own records count them\./)
// After compaction: a harness that says what is left (Claude) has its next reading; one that
// doesn't (Devin) shows no fill until the next reply, only what the context held before.
const unmeasured = details({ compactedFrom: 164_000, size: 200_000 }, "devin", [])
assert.match(unmeasured, />Compacted</)
assert.match(unmeasured, /data-context-compacted[^>]*>Held 164k of 200k tokens before compacting\. Devin doesn&#x27;t say what a compaction left/)
assert.doesNotMatch(unmeasured, />\d+%<|in the window now/, "no number of the old context passes for the new one")
// Before the first reply, a harness that measures says when it will, never that it can't.
const pending = details({}, "claude", [])
assert.match(pending, />After the first reply</)
assert.match(pending, /Claude Code reports how full the context is after each reply\./)
assert.match(pending, /Counted after the first reply\./)
// A harness that declares no fill says why, in its own declaration's words, and why it shows no cost. All six
// measure their context now, so a stand-in declares it absent.
const measuredDescriptors = threadsStore.get().descriptors
const cursorDescriptor = measuredDescriptors.find((entry) => entry.provider === "cursor")!
threadsStore.set({
  descriptors: [...measuredDescriptors, {
    ...cursorDescriptor, provider: "unmeasured", displayName: "Unmeasured",
    usage: { ...cursorDescriptor.usage!, context: harnessLacks("Unmeasured reports what each turn spent, never how full the context is."), cost: harnessLacks("Unmeasured reports tokens only and prices none of them.") },
  }],
})
const unmeasuredTurn = [spentTurn({ provider: "unmeasured", at: 1, tokens: { input: 900, cacheRead: 40_000, cacheWrite: 0, output: 1_000 } })]
const spendOnly = details({}, "unmeasured", unmeasuredTurn)
assert.match(spendOnly, />Not reported</)
assert.match(spendOnly, /data-context-unmeasured[^>]*>Unmeasured reports what each turn spent, never how full the context is\./)
assert.match(spendOnly, /data-cost-unreported[^>]*>Unmeasured reports tokens only and prices none of them\./)
assert.doesNotMatch(spendOnly, /Cache write/)
assert.doesNotMatch(readingMarkup, /data-unrecorded-spend|data-cost-unreported/, "complete, priced spend carries no note")
// Mako's estimate for a harness that prices nothing: marked, named as list prices with its table, never the harness's cost.
const estimated = details({}, "codex", [spentTurn({ provider: "codex", at: 1, tokens: { input: 900, cacheRead: 40_000, cacheWrite: 0, output: 1_000 }, estimate: { amount: 0.031, currency: "USD", table: "2026-10-06" } })])
assert.match(estimated, /data-cost-estimate[^>]*>.*Cost at API list prices.*≈ \$0\.03/)
assert.match(estimated, /title="Estimated by Mako from API list prices read 2026-10-06/)
assert.match(estimated, /Codex reports tokens only and prices none of them\. The estimate is Mako&#x27;s, from list prices\./)
// A harness that says its count left spend out (Grok): the totals are said to be floors, the cost alone when only it is.
const grokTurn = (unrecorded: "tokens" | "cost") => [spentTurn({ provider: "grok", at: 1, tokens: { input: 900, cacheRead: 40_000, cacheWrite: 0, output: 1_000 }, cost: 0.03, unrecorded })]
assert.match(details({}, "grok", grokTurn("tokens")), /data-unrecorded-spend[^>]*>Grok left some calls out of its usage count, so these totals may be low\./)
assert.match(details({}, "grok", grokTurn("cost")), /Grok didn&#x27;t report the cost of every call, so the cost may be low\./)
// What a harness declares it doesn't report never shows, whatever arrives: Codex prices nothing and never says it missed calls.
const undeclared = details({}, "codex", [spentTurn({ provider: "codex", at: 1, tokens: { input: 900, cacheRead: 40_000, cacheWrite: 0, output: 1_000 }, cost: 0.03, unrecorded: "tokens" })])
assert.doesNotMatch(undeclared, /\$0\.03|data-unrecorded-spend/)
assert.match(undeclared, /Codex reports tokens only and prices none of them\./)
// The harness's own count for its session stands apart, said to include turns outside Mako.
const native = details({ used: 1_000, size: 200_000, native: { tokens: { input: 5_000, cacheRead: 90_000, cacheWrite: 0, output: 5_000 }, cost: 1.5 } }, "opencode", [])
assert.match(native, /data-harness-total[^>]*>.*OpenCode’s own count for this session.*100k.*\$1\.50.*It includes turns run outside Mako\./)
const readingUsage = conversation.session.usage
const readingRequests = conversation.requests
conversation.harness = "unmeasured"
conversation.session = { ...conversation.session, harness: "unmeasured", usage: { tokens: { input: 900, cacheRead: 40_000, cacheWrite: 0, output: 1_000 } } }
publish()
const spendOnlyMeter = renderToStaticMarkup(<TooltipProvider><ContextMeter /></TooltipProvider>)
assert.match(spendOnlyMeter, /aria-label="Context fill not reported"/)
assert.match(spendOnlyMeter, /data-unmeasured-ring/)
threadsStore.set({ descriptors: measuredDescriptors })
conversation.harness = "devin"
conversation.session = { ...conversation.session, harness: "devin", usage: { compactedFrom: 164_000, size: 200_000 } }
publish()
const compactedMeter = renderToStaticMarkup(<TooltipProvider><ContextMeter /></TooltipProvider>)
assert.match(compactedMeter, /aria-label="Context compacted, measured after the next reply"/)
assert.match(compactedMeter, /data-context-compacted/)
conversation.harness = "claude"
conversation.session = { ...conversation.session, harness: "claude", usage: undefined }
publish()
const pendingMeter = renderToStaticMarkup(<TooltipProvider><ContextMeter /></TooltipProvider>)
assert.match(pendingMeter, /aria-label="Context measured after the first reply"/, "a harness that measures shows its meter before the first reading")
assert.match(pendingMeter, /data-context-ring/)
conversation.session = { ...conversation.session, usage: readingUsage }
conversation.requests = readingRequests
threadsStore.set({ descriptors: meterDescriptors })
publish()
console.log("Activity feedback: contextual recovery, distinct main states, tuned inline project/thread orbs, idle cleanup, and explicit external-running labels verified")
