import type { LiveRequest, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { personPromptedAt } from "@mako/host/contracts/worked-at"
import { ThreadGroupSchema, type ThreadGroup } from "@mako/host/contracts/thread-groups"
import type { ThreadRef } from "@/lib/types"

/*
 * A long, busy Thread for the desk's fixtures (`?mock&app=busy`, and the web
 * desk's page): four Sessions, the first a long conversation whose turn ended
 * while three agents and twenty-two commands still run. The desktop lists it
 * from its own host, the web desk from the account's list, so the two can be
 * drawn side by side from the same data.
 */

export const BUSY_THREAD = "b0b0b0b0-0000-4000-8000-00000000b0b0"
export const BUSY_CWD = "/Users/you/mako"
const STARTED = Date.now() - 4 * 3_600_000
const DAY = 24 * 3_600_000

/**
 * `?aged`: the second Session is a fork started 22 days ago, last sent a message 20 days ago, read on another device
 * since, as the one a phone's "Please continue" woke on 2026-11-01 was. Its journal's write stays recent.
 */
export function agedChoice(): boolean {
  return "location" in globalThis && new URLSearchParams(globalThis.location.search).has("aged")
}

/** When Session `index` started, and when its messages were sent from. */
function startedAt(index: number): number {
  return agedChoice() && index === 1 ? Date.now() - 22 * DAY : STARTED + index * 60_000
}
function askedFrom(index: number): number {
  return agedChoice() && index === 1 ? Date.now() - 20 * DAY - 25 * 60_000 : STARTED + index * 60_000
}

/** The Thread's group under `?aged`: its second Session began as a fork of its first. */
export function agedGroup(): ThreadGroup[] {
  return agedChoice()
    ? [ThreadGroupSchema.parse({ id: BUSY_THREAD, sessions: BUSY_SESSIONS.map((entry, index) => ({ id: entry.session, origin: index === 1 ? "fork" : index ? "new" : "started", started: true, ...(index === 1 && { forkOf: BUSY_SESSIONS[0]!.session }) })) })]
    : []
}

/** The Thread's Sessions, the one that started first first, as its tabs are ordered. */
export const BUSY_SESSIONS = [
  { conversation: "b0b0b0b0-0001-4000-8000-00000000b0b0", session: "b0b0b0b0-1001-4000-8000-00000000b0b0", harness: "claude", title: "I'll read the MetaHarness track plan and the phone composer" },
  { conversation: "b0b0b0b0-0002-4000-8000-00000000b0b0", session: "b0b0b0b0-1002-4000-8000-00000000b0b0", harness: "claude", title: "I'll read the MetaHarness track plan for the review screen" },
  { conversation: "b0b0b0b0-0003-4000-8000-00000000b0b0", session: "b0b0b0b0-1003-4000-8000-00000000b0b0", harness: "codex", title: "Cut bytes per streamed token" },
  { conversation: "b0b0b0b0-0004-4000-8000-00000000b0b0", session: "b0b0b0b0-1004-4000-8000-00000000b0b0", harness: "claude", title: "Cloud PRs as the person, opt-in" },
] as const

export const BUSY_TITLE = "Thread Environments and the phone's review screen"

/** When each Session last moved: the long one a minute and a half ago, each later one a little before. */
export function busyActivity(index: number): number {
  return Date.now() - (index + 1) * 90_000
}

/** The native session each conversation reads, as the desktop's catalog lists it, so its rail row is the Thread's own. */
export function busyRefs(): ThreadRef[] {
  const own = BUSY_SESSIONS.map((entry, index): ThreadRef => ({
    harness: entry.harness,
    nativeId: `busy-native-${index}`,
    path: `/mock/busy-${index}.jsonl`,
    cwd: BUSY_CWD,
    title: entry.title,
    updatedAt: new Date(busyActivity(index)).toISOString(),
    startedAt: new Date(startedAt(index)).toISOString(),
    threadId: BUSY_THREAD,
    sessionId: entry.session,
    bytes: 40_000,
  }))
  return agentsChoice() ? [...own, ...helperRefs()] : own
}

/** The sessions of `?agents=` background agents, newest of all, as the catalog lists them: under their parent, no rows. */
function helperRefs(): ThreadRef[] {
  const parent = BUSY_SESSIONS[0]!.session
  return namedRoster(BUSY_SESSIONS[0]!.conversation, agentsChoice()!).flatMap((agent): ThreadRef[] =>
    agent.detached?.session && agent.detached.path
      ? [{
          harness: agent.provider,
          nativeId: agent.detached.session,
          path: agent.detached.path,
          cwd: BUSY_CWD,
          title: `You are a headless worker started by the coordinator: ${agent.title}`,
          updatedAt: new Date().toISOString(),
          agentOf: { session: parent, agent: agent.detached.id },
        }]
      : [])
}

const AGENTS = [
  ["Cloud PRs as the person, opt-in", "Running Wait once more for final checks", 308, 3 * 3_600_000 + 36 * 60_000],
  ["Fix #255 review screen and cases", "Running Wait up to ten more minutes", 328, 3 * 3_600_000 + 25 * 60_000],
  ["Cut bytes per streamed token", "Running Wait for the lock to change hands", 154, 2 * 3_600_000 + 7 * 60_000],
] as const

const COMMANDS = [
  "npm run test:decoders",
  "npm run lint",
  "npx tsgo --noEmit -p tsconfig.app.json",
  "npm test -w @mako/sessions",
  "node scripts/test-workspace-ui.mjs",
  "npm run test:usage",
  "npm run build:control-runtime",
  "npx tsx scripts/test-web-review.ts",
  "npx tsx scripts/test-web-client.ts",
  "node scripts/test-phone-composer-ui.mjs",
  "npm run test:background-work",
  "npm run test:notifications",
  "npm run test:session-flows",
  "npm run bench:streams",
  "npm run test:application",
  "npx tsx scripts/test-composer-capabilities.ts",
  "npx tsx scripts/test-context-wire.ts",
  "npm run test:thread-references",
  "node scripts/test-isolated-host.mjs",
  "npm run test:cloud-conversations",
  "npx tsx scripts/test-host-liveness.ts",
  "npm run generate:host-inputs",
] as const

/** A background agent of `harness` (`backgroundAgentEntry`'s shape), as Mako follows one through its own Session. */
function backgroundAgent(index: number, harness: string, title: string, state: NativeAgent["state"], minutes: number, toolUses?: number): NativeAgent {
  const now = Date.now()
  const active = state.kind === "working" || state.kind === "waiting"
  const agent: NativeAgent = {
    bindingId: "mako:background-agents",
    provider: harness,
    nativeId: `mako-agent:busy-${index}`,
    title,
    work: "agent",
    background: true,
    stoppable: active,
    state,
    observedAt: now,
    startedAt: now - minutes * 60_000,
    detached: { id: `busy-${index}`, origin: "started", session: `busy-helper-${index}`, path: `/mock/busy-helper-${index}.jsonl` },
  }
  if (toolUses) agent.usage = { toolUses }
  if (!active) agent.settledAt = now - 60_000
  return agent
}

/**
 * `?mock&app=busy&agents=states`: one entry in each state, across harnesses and kinds, as every surface words them.
 * `agents=32`: thirty-two background agents at work, for the render budget.
 */
export function namedRoster(binding: string, choice: string): NativeAgent[] {
  const now = Date.now()
  if (choice === "32") {
    const harnesses = ["claude", "cursor", "codex", "grok", "opencode", "devin"]
    return Array.from({ length: 32 }, (_, index) => backgroundAgent(index, harnesses[index % harnesses.length]!, `Worker ${index + 1}: ${PROMPTS[index % PROMPTS.length]!.slice(0, 48)}`, { kind: "working", activity: COMMANDS[index % COMMANDS.length] ? `Shell ${COMMANDS[index % COMMANDS.length]}` : "Thinking" }, 3 + index, 10 + index * 7))
  }
  return [
    backgroundAgent(0, "cursor", "Unify the agents roster across harnesses", { kind: "working", activity: "Shell npm run test:decoders" }, 42, 187),
    backgroundAgent(1, "claude", "Review the sidebar filter", { kind: "waiting", reason: "Waiting on you in its own terminal" }, 18, 64),
    backgroundAgent(2, "codex", "Bench the follow cost", { kind: "working", activity: "Starting" }, 0.2),
    {
      bindingId: binding, provider: "claude", nativeId: "busy-subagent", title: "Explore the catalog's annotate path", work: "agent", role: "Explore",
      background: false, stoppable: true, state: { kind: "working", activity: "Read packages/host/src/threads/catalog.ts" }, observedAt: now, startedAt: now - 95_000, usage: { toolUses: 12 },
    },
    {
      bindingId: binding, provider: "claude", nativeId: "busy-lint", title: "npm run lint", detail: "npm run lint", work: "command",
      background: true, stoppable: true, state: { kind: "working" }, observedAt: now, startedAt: now - 140_000,
    },
    backgroundAgent(3, "grok", "Read the rail's search path", { kind: "completed", summary: "Search reads the catalog's rail list, so a helper never matches; notifications key on Thread rows, which helpers have none of." }, 25, 38),
    backgroundAgent(4, "opencode", "Record the phone footer", { kind: "failed", error: "It exited with code 1: Error: no browser found at the configured path" }, 9, 11),
    backgroundAgent(5, "cursor", "Try the old stdout decoder", { kind: "canceled" }, 31, 72),
    backgroundAgent(6, "devin", "Check the gateway's roster schema", { kind: "unknown", reason: "Its process ended without saying how it went." }, 54, 19),
  ]
}

function agentsChoice(): string | null {
  return "location" in globalThis ? new URLSearchParams(globalThis.location.search).get("agents") : null
}

function roster(binding: string): NativeAgent[] {
  const choice = agentsChoice()
  if (choice) return namedRoster(binding, choice)
  const now = Date.now()
  return [
    ...AGENTS.map(([title, activity, toolUses, elapsed], index): NativeAgent => ({
      bindingId: binding,
      provider: "claude",
      nativeId: `busy-agent-${index}`,
      title,
      work: "agent",
      background: true,
      stoppable: true,
      state: { kind: "working", activity },
      observedAt: now,
      startedAt: now - elapsed,
      usage: { toolUses },
    })),
    ...COMMANDS.map((command, index): NativeAgent => ({
      bindingId: binding,
      provider: "claude",
      nativeId: `busy-command-${index}`,
      title: command,
      detail: command,
      work: "command",
      background: true,
      stoppable: true,
      state: { kind: "working" },
      observedAt: now,
      startedAt: now - (index + 2) * 60_000,
    })),
  ]
}

const PROMPTS = [
  "Read the MetaHarness track plan and tell me where the phone composer stands.",
  "Why does clicking + for a project open the wrong folder?",
  "The terminal for our app is broken on the phone. Find out why.",
  "Look at the referenced conversation and pick up where it left off.",
  "Can you pick up where the review agent stopped?",
  "I am running npm run web and the page is blank. What happened?",
  "The update failed during install. Read the log and fix it.",
  "Make the composer's chips match the desktop's.",
  "Run the full checks again once the lock frees.",
]

const ANSWERS = [
  "The plan has four tracks. The phone composer is the second: its chips are drafted, its send button is done, and dictation is waiting on the recognizer fix. The review screen is the third and is blocked on the hunks reader.",
  "The + reads the folder from the row under the pointer, and a folded Thread's row names its first Session's folder, which is a worktree. It should take the project folder the row is grouped under. I changed `FolderSection` to pass its own folder and added a case to the rail's tests.",
  "The terminal opens its socket before the page knows its origin, so on a phone the first connection goes to the wrong host and never retries. It now waits for the origin and retries once on a refused socket.",
  "The referenced conversation stopped after the decoder fixtures were written but before they were checked in. I read them, confirmed they match the captured streams, and checked them in.",
  "The review agent stopped while waiting for the heavy-run lock. I took the lock once it freed and finished its run: every case passes except the one that needs a second device.",
  "The dev server served the page before the bundle finished, and the service worker cached the empty page. Clearing the cache fixes it locally; I made the worker skip caching while the bundle is still building.",
  "The installer quit before the host had released its lock, so the new host couldn't start. It now waits for the old host to leave before replacing the app.",
  "The phone's chips now read their model and access the way the desktop's do, from the same descriptors, so the two never drift.",
  "The composer agent is queued behind the review agent's full phone test run on every device, which has held the heavy-run lock for about 43 minutes. Memory is fine: about 1 GB of swap still free.",
]

/** A Session's prompts, the person's, sent 25 minutes apart from its start. */
function busyRequests(prefix: string, count: number, startedAt: number): LiveRequest[] {
  return PROMPTS.slice(0, count).map((text, index) => ({
    id: `${prefix}-${String(index).padStart(4, "0")}-4000-8000-000000000000`.slice(0, 36),
    createdAt: startedAt + index * 25 * 60_000,
    text,
    attachments: [],
    status: "completed",
    tuning: { model: "claude-opus-5-5", options: { effort: "high" } },
    mode: "full",
  }))
}

/** One of the Thread's Sessions, opened: the first is the long one, waiting on its background work. */
export function busySnapshot(index: number): LiveSnapshot {
  const entry = BUSY_SESSIONS[index]!
  const long = index === 0
  const createdAt = startedAt(index)
  const requests = busyRequests(`b${index}b0b0b0`, long ? PROMPTS.length : 2, askedFrom(index))
  const blocks: LiveSnapshot["blocks"] = requests.flatMap((request, turn) => [
    { type: "user" as const, text: request.text, requestId: request.id },
    { type: "tool" as const, id: `${entry.conversation}-read-${turn}`, toolKind: "read" as const, title: "Read docs/meta-harness/tracks.md", input: "{\"path\":\"docs/meta-harness/tracks.md\"}", output: "# Tracks", status: "completed" as const },
    { type: "tool" as const, id: `${entry.conversation}-run-${turn}`, toolKind: "execute" as const, title: "npm run test:web", input: "{\"command\":\"npm run test:web\"}", output: "ok", status: "completed" as const },
    { type: "text" as const, text: ANSWERS[turn] ?? ANSWERS[0]! },
  ])
  if (long) blocks.splice(blocks.length - 1, 0, { type: "event", label: "Background task finished", detail: "Agent \"Fix wave 2 composer findings\" is waiting on its own background work" })
  return {
    session: {
      id: entry.conversation,
      harness: entry.harness,
      nativeId: `busy-native-${index}`,
      cwd: BUSY_CWD,
      title: entry.title,
      connection: "connected",
      status: "ready",
      modes: [
        { id: "default", name: "Ask", access: "ask" },
        { id: "bypassPermissions", name: "Full access", access: "full" },
      ],
      currentMode: "bypassPermissions",
      configOptions: [],
      ...(long && !agentsChoice() && { backgroundTasks: AGENTS.length + COMMANDS.length }),
    },
    revision: 1,
    createdAt,
    threadPath: `/mock/busy-${index}.jsonl`,
    threadId: BUSY_THREAD,
    sessionId: entry.session,
    base: null,
    permissions: [],
    requests,
    blocks,
    control: { activeBindingId: entry.conversation, bindings: [], merges: [], transfers: [], actions: [] },
    ...(long && { nativeAgents: { agents: roster(entry.conversation), limited: false } }),
  }
}

/** The Thread's Sessions as the desktop's host lists them at boot. */
export function busySummaries(): LiveSummary[] {
  return BUSY_SESSIONS.map((_, index) => {
    const { session, revision, createdAt, threadPath, threadId, sessionId, requests, control } = busySnapshot(index)
    return { session, revision, createdAt, threadPath, threadId, sessionId, threadTitle: BUSY_TITLE, promptedAt: personPromptedAt(requests, control?.actions) }
  })
}
