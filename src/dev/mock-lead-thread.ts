import type { LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import { childEntry, ROLE_WORD, type ChildJournal, type ChildState, type ChildThread, type ThreadParent } from "@mako/host/contracts/agents"
import { BRIEF_CLOSE, briefIntro, fromAgent, rollup, rosterChildren } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadRef } from "@/lib/types"

/*
 * A lead and its Threads for the desk's and the phone's fixtures (`?mock&app=lead`): "Mobile lead", a Claude Thread
 * whose turn runs while twelve children stand in every state, two of them on the person, one asking its lead, two
 * queued. Each started child has its own live conversation, listed with its edge (`parent`) as the host lists it, so
 * the rail's filter is what keeps it out of the list; one waits on an approval.
 */

export const LEAD_THREAD = "1ead1ead-0000-4000-8000-000000001ead"
export const LEAD_SESSION = "1ead1ead-1000-4000-8000-000000001ead"
export const LEAD_CONVERSATION = "1ead1ead-2000-4000-8000-000000001ead"
export const LEAD_TITLE = "Mobile lead"
export const LEAD_CWD = "/Users/you/mako"
const STARTED = Date.now() - 52 * 60_000

interface ChildFixture {
  name: string
  title: string
  harness: string
  model: string
  state: ChildState
  minutes: number
  toolUses?: number
  objective: string
  said?: string
}

/** The twelve, as the prototype has them: 2 need you, 5 working (one asking its lead), 2 queued, 3 done. */
const CHILDREN: ChildFixture[] = [
  { name: "push-wording", title: "Quiet-hours push wording", harness: "codex", model: "gpt-5.6-sol", state: { kind: "blocked", on: "person", question: "Which tone for the quiet-hours notice? Plain or friendly?" }, minutes: 14, toolUses: 22, objective: "Write the quiet-hours notice the phone shows when pushes are held, in both tones, and ask which one ships." },
  { name: "sheet-motion", title: "Sheet motion on iPad", harness: "cursor", model: "composer-2.5", state: { kind: "blocked", on: "approval", question: "Run npm ci with network access" }, minutes: 22, toolUses: 41, objective: "Make the sheet's open and close motion match the iPad's split view, on the composer branch. Done when the sheet case passes on an iPad in both themes. Report with what you changed and the shots.", said: "The sheet animates from its own height, so in split view it starts off screen. I'll measure the container instead, then run the iPad case." },
  { name: "composer-chips", title: "Composer chips on iPad", harness: "claude", model: "claude-opus-5-5", state: { kind: "working", phase: "Running the iPad cases", step: "Shell npm run test:phone" }, minutes: 18, toolUses: 64, objective: "Make the composer's chips wrap on an iPad the way they do on a Mac." },
  { name: "dictation", title: "Dictation fallback", harness: "codex", model: "gpt-5.6-sol", state: { kind: "working", step: "Edit src/web-client/dictation.ts" }, minutes: 11, toolUses: 30, objective: "When the recognizer is unavailable, fall back to the keyboard's dictation without an error." },
  { name: "token-refresh", title: "Push token refresh", harness: "grok", model: "grok-4.7", state: { kind: "blocked", on: "lead", question: "Should an expired token be dropped or retried once?" }, minutes: 9, toolUses: 12, objective: "Refresh a phone's push token when the platform rotates it, without a second registration." },
  { name: "outbox", title: "Offline outbox retry", harness: "opencode", model: "kimi-k3", state: { kind: "working", step: "Read src/web-client/outbox.ts" }, minutes: 6, toolUses: 8, objective: "Retry the outbox once the page is back online, oldest first." },
  { name: "hunks", title: "Review screen hunks", harness: "devin", model: "swe-2", state: { kind: "starting", step: "launching" }, minutes: 0.4, objective: "Read the review screen's hunks from the record instead of the file." },
  { name: "haptics", title: "Haptics audit", harness: "claude", model: "claude-sonnet-5-5", state: { kind: "queued", reason: "tree-running", ahead: 0 }, minutes: 0, objective: "List every haptic the phone plays and where." },
  { name: "share-sheet", title: "Share sheet copy", harness: "cursor", model: "composer-2.5", state: { kind: "queued", reason: "tree-running", ahead: 1 }, minutes: 0, objective: "Word the share sheet's actions in the app's copy style." },
  { name: "swipe", title: "Thread list swipe", harness: "codex", model: "gpt-5.6-sol", state: { kind: "ended", outcome: "done", reason: "Swipe to archive now springs back below the threshold; PR on your branch." }, minutes: 31, toolUses: 52, objective: "Make the list's swipe to archive spring back below its threshold." },
  { name: "deep-links", title: "Settings deep links", harness: "claude", model: "claude-opus-5-5", state: { kind: "idle" }, minutes: 27, toolUses: 19, objective: "Open each settings page from a link." },
  { name: "pull-refresh", title: "Pull to refresh", harness: "grok", model: "grok-4.7", state: { kind: "ended", outcome: "done", reason: "Pull to refresh reads the account list again and keeps its place." }, minutes: 40, toolUses: 33, objective: "Pull to refresh reads the account list again." },
]

function childThread(index: number): string {
  return `1ead1ead-3000-4000-8000-${String(index + 1).padStart(12, "0")}`
}
function childSession(index: number): string {
  return `1ead1ead-4000-4000-8000-${String(index + 1).padStart(12, "0")}`
}
function childConversation(index: number): string {
  return `1ead1ead-5000-4000-8000-${String(index + 1).padStart(12, "0")}`
}

/** Whether the child has started: a queued one has no conversation yet. */
function started(fixture: ChildFixture): boolean {
  return fixture.state.kind !== "queued"
}

/** What a child's Thread shows and its journal holds, for `childState` to read a state back from. */
interface ChildShowing {
  thread: Partial<ChildThread>
  journal: ChildJournal
}

function shown(state: ChildState, child: string, at: number): ChildShowing {
  switch (state.kind) {
    case "queued":
      return { thread: { queued: { reason: state.reason, ahead: state.ahead } }, journal: {} }
    case "starting":
      return { thread: { starting: state.step }, journal: {} }
    case "working":
      return {
        thread: { working: true, ...(state.step && { step: state.step }) },
        journal: state.phase ? { latest: { id: `report:${child}:phase`, child: ThreadIdSchema.parse(child), status: "progress", summary: state.phase, ownerGeneration: 1, at } } : {},
      }
    case "blocked":
      return { thread: { waiting: { question: state.question, on: state.on } }, journal: {} }
    case "idle":
      return { thread: {}, journal: {} }
    case "ended":
      return { thread: { ended: { outcome: state.outcome, ...(state.reason && { reason: state.reason }), at } }, journal: {} }
  }
}

/** One child's roster entry, made by `childEntry` from its edge and what its Thread shows, as the host makes it. */
export function leadChild(index: number, state: ChildState = CHILDREN[index]!.state): NativeAgent {
  const fixture = CHILDREN[index]!
  const now = Date.now()
  const createdAt = now - fixture.minutes * 60_000
  const child = childThread(index)
  const lead = SessionIdSchema.parse(LEAD_SESSION)
  const edge: ThreadParent = {
    child: ThreadIdSchema.parse(child),
    parent: ThreadIdSchema.parse(LEAD_THREAD),
    parentSession: lead,
    name: fixture.name,
    role: "worker",
    origin: "started",
    asked: { brief: { objective: fixture.objective }, harness: fixture.harness, model: fixture.model },
    op: `start:${LEAD_SESSION}:${fixture.name}`,
    startedBy: { kind: "agent", session: lead },
    createdAt,
  }
  const { thread, journal } = shown(state, child, now - 60_000)
  return childEntry(
    edge,
    {
      source: "live",
      title: fixture.title,
      harness: fixture.harness,
      model: fixture.model,
      startedAt: createdAt,
      updatedAt: now,
      ...(fixture.toolUses && { toolUses: fixture.toolUses }),
      ...(started(fixture) && { session: SessionIdSchema.parse(childSession(index)), conversation: childConversation(index), nativeId: `lead-child-${index}`, path: `/mock/lead-child-${index}.jsonl` }),
      ...thread,
    },
    journal
  )
}

export function leadChildren(): NativeAgent[] {
  return CHILDREN.map((_, index) => leadChild(index))
}

/** How many children the scene has, for the bench's churn. */
export const LEAD_CHILD_COUNT = CHILDREN.length

/** The states a churned child steps through, one a tick, as a real one moves. */
export const CHURN: ChildState[] = [
  { kind: "working", step: "Read src/web-client/thread.tsx" },
  { kind: "working", step: "Shell npm run test:phone" },
  { kind: "blocked", on: "lead", question: "Which branch should this land on?" },
  { kind: "working", phase: "Writing the report" },
  { kind: "blocked", on: "person", question: "Allow network access for npm ci?" },
  { kind: "ended", outcome: "done", reason: "Done." },
  { kind: "queued", reason: "tree-running", ahead: 0 },
]

/** A child of `count` for the bench: the twelve repeated, each its own Thread. */
export function benchChild(index: number, state: ChildState): NativeAgent {
  const base = leadChild(index % CHILDREN.length, state)
  const thread = `1ead1ead-6000-4000-8000-${String(index + 1).padStart(12, "0")}`
  return { ...base, nativeId: `mako-child:${thread}`, title: `${base.title} ${index + 1}`, child: { ...base.child!, thread } }
}

/** The bench's rail: `count` leads over ten folders, each with `children` Threads not yet started, in every state. */
interface BenchLeads {
  snapshots: LiveSnapshot[]
  summaries: LiveSummary[]
  refs: ThreadRef[]
}

export function benchLeads(count: number, children: number): BenchLeads {
  const snapshots: LiveSnapshot[] = []
  const summaries: LiveSummary[] = []
  const refs: ThreadRef[] = []
  const at = new Date().toISOString()
  for (let lead = 0; lead < count; lead++) {
    const id = (group: string) => `1ead1ead-${group}-4000-8000-${String(lead + 1).padStart(12, "0")}`
    const thread = id("9000")
    const session = id("a000")
    const conversation = id("b000")
    const cwd = `/Users/you/bench-${lead % 10}`
    const title = `Lead ${lead + 1}`
    const agents = Array.from({ length: children }, (_, index): NativeAgent => {
      const base = leadChild(index % CHILDREN.length, CHURN[(lead + index) % CHURN.length]!)
      const child = `1ead1ead-c000-4000-8${lead.toString(16).padStart(3, "0")}-${String(index + 1).padStart(12, "0")}`
      refs.push({ harness: base.provider, nativeId: `bench-child-${lead}-${index}`, path: `/mock/bench-child-${lead}-${index}.jsonl`, cwd, title: `${base.title} ${index + 1}`, updatedAt: at, threadId: child, parent: { thread, session } })
      return { ...base, nativeId: `mako-child:${child}`, title: `${base.title} ${index + 1}`, child: { thread: child, origin: "started", state: base.child!.state } }
    })
    const snapshot: LiveSnapshot = {
      session: { id: conversation, harness: "claude", nativeId: `bench-lead-${lead}`, cwd, title, connection: "connected", status: lead % 3 === 0 ? "running" : "ready", modes: [], currentMode: "default", configOptions: [] },
      revision: 1,
      createdAt: STARTED,
      threadPath: `/mock/bench-lead-${lead}.jsonl`,
      threadId: thread,
      sessionId: session,
      base: null,
      permissions: [],
      requests: [],
      blocks: [{ type: "text", text: "Reading the digest." }],
      control: { activeBindingId: conversation, bindings: [], merges: [], transfers: [], actions: [] },
      nativeAgents: { agents, limited: false },
    }
    snapshots.push(snapshot)
    const rolled = rollup(rosterChildren(snapshot.nativeAgents))
    summaries.push({ session: snapshot.session, revision: 1, createdAt: STARTED, threadPath: snapshot.threadPath, threadId: thread, sessionId: session, children: rolled })
    refs.push({ harness: "claude", nativeId: `bench-lead-${lead}`, path: snapshot.threadPath!, cwd, title, updatedAt: new Date(Date.now() - lead * 60_000).toISOString(), threadId: thread, sessionId: session, bytes: 4_000 })
  }
  return { snapshots, summaries, refs }
}

function brief(fixture: ChildFixture): string {
  return [fromAgent(`your ${ROLE_WORD}`), briefIntro(fixture.name), "", fixture.objective, "", BRIEF_CLOSE].join("\n")
}

/** The lead's own conversation: its turn running, its roster the twelve. */
export function leadSnapshot(): LiveSnapshot {
  const request = { id: "1ead1ead-7000-4000-8000-000000000001", createdAt: STARTED, text: "Split the phone polish list into Threads and see them through. Ask me only for what you can't decide.", attachments: [], status: "dispatching" as const }
  return {
    session: {
      id: LEAD_CONVERSATION,
      harness: "claude",
      nativeId: "lead-native",
      cwd: LEAD_CWD,
      title: LEAD_TITLE,
      connection: "connected",
      status: "running",
      modes: [
        { id: "acceptEdits", name: "Accept edits", access: "ask" },
        { id: "bypassPermissions", name: "Full access", access: "full" },
      ],
      currentMode: "acceptEdits",
      configOptions: [],
    },
    revision: 1,
    createdAt: STARTED,
    threadPath: "/mock/lead.jsonl",
    threadId: LEAD_THREAD,
    sessionId: LEAD_SESSION,
    base: null,
    permissions: [],
    requests: [request],
    blocks: [
      { type: "user", text: request.text, requestId: request.id },
      { type: "text", text: "Twelve pieces, each its own Thread. I'll start them as the tree allows and read their reports as they come." },
      { type: "tool", id: "lead-start", toolKind: "other", title: "agents_start ×12", input: "{}", output: "started 10, queued 2", status: "completed" },
      { type: "text", text: "Reading the digest." },
    ],
    control: { activeBindingId: LEAD_CONVERSATION, bindings: [], merges: [], transfers: [], actions: [] },
    nativeAgents: { agents: leadChildren(), limited: false },
  }
}

/** A started child's own conversation: its brief from the lead, its work, and for one an approval waiting. */
export function leadChildSnapshot(index: number): LiveSnapshot {
  const fixture = CHILDREN[index]!
  const createdAt = Date.now() - fixture.minutes * 60_000
  const request = { id: `1ead1ead-8000-4000-8000-${String(index + 1).padStart(12, "0")}`, createdAt, text: brief(fixture), attachments: [], status: fixture.state.kind === "working" || fixture.state.kind === "blocked" ? ("dispatching" as const) : ("completed" as const) }
  const waits = fixture.state.kind === "blocked" && fixture.state.on === "approval"
  return {
    session: {
      id: childConversation(index),
      harness: fixture.harness,
      nativeId: `lead-child-${index}`,
      cwd: `${LEAD_CWD}/.mako/worktrees/${fixture.name}`,
      title: fixture.title,
      connection: "connected",
      status: request.status === "dispatching" ? "running" : "ready",
      modes: [{ id: "default", name: "Ask", access: "ask" }],
      currentMode: "default",
      configOptions: [],
    },
    revision: 1,
    createdAt,
    threadPath: `/mock/lead-child-${index}.jsonl`,
    threadId: childThread(index),
    sessionId: childSession(index),
    parent: { thread: LEAD_THREAD, session: LEAD_SESSION },
    base: null,
    permissions: waits
      ? [{ id: `lead-approval-${index}`, sessionId: childConversation(index), title: "npm ci", kind: "execute", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Allow for this Thread", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }]
      : [],
    requests: [request],
    blocks: [
      { type: "user", text: request.text, requestId: request.id },
      { type: "text", text: fixture.said ?? `Starting on it: ${fixture.objective.charAt(0).toLowerCase()}${fixture.objective.slice(1)}` },
      { type: "tool", id: `lead-child-read-${index}`, toolKind: "read", title: "Read src/web-client/sheet.tsx", input: "{\"path\":\"src/web-client/sheet.tsx\"}", output: "export function Sheet() {}", status: "completed" },
      ...(waits ? [{ type: "tool" as const, id: `lead-child-ci-${index}`, toolKind: "execute" as const, title: "npm ci", input: "{\"command\":\"npm ci\"}", status: "pending" as const }] : []),
      ...(fixture.state.kind === "ended" && fixture.state.reason ? [{ type: "text" as const, text: fixture.state.reason }] : []),
    ],
    control: { activeBindingId: childConversation(index), bindings: [], merges: [], transfers: [], actions: [] },
  }
}

/** Every conversation of the scene, the lead's last: the one a window opens on. */
export function leadSnapshots(): LiveSnapshot[] {
  return [...CHILDREN.flatMap((fixture, index) => (started(fixture) ? [leadChildSnapshot(index)] : [])), leadSnapshot()]
}

/** As the desktop's host lists them at boot: each child with its edge, as `placement` gives it. */
export function leadSummaries(): LiveSummary[] {
  return leadSnapshots().map(({ session, revision, createdAt, threadPath, threadId, sessionId, parent, nativeAgents }) => {
    const children = rollup(rosterChildren(nativeAgents))
    return { session, revision, createdAt, threadPath, threadId, sessionId, ...(parent && { parent }), ...(children.total && { children }) }
  })
}

/** The catalog's rows: the lead's, and each started child's under it (`parent`), which the rail never lists. */
export function leadRefs(): ThreadRef[] {
  const lead: ThreadRef = { harness: "claude", nativeId: "lead-native", path: "/mock/lead.jsonl", cwd: LEAD_CWD, title: LEAD_TITLE, updatedAt: new Date().toISOString(), startedAt: new Date(STARTED).toISOString(), threadId: LEAD_THREAD, sessionId: LEAD_SESSION, bytes: 20_000 }
  const children = CHILDREN.flatMap((fixture, index): ThreadRef[] =>
    started(fixture)
      ? [{ harness: fixture.harness, nativeId: `lead-child-${index}`, path: `/mock/lead-child-${index}.jsonl`, cwd: `${LEAD_CWD}/.mako/worktrees/${fixture.name}`, title: fixture.title, updatedAt: new Date().toISOString(), threadId: childThread(index), sessionId: childSession(index), parent: { thread: LEAD_THREAD, session: LEAD_SESSION } }]
      : [])
  return [lead, ...children]
}
