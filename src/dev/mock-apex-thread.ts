import type { LiveRequest, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import type { Entry } from "@mako/sessions/entries"
import { childEntry, type ChildJournal, type ChildState, type ChildThread, type FinRerouted, type ThreadParent } from "@mako/host/contracts/agents"
import { movedLine, type FallbackStep } from "@mako/host/contracts/fin-fallback"
import { harnessLabel } from "@/lib/harness-label"
import type { FinTuningWords } from "@mako/host/contracts/fin-tuning"
import { BRIEF_CLOSE, briefIntro, fromAgent, FROM_AGENTS, PASSED_ON_NOTE, passedOn, rollup, rosterChildren, YOUR_APEX } from "@mako/host/contracts/children"
import { appendFinReports } from "@mako/host/contracts/fin-reports"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { SessionIdSchema, ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import type { ThreadRef } from "@/lib/types"

/*
 * An Apex and its Fins for the desk's and the phone's fixtures (`?mock&app=apex`): "Mobile polish", a Claude Thread
 * whose turn runs while twelve Fins stand in every state, two of them on the person, one asking its Apex, two
 * queued. Each started Fin has its own live conversation, listed with its edge (`parent`) as the host lists it, so
 * the rail's filter is what keeps it out of the list; one waits on an approval.
 */

export const APEX_THREAD = "1ead1ead-0000-4000-8000-000000001ead"
export const APEX_SESSION = "1ead1ead-1000-4000-8000-000000001ead"
export const APEX_CONVERSATION = "1ead1ead-2000-4000-8000-000000001ead"
export const APEX_TITLE = "Mobile polish"
export const APEX_CWD = "/Users/you/mako"
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
  /** It runs on another device (`&placed=`): its Apex's device has its edge and its reports, and no conversation of it. */
  placed?: true
}

/**
 * `&placed=<scene>`: a thirteenth Fin, Docs sweep, placed on another device of the person's, Loft, where its OpenCode
 * asks to run a command. Its Apex's device reads it as waiting on the person and holds no conversation of it; what
 * opens for it is the row Loft writes to the account's list, which this window holds as a conversation listed from
 * elsewhere (`placedSummary`). `studio` and `loft`: Loft is heard, and the row says what it asks. `quiet`: Loft hasn't
 * been heard from for 25 minutes. `unlisted`: no row of it at all, so nothing opens. `off`, for the web's fixtures:
 * the Apex's device is the quiet one, and the Fin's row still says what it asks.
 */
export const PLACED_SCENE = new URLSearchParams(globalThis.location?.search).get("placed")
export const PLACED_DEVICE = "00000000-0000-4000-8000-00000000106f"
export const PLACED_WHERE = "Loft"
export const PLACED_THREAD = "1ead1ead-3000-4000-8000-000000000013"
export const PLACED_SESSION = "1ead1ead-4000-4000-8000-000000000013"
export const PLACED_CONVERSATION = "1ead1ead-5000-4000-8000-000000000013"
export const PLACED_TITLE = "Docs sweep"
export const PLACED_ASKS = "Approve: npm run docs:check"
const PLACED_FIXTURE: ChildFixture = { name: "docs-sweep", title: PLACED_TITLE, harness: "opencode", model: "kimi-k3", state: { kind: "blocked", on: "person", question: PLACED_ASKS, ask: { kind: "report", id: "report:docs-sweep:to-person" } }, minutes: 3, objective: "Sweep docs/ for stale links and fix them.", placed: true }

/**
 * `&fins=decisions`: two of the done Fins finished with a decision their work leaves, one the person's (Thread list
 * swipe: merge its PR?) and one its Apex's (Pull to refresh), so the scene shows done · needs you beside the rest.
 */
const DECIDED = new Map<string, ChildState>([
  ["swipe", { kind: "ended", outcome: "done", decision: { question: "Merge #371 into main?", on: "person", ask: { kind: "report", id: "report:swipe:merge", options: [{ label: "Merge", detail: "Squash it into main; every check is green." }, { label: "Leave open", detail: "Keep it for a review first." }], recommended: 0, action: "Decide whether the swipe fix lands now." } } }],
  ["pull-refresh", { kind: "ended", outcome: "done", decision: { question: "Ship the cached list or the fresh read on pull?", on: "lead", ask: { kind: "report", id: "report:pull-refresh:read", options: [{ label: "Fresh read" }, { label: "Cached list" }], recommended: 0 } } }],
])
const DECISIONS_SCENE = new URLSearchParams(globalThis.location?.search).get("fins") === "decisions"

/** The twelve, as the prototype has them: 2 need you, 5 working (one asking its Apex), 2 queued, 3 done. */
/**
 * `&ask=fin`: "Dictation fallback"'s agent asked to move its Thread, as its Apex's host builds its row (`askWaiting`,
 * `LiveAsks.pending` through `waitingOf`): blocked on an approval in the ask's own words, left to the person.
 */
const FIN_ASKS = new URLSearchParams(globalThis.location?.search).get("ask") === "fin"
const FIN_MOVE_ASK: ChildState = {
  kind: "blocked",
  on: "approval",
  question: "Wants to move this Thread to the cloud (yours to answer: its Apex isn't on full access)",
  ask: { kind: "approval", id: "1ead1ead-7000-4000-8000-0000000000b5", options: [{ label: "Move to the cloud" }, { label: "Keep here" }], named: true },
}

const CHILDREN: ChildFixture[] = ([
  { name: "push-wording", title: "Quiet-hours push wording", harness: "codex", model: "gpt-5.6-sol", state: { kind: "blocked", on: "person", question: "Which tone for the quiet-hours notice? Plain or friendly?", ask: { kind: "report", id: "report:push-wording:tone", options: [{ label: "Plain", detail: "Pushes are held until 7:00." }, { label: "Friendly", detail: "Quiet hours: we'll tell you at 7:00." }], recommended: 0, action: "Pick the tone the phone ships with." } }, minutes: 14, toolUses: 22, objective: "Write the quiet-hours notice the phone shows when pushes are held, in both tones, and ask which one ships." },
  { name: "sheet-motion", title: "Sheet motion on iPad", harness: "cursor", model: "composer-2.5", state: { kind: "blocked", on: "approval", question: "Approve: npm ci", ask: { kind: "approval", id: "a7c0ffee-0000-4000-8000-00000000a11c", options: [{ label: "Allow once" }, { label: "Always allow" }, { label: "Reject" }] } }, minutes: 22, toolUses: 41, objective: "Make the sheet's open and close motion match the iPad's split view, on the composer branch. Done when the sheet case passes on an iPad in both themes. Report with what you changed and the shots.", said: "The sheet animates from its own height, so in split view it starts off screen. I'll measure the container instead, then run the iPad case." },
  { name: "composer-chips", title: "Composer chips on iPad", harness: "claude", model: "claude-opus-5-5", state: { kind: "working", phase: "Running the iPad cases", step: "Shell npm run test:phone" }, minutes: 18, toolUses: 64, objective: "Make the composer's chips wrap on an iPad the way they do on a Mac." },
  { name: "dictation", title: "Dictation fallback", harness: "codex", model: "gpt-5.6-sol", state: FIN_ASKS ? FIN_MOVE_ASK : { kind: "working", step: "Edit src/web-client/dictation.ts" }, minutes: 11, toolUses: 30, objective: "When the recognizer is unavailable, fall back to the keyboard's dictation without an error." },
  { name: "token-refresh", title: "Push token refresh", harness: "grok", model: "grok-4.7", state: { kind: "blocked", on: "lead", question: "Should an expired token be dropped or retried once?" }, minutes: 9, toolUses: 12, objective: "Refresh a phone's push token when the platform rotates it, without a second registration." },
  { name: "outbox", title: "Offline outbox retry", harness: "opencode", model: "kimi-k3", state: { kind: "working", step: "Read src/web-client/outbox.ts" }, minutes: 6, toolUses: 8, objective: "Retry the outbox once the page is back online, oldest first." },
  { name: "hunks", title: "Review screen hunks", harness: "devin", model: "swe-2", state: { kind: "starting", step: "launching" }, minutes: 0.4, objective: "Read the review screen's hunks from the record instead of the file." },
  { name: "haptics", title: "Haptics audit", harness: "claude", model: "claude-sonnet-5-5", state: { kind: "queued", reason: "tree-running", ahead: 0 }, minutes: 0, objective: "List every haptic the phone plays and where." },
  { name: "share-sheet", title: "Share sheet copy", harness: "cursor", model: "composer-2.5", state: { kind: "queued", reason: "tree-running", ahead: 1 }, minutes: 0, objective: "Word the share sheet's actions in the app's copy style." },
  { name: "swipe", title: "Thread list swipe", harness: "codex", model: "gpt-5.6-sol", state: { kind: "ended", outcome: "done", reason: "Swipe to archive now springs back below the threshold; PR on your branch." }, minutes: 31, toolUses: 52, objective: "Make the list's swipe to archive spring back below its threshold." },
  { name: "deep-links", title: "Settings deep links", harness: "claude", model: "claude-opus-5-5", state: { kind: "idle" }, minutes: 27, toolUses: 19, objective: "Open each settings page from a link." },
  { name: "pull-refresh", title: "Pull to refresh", harness: "grok", model: "grok-4.7", state: { kind: "ended", outcome: "done", reason: "Pull to refresh reads the account list again and keeps its place." }, minutes: 40, toolUses: 33, objective: "Pull to refresh reads the account list again." },
] satisfies ChildFixture[]).map((fixture): ChildFixture => (DECISIONS_SCENE && DECIDED.has(fixture.name) ? { ...fixture, state: DECIDED.get(fixture.name)! } : fixture)).concat(PLACED_SCENE ? [PLACED_FIXTURE] : [])

/**
 * `&fins=limit`: the tree on 2026-11-05, as the host says it. Cursor ran out: three of its Fins moved to Claude Code,
 * one had nowhere to go and stopped with its work unfinished, and the first moved carries the tree's one notice.
 */
/**
 * `&ask=move` or `&ask=back`: the Apex's own agent asks, below full access, to move its Thread or bring it back;
 * `&ask=fin`: its Fin "Dictation fallback" does, which goes to the Apex first (`test-agent-ask-ui.mjs`).
 */
const ASK_SCENE = new URLSearchParams(globalThis.location?.search).get("ask")
const LIMIT_SCENE = new URLSearchParams(globalThis.location?.search).get("fins") === "limit"
const LIMIT_UNTIL = "Sun 12:00 AM PST"
const LIMIT_MOVED = `Moved to Claude Code: Cursor is at its limit until ${LIMIT_UNTIL}`
const LIMIT_OUT = `Out of accounts until ${LIMIT_UNTIL}: Cursor and Claude Code (work)`
const LIMIT_RAN = `Cursor ran out until ${LIMIT_UNTIL}`
const LIMIT_DID = "3 Fins moved to Claude Code. 1 Fin has nowhere to go. 7 reports are waiting for their Apex."
const LIMIT_NOTICE = { id: "limit:cursor::1793923200000", harness: "cursor", line: `${LIMIT_RAN}. ${LIMIT_DID}` }
/** What each Fin of the scene becomes: a moved one runs on Claude Code now, and the one that couldn't stays on Cursor. */
const LIMIT_FINS = new Map<string, (entry: NativeAgent) => NativeAgent>([
  ["sheet-motion", (entry) => ({ ...entry, provider: "claude", model: "claude-opus-5-5", child: { ...entry.child!, moved: LIMIT_MOVED, limitNotice: LIMIT_NOTICE, state: { kind: "working", step: "Edit src/web-client/sheet.tsx" } } })],
  ["share-sheet", (entry) => ({ ...entry, provider: "claude", model: "claude-opus-5-5", child: { ...entry.child!, moved: LIMIT_MOVED, state: { kind: "working", step: "Read src/web-client/share.tsx" } } })],
  ["hunks", (entry) => ({ ...entry, provider: "cursor", model: "composer-2.5", child: { ...entry.child!, moved: LIMIT_OUT, state: { kind: "ended", outcome: "stopped", reason: LIMIT_OUT, unfinished: true } } })],
])

function childThread(index: number): string {
  return CHILDREN[index]?.placed ? PLACED_THREAD : `1ead1ead-3000-4000-8000-${String(index + 1).padStart(12, "0")}`
}
function childSession(index: number): string {
  return `1ead1ead-4000-4000-8000-${String(index + 1).padStart(12, "0")}`
}
function childConversation(index: number): string {
  return `1ead1ead-5000-4000-8000-${String(index + 1).padStart(12, "0")}`
}

/** Whether the Fin has started here: a queued one has no conversation yet, and one placed elsewhere none on this device. */
function started(fixture: ChildFixture): boolean {
  return fixture.state.kind !== "queued" && !fixture.placed
}

/** What a Fin's Thread shows and its journal holds, for `childState` to read a state back from. */
interface ChildShowing {
  thread: Partial<ChildThread>
  journal: ChildJournal
}

function shown(state: ChildState, child: string, at: number, placed = false): ChildShowing {
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
      // A placed Fin's ask reaches its Apex's device as its report of it, the person's to answer where it runs.
      if (placed && state.ask) return { thread: {}, journal: { latest: { id: state.ask.id, child: ThreadIdSchema.parse(child), status: "blocked", summary: `It waits: ${state.question}`, question: state.question, for: "person", told: true, implicit: true, ownerGeneration: 1, at } } }
      return { thread: { waiting: { question: state.question, on: state.on, ...(state.ask && { ask: state.ask }) } }, journal: {} }
    case "idle":
      return { thread: {}, journal: {} }
    case "ended": {
      const decision = state.decision
      if (!decision?.ask) return { thread: { ended: { outcome: state.outcome, ...(state.reason && { reason: state.reason }), at } }, journal: {} }
      const { options, recommended, action } = decision.ask
      const latest = { id: decision.ask.id, child: ThreadIdSchema.parse(child), status: "done" as const, summary: "It's finished and green.", question: decision.question, ...(options && { options }), ...(recommended !== undefined && { recommended }), ...(action && { action }), ...(decision.on === "person" && { decides: "person" as const }), ownerGeneration: 1, at }
      return { thread: {}, journal: { latest } }
    }
  }
}

/** What each Fin runs on, as its harness's catalog words it (`finTuningWords`); one passed over a model its harness stopped listing. */
const RUNS_ON = new Map<string, FinTuningWords>(Object.entries({
  "push-wording": { model: "GPT-5.6 Sol", reasoning: "High", fast: true },
  "sheet-motion": { model: "Composer 2.5", fast: true },
  "composer-chips": { model: "Opus 5.5", reasoning: "High" },
  dictation: { model: "GPT-5.6 Sol", reasoning: "Medium" },
  "token-refresh": { model: "Grok 4.7", reasoning: "High" },
  outbox: { model: "Kimi K3", reasoning: "High" },
  hunks: { model: "SWE-2", reasoning: "High" },
  haptics: { model: "Opus 5.5", reasoning: "Medium" },
  "share-sheet": { model: "Composer 2.5" },
  swipe: { model: "GPT-5.6 Sol", reasoning: "Extra high" },
  "deep-links": { model: "Opus 5.5", reasoning: "High" },
  "pull-refresh": { model: "Grok 4.7", reasoning: "High" },
}))
/** The person's rule each Fin was started by (`mock-bridge`'s policy), or none that fit. */
const RULES = new Map<string, { n?: number; when: string }>([
  ["composer-chips", { n: 1, when: "UI, CSS and anything someone looks at: components, motion, visual polish" }],
  ["deep-links", { n: 1, when: "UI, CSS and anything someone looks at: components, motion, visual polish" }],
  ["push-wording", { n: 2, when: "Anything that isn't frontend: APIs, migrations, the host, tests" }],
  ["dictation", { n: 2, when: "Anything that isn't frontend: APIs, migrations, the host, tests" }],
  ["swipe", { n: 2, when: "Anything that isn't frontend: APIs, migrations, the host, tests" }],
  ["sheet-motion", { n: 3, when: "Quick lookups, renames and one-line fixes" }],
  ["share-sheet", { n: 3, when: "Quick lookups, renames and one-line fixes" }],
  ["haptics", { when: "No rule fit" }],
])
/** A Fin whose Claude account ran out mid-turn and went on in the same session on the person's next one. */
const MOVED = new Map<string, FinRerouted>([["composer-chips", movedTo({ why: "account", harness: "claude", account: "work", label: "work" }, "personal")]])
function movedTo(step: FallbackStep, account: string): FinRerouted {
  const now = Date.now()
  const until = now + 40 * 60_000
  // As the host words a harness, before a window has read the harnesses' names.
  const line = movedLine({ step, from: { harness: step.harness, account }, until }, (harness) => (harness === "claude" ? "Claude Code" : harnessLabel(harness)), now)
  return { from: step.harness, account, until, to: step, at: now - 4 * 60_000, line }
}
const PASSED_OVER = new Map([["token-refresh", "Your Fins default for Grok, grok-4.6-mini, isn't listed by Grok anymore: it runs on Grok 4.7 instead."]])

const SPAWNED_BEFORE_MS = 80 * 3_600_000

/** One Fin's roster entry, made by `childEntry` from its edge and what its Thread shows, as the host makes it. */
export function apexFin(index: number, state: ChildState = CHILDREN[index]!.state): NativeAgent {
  const fixture = CHILDREN[index]!
  const now = Date.now()
  // Spawned days ago, each at work or standing as it does for its own `minutes`: a row's time is the second, never the first.
  const stoodSince = now - fixture.minutes * 60_000
  const createdAt = stoodSince - SPAWNED_BEFORE_MS
  const child = childThread(index)
  const apex = SessionIdSchema.parse(APEX_SESSION)
  const edge: ThreadParent = {
    child: ThreadIdSchema.parse(child),
    parent: ThreadIdSchema.parse(APEX_THREAD),
    parentSession: apex,
    name: fixture.name,
    role: "worker",
    origin: "started",
    asked: { brief: { objective: fixture.objective }, harness: fixture.harness, model: fixture.model, ...(fixture.placed && { place: `device:${PLACED_WHERE}` }) },
    op: `start:${APEX_SESSION}:${fixture.name}`,
    ...(fixture.placed && { placed: { target: { kind: "device" as const, device: PLACED_DEVICE, name: PLACED_WHERE }, session: PLACED_SESSION, working: false, epoch: 1 } }),
    startedBy: { kind: "agent", session: apex },
    createdAt,
    tuned: { source: PASSED_OVER.has(fixture.name) ? "used" : "apex", ...(PASSED_OVER.has(fixture.name) && { note: PASSED_OVER.get(fixture.name) }), ...(RULES.has(fixture.name) && { rule: RULES.get(fixture.name) }), ...(MOVED.has(fixture.name) && { rerouted: MOVED.get(fixture.name) }) },
  }
  const { thread, journal } = shown(state, child, now - 60_000, fixture.placed)
  const entry = childEntry(
    edge,
    {
      source: fixture.placed ? "placed" : "live",
      title: fixture.title,
      harness: fixture.harness,
      model: fixture.model,
      ...(RUNS_ON.has(fixture.name) && { runsOn: RUNS_ON.get(fixture.name) }),
      startedAt: createdAt,
      updatedAt: stoodSince,
      ...(state.kind === "working" && { workSince: stoodSince }),
      ...(fixture.toolUses && { toolUses: fixture.toolUses }),
      ...(started(fixture) && { session: SessionIdSchema.parse(childSession(index)), conversation: childConversation(index), nativeId: `apex-fin-${index}`, path: `/mock/apex-fin-${index}.jsonl` }),
      ...thread,
    },
    journal
  )
  const limited = LIMIT_SCENE && entry.child ? LIMIT_FINS.get(fixture.name) : undefined
  return limited ? limited(entry) : entry
}

export function apexFins(): NativeAgent[] {
  return CHILDREN.map((_, index) => apexFin(index))
}

/** The states a churned Fin steps through, one a tick, as a real one moves. */
export const CHURN: ChildState[] = [
  { kind: "working", step: "Read src/web-client/thread.tsx" },
  { kind: "working", step: "Shell npm run test:phone" },
  { kind: "blocked", on: "lead", question: "Which branch should this land on?" },
  { kind: "working", phase: "Writing the report" },
  { kind: "blocked", on: "person", question: "Allow network access for npm ci?" },
  { kind: "ended", outcome: "done", reason: "Done." },
  { kind: "queued", reason: "tree-running", ahead: 0 },
]

/** A Fin of `count` for the bench: the twelve repeated, each its own Thread. */
export function benchChild(index: number, state: ChildState): NativeAgent {
  const base = apexFin(index % CHILDREN.length, state)
  const thread = `1ead1ead-6000-4000-8000-${String(index + 1).padStart(12, "0")}`
  return { ...base, nativeId: `mako-child:${thread}`, title: `${base.title} ${index + 1}`, child: { ...base.child!, thread } }
}

/** The bench's rail: `count` Apexes over ten folders, each with `children` Fins not yet started, in every state. */
interface BenchApexes {
  snapshots: LiveSnapshot[]
  summaries: LiveSummary[]
  refs: ThreadRef[]
}

export function benchApexes(count: number, children: number): BenchApexes {
  const snapshots: LiveSnapshot[] = []
  const summaries: LiveSummary[] = []
  const refs: ThreadRef[] = []
  const at = new Date().toISOString()
  for (let apex = 0; apex < count; apex++) {
    const id = (group: string) => `1ead1ead-${group}-4000-8000-${String(apex + 1).padStart(12, "0")}`
    const thread = id("9000")
    const session = id("a000")
    const conversation = id("b000")
    const cwd = `/Users/you/bench-${apex % 10}`
    const title = `Apex ${apex + 1}`
    const agents = Array.from({ length: children }, (_, index): NativeAgent => {
      const base = apexFin(index % CHILDREN.length, CHURN[(apex + index) % CHURN.length]!)
      const child = `1ead1ead-c000-4000-8${apex.toString(16).padStart(3, "0")}-${String(index + 1).padStart(12, "0")}`
      refs.push({ harness: base.provider, nativeId: `bench-child-${apex}-${index}`, path: `/mock/bench-child-${apex}-${index}.jsonl`, cwd, title: `${base.title} ${index + 1}`, updatedAt: at, threadId: child, parent: { thread, session } })
      return { ...base, nativeId: `mako-child:${child}`, title: `${base.title} ${index + 1}`, child: { thread: child, origin: "started", state: base.child!.state } }
    })
    const snapshot: LiveSnapshot = {
      session: { id: conversation, harness: "claude", nativeId: `bench-apex-${apex}`, cwd, title, connection: "connected", status: apex % 3 === 0 ? "running" : "ready", modes: [], currentMode: "default", configOptions: [] },
      revision: 1,
      createdAt: STARTED,
      threadPath: `/mock/bench-apex-${apex}.jsonl`,
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
    refs.push({ harness: "claude", nativeId: `bench-apex-${apex}`, path: snapshot.threadPath!, cwd, title, updatedAt: new Date(Date.now() - apex * 60_000).toISOString(), threadId: thread, sessionId: session, bytes: 4_000 })
  }
  return { snapshots, summaries, refs }
}

function brief(fixture: ChildFixture): string {
  return [fromAgent(YOUR_APEX), briefIntro(fixture.name), "", fixture.objective, "", BRIEF_CLOSE].join("\n")
}

/** What the person wrote to the Apex that its Sheet motion Fin was for, and the Apex passed on. */
export const ROUTED_WORDS = "The sheet still jumps when the keyboard opens in split view."
const ROUTED_AT = Date.now() - 4 * 60_000
const ROUTED_REQUEST = "1ead1ead-8100-4000-8000-000000000002"
const DIRECT_REQUEST = "1ead1ead-8200-4000-8000-000000000001"
const DIRECT_RECEIVED = "1ead1ead-8300-4000-8000-000000000001"
const SHEET_MOTION = 1
/** What the person wrote from the Apex straight to Dictation: no turn of the Apex's ran for it. */
export const DIRECT_WORDS = "Keep the keyboard's own mic as the fallback, and say nothing when it takes over."
const DIRECT_AT = Date.now() - 2 * 60_000
const DICTATION = 3
const WAKE_AT = Date.now() - 90_000
/** A wake as the host writes one (`digest`): the Apex's words, then the same reports as data, which the person reads as each Fin's message. */
const WAKE_TEXT = appendFinReports(
  [
    FROM_AGENTS,
    "1 waits on the person:",
    `  • "push-wording" (Codex): Which tone for the quiet-hours notice? Plain or friendly?`,
    "1 finished:",
    `  • "swipe" (Codex) done: Swipe to archive now springs back below the threshold; PR on your branch.`,
    "    pull-request: https://github.com/acme/phone/pull/214",
    "5 working, 2 queued, 1 idle, 2 ended.",
    "agents_read gives a report in full. Reply to the person, start more work, or end your turn.",
  ].join("\n"),
  [
    { report: "report:push-wording:tone", fin: childThread(0), name: "Quiet-hours push wording", harness: "codex", status: "needs-input", line: "Which tone for the quiet-hours notice? Plain or friendly?", options: [{ label: "Plain", detail: "Pushes are held until 7:00." }, { label: "Friendly", detail: "Quiet hours: we'll tell you at 7:00." }], recommended: 0, forPerson: true },
    { report: "report:swipe:done", fin: childThread(9), name: "Thread list swipe", harness: "codex", status: "done", line: "Swipe to archive now springs back below the threshold; PR on your branch.", artifacts: [{ kind: "pull-request", ref: "https://github.com/acme/phone/pull/214" }] },
  ]
)

/** What stands in the Apex's conversation ahead of its own turns: the requests and the blocks that drew them. */
interface EarlierTurns {
  requests: LiveRequest[]
  blocks: Entry[]
}

const EARLIER_WORDS = [
  "The sheet measures its container once the keyboard's inset settles, so split view no longer starts it off screen.",
  "Each Fin's report lands as its own message under the wake, with its options live while the ask is yours.",
  "The crew card keeps the Fins on screen through every transition; only the background line waits for the turn's end.",
  "Rows the transcript has not laid out stand at the size they last measured, or an estimate until they mount.",
]

/**
 * `turns` earlier exchanges ahead of the Apex's own, for a long Thread (`?mock&app=apex&turns=260`): each a prompt,
 * a few tool calls, and an answer of prose, a list and code of varying length, so the transcript windows its rows.
 */
function earlierTurns(turns: number): EarlierTurns {
  const requests: LiveRequest[] = []
  const blocks: Entry[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    const id = `1ead1ead-6000-4000-8000-${String(turn + 1).padStart(12, "0")}`
    const createdAt = STARTED - (turns - turn) * 120_000
    const text = `Turn ${turn + 1}: ${EARLIER_WORDS[turn % EARLIER_WORDS.length]}`
    requests.push({ id, createdAt, text, attachments: [], status: "completed" })
    blocks.push({ type: "user", text, requestId: id, at: createdAt })
    for (let tool = 0; tool < turn % 4; tool += 1)
      blocks.push({ type: "tool", id: `apex-earlier-${turn}-${tool}`, toolKind: "read", title: `Read src/web-client/part-${tool}.tsx`, input: `{"path":"src/web-client/part-${tool}.tsx"}`, output: "export function Part() {}", status: "completed" })
    const lines = 2 + ((turn * 7) % 18)
    blocks.push({ type: "text", text: [
      EARLIER_WORDS[(turn + 1) % EARLIER_WORDS.length]!.repeat(1 + (turn % 3)),
      ...EARLIER_WORDS.slice(0, 1 + (turn % 4)).map((words) => `- ${words}`),
      "```ts",
      ...Array.from({ length: lines }, (_, line) => `const step${line} = measure(${turn}, ${line})`),
      "```",
    ].join("\n\n") })
  }
  return { requests, blocks }
}

/**
 * A real conversation's blocks and requests ahead of the Apex's own (`?mock&app=apex&journal=/path.json`), for
 * measuring the transcript on one: `{ blocks, requests }` as a journal holds them, served by the dev server. Read
 * synchronously, as the mock bridge builds its scene before the window draws.
 */
function journalTurns(url: string): EarlierTurns {
  const request = new XMLHttpRequest()
  request.open("GET", url, false)
  request.send()
  // SAFETY: a file a bench wrote from a journal's `blocks` and `requests` rows, each row's value as written.
  return JSON.parse(request.responseText) as EarlierTurns
}

/**
 * The Apex's own conversation: the person's first ask, a message it passed on to Sheet motion, one the person wrote
 * straight to Dictation, its turn running, its roster the twelve.
 */
export function apexSnapshot(): LiveSnapshot {
  const search = new URLSearchParams(globalThis.location?.search)
  const earlier = search.has("journal") ? journalTurns(search.get("journal")!) : earlierTurns(Number(search.get("turns") ?? 0))
  // Where a bench's cold open starts: the scene is built, the window not yet drawn.
  performance.mark("mock-apex-scene")
  // `idle=1`: its turn over, as between the person's messages.
  const idle = search.get("idle") === "1"
  const first = { id: "1ead1ead-7000-4000-8000-000000000001", createdAt: STARTED, text: "Split the phone polish list into Threads and see them through. Ask me only for what you can't decide.", attachments: [], status: "completed" as const }
  const routed = { id: "1ead1ead-7000-4000-8000-000000000002", createdAt: ROUTED_AT, text: ROUTED_WORDS, attachments: [], status: "completed" as const }
  const wake = { id: "1ead1ead-7000-4000-8000-000000000004", createdAt: WAKE_AT, text: WAKE_TEXT, attachments: [], status: "completed" as const }
  const request = { id: "1ead1ead-7000-4000-8000-000000000003", createdAt: Date.now() - 60_000, text: "How are the queued ones doing?", attachments: [], status: idle ? ("completed" as const) : ("dispatching" as const) }
  const sent = { to: "sheet-motion", forward: true, clientKey: "sheet-keyboard" }
  const landed = { child: childThread(SHEET_MOTION), name: "sheet-motion", request: ROUTED_REQUEST, delivery: "steer" }
  return {
    session: {
      id: APEX_CONVERSATION,
      harness: "claude",
      nativeId: "apex-native",
      cwd: APEX_CWD,
      title: APEX_TITLE,
      connection: "connected",
      status: idle ? "ready" : "running",
      modes: [
        { id: "acceptEdits", name: "Accept edits", access: "ask" },
        { id: "bypassPermissions", name: "Full access", access: "full" },
      ],
      currentMode: "acceptEdits",
      configOptions: [],
    },
    revision: 1,
    createdAt: STARTED,
    threadPath: "/mock/apex.jsonl",
    threadId: APEX_THREAD,
    sessionId: APEX_SESSION,
    base: null,
    permissions: [],
    requests: [...earlier.requests, first, routed, wake, request],
    blocks: [
      ...earlier.blocks,
      { type: "user", text: first.text, requestId: first.id },
      { type: "text", text: "Twelve pieces, each its own Thread. I'll start them as the tree allows and read their reports as they come." },
      { type: "tool", id: "apex-start", toolKind: "other", title: "agents_start ×12", input: "{}", output: "started 10, queued 2", status: "completed" },
      { type: "user", text: routed.text, requestId: routed.id },
      { type: "tool", id: "apex-send", name: "mcp__mako__agents_send", toolKind: "other", title: "mako: agents send", input: JSON.stringify(sent), output: JSON.stringify(landed, null, 2), status: "completed" },
      { type: "text", text: "That's Sheet motion's: it's measuring the container in split view now, so it takes this at its next step." },
      { type: "event", label: `You wrote to ${CHILDREN[DICTATION]!.name} directly`, body: DIRECT_WORDS, direct: { to: CHILDREN[DICTATION]!.name, fin: childThread(DICTATION), request: DIRECT_REQUEST, received: DIRECT_RECEIVED, delivery: "steer", at: DIRECT_AT } },
      { type: "user", text: wake.text, requestId: wake.id },
      { type: "text", text: "Push wording's tone is yours to pick; Thread list swipe finished with its PR." },
      ...(LIMIT_SCENE ? [{ type: "event" as const, label: LIMIT_RAN, detail: LIMIT_DID }] : []),
      { type: "user", text: request.text, requestId: request.id },
      { type: "text", text: "Reading the digest." },
    ],
    control: {
      activeBindingId: APEX_CONVERSATION,
      bindings: [],
      merges: [],
      transfers: [],
      actions: [],
      ...((ASK_SCENE === "move" || ASK_SCENE === "back") && { asks: [{ id: "1ead1ead-7000-4000-8000-0000000000a5", at: STARTED, want: ASK_SCENE === "back" ? { kind: "back" as const } : { kind: "move" as const, move: "1ead1ead-7000-4000-8000-0000000000a6", handsOff: true } }] }),
    },
    nativeAgents: { agents: apexFins(), limited: false },
  }
}

/** A started Fin's own conversation: its brief from the Apex, its work, and for one an approval waiting. */
export function finSnapshot(index: number): LiveSnapshot {
  const fixture = CHILDREN[index]!
  const createdAt = Date.now() - fixture.minutes * 60_000
  const request = { id: `1ead1ead-8000-4000-8000-${String(index + 1).padStart(12, "0")}`, createdAt, text: brief(fixture), attachments: [], status: fixture.state.kind === "working" || fixture.state.kind === "blocked" ? ("dispatching" as const) : ("completed" as const) }
  const waits = fixture.state.kind === "blocked" && fixture.state.on === "approval"
  return {
    session: {
      id: childConversation(index),
      harness: fixture.harness,
      nativeId: `apex-fin-${index}`,
      cwd: `${APEX_CWD}/.mako/worktrees/${fixture.name}`,
      title: fixture.title,
      connection: "connected",
      status: request.status === "dispatching" ? "running" : "ready",
      modes: [{ id: "default", name: "Ask", access: "ask" }],
      currentMode: "default",
      configOptions: [],
    },
    revision: 1,
    createdAt,
    threadPath: `/mock/apex-fin-${index}.jsonl`,
    threadId: childThread(index),
    sessionId: childSession(index),
    parent: { thread: APEX_THREAD, session: APEX_SESSION },
    base: null,
    permissions: waits
      ? [{ id: `apex-approval-${index}`, sessionId: childConversation(index), title: "npm ci", kind: "execute", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Allow for this Thread", kind: "allow_always" }, { optionId: "deny", name: "Deny", kind: "reject_once" }] }]
      : [],
    requests: [request],
    blocks: [
      { type: "user", text: request.text, requestId: request.id },
      { type: "text", text: fixture.said ?? `Starting on it: ${fixture.objective.charAt(0).toLowerCase()}${fixture.objective.slice(1)}` },
      { type: "tool", id: `apex-fin-read-${index}`, toolKind: "read", title: "Read src/web-client/sheet.tsx", input: "{\"path\":\"src/web-client/sheet.tsx\"}", output: "export function Sheet() {}", status: "completed" },
      ...(index === SHEET_MOTION
        ? [
          { type: "user" as const, text: `${passedOn(YOUR_APEX)}\n${ROUTED_WORDS}\n\n${PASSED_ON_NOTE}\nIt shows on the 11-inch iPad in landscape, after your last change.`, steeringFor: request.id, at: ROUTED_AT },
          { type: "text" as const, text: "The keyboard's inset moves the container too, so I'll measure after the inset settles, then rerun the iPad case." },
        ]
        : []),
      ...(index === DICTATION
        ? [
          { type: "user" as const, text: DIRECT_WORDS, steeringFor: request.id, requestId: DIRECT_RECEIVED, at: DIRECT_AT },
          { type: "text" as const, text: "Understood: the keyboard's mic takes over quietly when the recognizer isn't there." },
        ]
        : []),
      ...(waits ? [{ type: "tool" as const, id: `apex-fin-ci-${index}`, toolKind: "execute" as const, title: "npm ci", input: "{\"command\":\"npm ci\"}", status: "pending" as const }] : []),
      ...(fixture.state.kind === "ended" && fixture.state.reason ? [{ type: "text" as const, text: fixture.state.reason }] : []),
    ],
    control: {
      activeBindingId: childConversation(index),
      bindings: [],
      merges: [],
      transfers: [],
      actions: [],
      ...(ASK_SCENE === "fin" && index === 3 && { asks: [{ id: "1ead1ead-7000-4000-8000-0000000000b5", at: STARTED, want: { kind: "move" as const, move: "1ead1ead-7000-4000-8000-0000000000b6", handsOff: true } }] }),
    },
  }
}

/** Every conversation of the scene, the Apex's last: the one a window opens on. */
export function apexSnapshots(): LiveSnapshot[] {
  return [...CHILDREN.flatMap((fixture, index) => (started(fixture) ? [finSnapshot(index)] : [])), apexSnapshot()]
}

/** As the desktop's host lists them at boot: each Fin with its edge, as `placement` gives it; the placed one as Loft's row lists it. */
export function apexSummaries(): LiveSummary[] {
  const placed = placedSummary()
  return [
    ...apexSnapshots().map(({ session, revision, createdAt, threadPath, threadId, sessionId, parent, nativeAgents }) => {
      const children = rollup(rosterChildren(nativeAgents))
      return { session, revision, createdAt, threadPath, threadId, sessionId, ...(parent && { parent }), ...(children.total && { children }) }
    }),
    ...(placed ? [placed] : []),
  ]
}

/**
 * The placed Fin's conversation as this window lists it from the account: Loft's own row of it, under its Apex
 * (`listedApexOf`), waiting on an approval there. Undefined when Loft never listed it (`&placed=unlisted`), or the
 * scene has no placed Fin.
 */
export function placedSummary(): LiveSummary | undefined {
  if (!PLACED_SCENE || PLACED_SCENE === "unlisted") return undefined
  const createdAt = Date.now() - PLACED_FIXTURE.minutes * 60_000
  const quiet = PLACED_SCENE === "quiet"
  return {
    session: { id: PLACED_CONVERSATION, harness: PLACED_FIXTURE.harness, cwd: "/home/you/.mako/projects/mako/.mako/worktrees/docs-sweep", title: PLACED_TITLE, connection: "hibernated", status: quiet ? "ready" : "running", modes: [], currentMode: null, configOptions: [] },
    revision: 0,
    createdAt,
    elsewhere: PLACED_WHERE,
    threadId: PLACED_THREAD,
    sessionId: PLACED_SESSION,
    movedAt: Date.now() - 60_000,
    parent: { thread: APEX_THREAD, session: APEX_SESSION },
    ...(!quiet && { waitingOn: PLACED_ASKS, waitingFor: "approval" as const }),
    ...(quiet && { quietSince: Date.now() - 25 * 60_000 }),
  }
}

/** What Loft answers when the placed Fin is opened from here: its brief, its first step, and the approval it waits on. */
export function placedSnapshot(): LiveSnapshot | undefined {
  const summary = placedSummary()
  if (!summary) return undefined
  const request = { id: "1ead1ead-8000-4000-8000-000000000013", createdAt: summary.createdAt, text: brief(PLACED_FIXTURE), attachments: [], status: "dispatching" as const }
  return {
    ...summary,
    base: null,
    permissions: summary.waitingOn
      ? [{ id: "placed-approval", sessionId: PLACED_CONVERSATION, title: "npm run docs:check", kind: "execute", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }, { optionId: "always", name: "Always allow npm *", kind: "allow_always" }, { optionId: "deny", name: "Reject", kind: "reject_once" }] }]
      : [],
    requests: [request],
    blocks: [
      { type: "user", text: request.text, requestId: request.id },
      { type: "text", text: "Checking every link under docs/ first, then fixing what's stale." },
    ],
    control: { activeBindingId: PLACED_CONVERSATION, bindings: [], merges: [], transfers: [], actions: [] },
  }
}

/** The catalog's rows: the Apex's, and each started Fin's under it (`parent`), which the rail never lists. */
export function apexRefs(): ThreadRef[] {
  const apex: ThreadRef = { harness: "claude", nativeId: "apex-native", path: "/mock/apex.jsonl", cwd: APEX_CWD, title: APEX_TITLE, updatedAt: new Date().toISOString(), startedAt: new Date(STARTED).toISOString(), threadId: APEX_THREAD, sessionId: APEX_SESSION, bytes: 20_000 }
  const children = CHILDREN.flatMap((fixture, index): ThreadRef[] =>
    started(fixture)
      ? [{ harness: fixture.harness, nativeId: `apex-fin-${index}`, path: `/mock/apex-fin-${index}.jsonl`, cwd: `${APEX_CWD}/.mako/worktrees/${fixture.name}`, title: fixture.title, updatedAt: new Date().toISOString(), threadId: childThread(index), sessionId: childSession(index), parent: { thread: APEX_THREAD, session: APEX_SESSION } }]
      : [])
  return [apex, ...children]
}
