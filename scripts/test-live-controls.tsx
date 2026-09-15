import { ProposedPlanCard } from "../src/components/transcript/proposed-plan"
import { Exchange } from "../src/components/transcript/exchange"
import { Prose } from "../src/components/transcript/markdown"
import { RetainedRequests } from "../src/components/viewer/acp-panel"
import { recoverableRequests } from "../src/state/prompt-delivery"
import { agentActivity } from "../src/state/agent-activity"
import { cn } from "../src/lib/utils"
import { ActivityMark } from "../src/components/ui/activity-mark"
import { FolderActivity } from "../src/components/rail/rail-activity"
import { ThreadStatusMark } from "../src/components/rail/thread-status"
import type { ThreadFolder } from "../src/lib/thread-folders"
import { AttachmentStrip, InlineAttachment } from "../src/components/composer/attachments"
import { MentionMenu } from "../src/components/composer/mention-menu"
import type { Attachment } from "../src/lib/attachments"
import { projectDraftKey } from "../src/state/drafts"
import { TranscriptSourceContext } from "../src/components/transcript/source-context"
import { draftPlanReply } from "../src/state/plans"
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
import { AccessModeList, ContextReading, LiveComposerControls, NextSessionModePicker } from "../src/components/composer/live-controls"
import { threadsStore } from "../src/state/threads"
import { TransferStatus } from "../src/components/viewer/transfer-status"
import { ConversationRelations } from "../src/components/viewer/conversation-relations"

const id = "11111111-1111-4111-8111-111111111111"
const control: NonNullable<LiveAcpConversation["control"]> = {
  activeBindingId: id,
  bindings: [],
  children: [],
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
conversation.permission = null
conversation.session = { ...conversation.session, status: "ready", connection: "connected" }
// The access picker shows one ladder: tier labels in tier order, the
// provider's own name beside them, and who enforces a host-made tier.
threadsStore.set({
  descriptors: [{ provider: "claude", displayName: "Claude Code", resumable: true, live: true, canResume: true, canSteer: true, steering: "step", canCompact: true }],
})
conversation.session = {
  ...conversation.session,
  currentMode: "access:full",
  modes: [
    { id: "agent", name: "Agent", access: "ask", enforcement: "provider" },
    { id: "plan", name: "Plan", access: "plan", enforcement: "provider" },
    { id: "access:full", name: "Full access", access: "full", enforcement: "host" },
    { id: "access:auto", name: "Auto review", access: "auto", enforcement: "launch" },
    { id: "verbose", name: "Verbose", description: "Provider-only switch" },
  ],
}
publish()
const triggerMarkup = renderToStaticMarkup(<LiveComposerControls canCompact={false} compactEnabled={false} />)
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
assert.match(controlsMarkup, /Mako approves the agent&#x27;s requests/)
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
const singleModeMarkup = renderToStaticMarkup(<LiveComposerControls canCompact={false} compactEnabled={false} />)
assert.match(singleModeMarkup, /aria-label="Access: Full access"/)
assert.doesNotMatch(singleModeMarkup, /<button[^>]*aria-label="Access:/)
threadsStore.set({
  descriptors: [{ provider: "cursor", displayName: "Cursor", resumable: true, live: true, canResume: false, modes: conversation.session.modes }],
  composerHarness: "cursor",
})
const nextSessionMarkup = renderToStaticMarkup(<NextSessionModePicker />)
assert.match(nextSessionMarkup, /aria-label="Access: Full access"/)
assert.doesNotMatch(nextSessionMarkup, /<button/)
// A provider with a declared default reports that level before any choice:
// an unchosen session runs under it, so the chip names it.
threadsStore.set({
  descriptors: [{
    provider: "grok",
    displayName: "Grok",
    resumable: true,
    live: true,
    canResume: true,
    modes: [
      { id: "access:plan", name: "Plan", access: "plan", enforcement: "launch" },
      { id: "access:deny", name: "Deny unapproved", access: "deny", enforcement: "launch" },
      { id: "access:auto", name: "Auto review", access: "auto", enforcement: "launch" },
      { id: "access:full", name: "Full access", access: "full", enforcement: "launch" },
    ],
    defaultMode: "access:deny",
  }],
  composerHarness: "grok",
})
const defaultedMarkup = renderToStaticMarkup(<NextSessionModePicker />)
assert.match(defaultedMarkup, /aria-label="Access: Deny unapproved"/)
// The thread's own remembered level still outranks the provider default.
threadsStore.set({
  viewing: {
    ref: { harness: "grok", nativeId: "ses", path: "/tmp/ses.jsonl", accessMode: "access:full" },
    entries: [],
  },
})
const rememberedMarkup = renderToStaticMarkup(<NextSessionModePicker />)
assert.match(rememberedMarkup, /aria-label="Access: Full access"/)
threadsStore.set({ viewing: null })
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
assert.match(renderToStaticMarkup(<LiveActionStatus />), /Compaction accepted/)
control.actions[0]!.state = {
  kind: "uncertain",
  reason: "Connection lost after dispatch",
}
publish()
assert.match(
  renderToStaticMarkup(<LiveActionStatus />),
  /Disconnect and keep history/
)
assert.match(
  renderToStaticMarkup(<LiveActionStatus />),
  /Connection lost after dispatch/
)
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
assert.match(renderToStaticMarkup(<TransferStatus />), /saved request/)
control.ancestry = {
  kind: "fork",
  parentId: id,
  sourceRevision: 1,
  point: "before",
}
publish()
const relations = renderToStaticMarkup(<ConversationRelations />)
assert.match(relations, />Delegate</)
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
assert.match(row, /2 tools used/)
assert.match(row, /aria-expanded="false"/)
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
  <TranscriptSourceContext value={{ liveId: id }}>
    <ProposedPlanCard plan={proposal} />
  </TranscriptSourceContext>
)
assert.match(planCard, /Route recovery/)
assert.match(planCard, /Draft implementation/)
assert.match(planCard, /aria-expanded="false"/)
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
assert.match(inline, /\[Screenshot.png\]/)
assert.doesNotMatch(inline, /<button|Remove|role="button"/)
const previews = renderToStaticMarkup(<AttachmentStrip items={[screenshot, clip]} onRemove={() => {}} />)
assert.match(previews, /<img/)
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
const files = [{index:1, name:"Screenshot.png", path:"/retained/Screenshot.png"}]
const references = renderToStaticMarkup(<Prose text="Use **@src/file.ts** with [Screenshot.png] and $review." references={files} />)
assert.match(references, /Open src\/file.ts/)
assert.match(references, /Open \/retained\/Screenshot.png/)
assert.match(references, /Skill: review/)
const literal = renderToStaticMarkup(<Prose text={'```text\n@src/file.ts [Screenshot.png]\n```'} references={files} />)
assert.doesNotMatch(literal, /Open src\/file.ts|Open \/retained\/Screenshot.png/)
const screenshotName = "CleanShot 2026-09-09 at 1.01.59 AM@2x.png"
const namedScreenshot = renderToStaticMarkup(<Exchange exchange={{id:"named-shot", prompt:{id:"named-shot",role:"user",blocks:[{type:"text",text:`[${screenshotName}]`},{type:"attachment",name:screenshotName,mimeType:"image/png",source:{kind:"file",path:"/retained/shot.png"}}]},response:[],system:[]}} />)
assert.match(namedScreenshot, /Open \/retained\/shot.png/)
assert.doesNotMatch(namedScreenshot, /mailto:/)
console.log("Prompt Markdown: the reported bullet/bold case, normal paragraph flow, copy controls, rich references, screenshot names with @2x, and literal code verified")
conversation.blocks = [{type:"user",requestId:"stopped",text:"Keep this original question"}]
conversation.requests = [{id:"stopped",text:"Keep this original question",attachments:[],status:"interrupted"}]
publish()
assert.equal(renderToStaticMarkup(<RetainedRequests />), "")
assert.equal(recoverableRequests(conversation).length, 0)
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
// Mako's own continuation is drawn as Mako's line where the prompt would be,
// not as the user's bubble; the words it sent are not shown as theirs.
const continuedMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange
      continues={{ requestId: "stopped", reason: "connection-lost", auto: true }}
      exchange={{ ...stoppedExchange, id: "continued", prompt: { ...stoppedExchange.prompt, id: "continued", requestId: "continued", timestamp: 1_700_000_000_000, blocks: [{ type: "text" as const, text: "Continue where you left off." }] } }}
    />
  </TranscriptSourceContext>
)
assert.match(continuedMarkup, /data-turn-continued="connection-lost"/)
assert.match(continuedMarkup, /Mako continued the turn after the connection to Claude Code dropped/)
assert.doesNotMatch(continuedMarkup, /Continue where you left off/, "the continuation prompt is not shown as the user's words")
assert.doesNotMatch(continuedMarkup, /Copy question/)
// A continuation the user sent by pressing the button is their prompt and stays one.
const manualMarkup = renderToStaticMarkup(
  <TranscriptSourceContext value={{ liveId: conversation.key }}>
    <Exchange continues={{ requestId: "stopped", reason: "connection-lost", auto: false }} exchange={stoppedExchange} />
  </TranscriptSourceContext>
)
assert.match(manualMarkup, /Keep this original question/)
assert.doesNotMatch(manualMarkup, /data-turn-continued/)
conversation.requests.push({id:"unsent",text:"Do not lose a pre-dispatch stop",attachments:[],status:"interrupted"})
conversation.requests.push({id:"failed",text:"Failed input remains recoverable",attachments:[],status:"failed"})
publish()
const recoveries = renderToStaticMarkup(<RetainedRequests />)
assert.match(recoveries, /Do not lose a pre-dispatch stop/)
assert.match(recoveries, /Failed input remains recoverable/)
assert.doesNotMatch(recoveries, /<details[^>]+open|Keep this original question|Message interrupted/)
assert.match(recoveries, /Send again/, "an unclassified failure still offers Send again")
// A classified failure is described for the provider and offers Send again
// only when a repeat can work.
conversation.requests.push({id:"rejected",text:"Once more",attachments:[],status:"failed",failure:"transcript-rejected",error:"reasoning encrypted_content was not issued to this caller"})
conversation.requests.push({id:"quit-unsent",text:"Cut short before it ran",attachments:[],status:"interrupted",interruption:{reason:"host-quit",at:1}})
publish()
const classified = renderToStaticMarkup(<RetainedRequests />)
assert.match(classified, /data-failure="transcript-rejected"/)
assert.match(classified, /Claude Code&#x27;s session history was rejected by its model provider/)
assert.match(classified, /Start a new Claude Code thread/)
assert.match(classified, /encrypted_content was not issued/, "the provider's own text stays readable")
assert.match(classified, /Interrupted when Mako quit\. Review saved message/)
assert.equal((classified.match(/Send again/g) ?? []).length, 1, "only the retriable failure offers Send again")
conversation.requests.splice(-2, 2)
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
const activeFolder: ThreadFolder = {key:"flage",name:"flage",cwd:"/flage",refs:[],current:false,pinned:false,latest:"",order:"",priority:1,running:0,active:1,needsInput:0,failed:0,unread:0}
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
  <MentionMenu kind="/" query="" onPick={() => {}} onDismiss={() => {}} />
)
assert.match(commandsMarkup, /Claude Code commands/)
assert.match(commandsMarkup, /compact/)
assert.match(commandsMarkup, /Summarize the conversation so far/)
const filteredCommands = renderToStaticMarkup(
  <MentionMenu kind="/" query="rev" onPick={() => {}} onDismiss={() => {}} />
)
assert.match(filteredCommands, /Claude Code commands/)
assert.match(filteredCommands, /rev/)
assert.doesNotMatch(filteredCommands, /compact/)
conversation.session = { ...conversation.session, commands: undefined }
publish()

// The provider's own context reading says what the window holds, in the
// provider's numbers only — nothing is shown until it reports.
conversation.session = {
  ...conversation.session,
  usage: { used: 164_000, size: 200_000, cost: { amount: 0.42, currency: "USD" } },
}
publish()
const readingMarkup = renderToStaticMarkup(
  <ContextReading usage={conversation.session.usage!} />
)
assert.match(readingMarkup, /164k of 200k tokens/)
assert.match(readingMarkup, /82% of the window/)
assert.match(readingMarkup, /\$0\.42 so far/)
console.log("Activity feedback: contextual recovery, distinct main states, tuned inline project/thread orbs, idle cleanup, and explicit external-running labels verified")
