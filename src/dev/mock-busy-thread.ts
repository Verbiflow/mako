import type { LiveRequest, LiveSnapshot, LiveSummary } from "@mako/host/contracts/live-conversations"
import type { NativeAgent } from "@mako/host/contracts/native-agents"

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

/** The Thread's Sessions, the one that started first first, as its tabs are ordered. */
export const BUSY_SESSIONS = [
  { conversation: "b0b0b0b0-0001-4000-8000-00000000b0b0", session: "b0b0b0b0-1001-4000-8000-00000000b0b0", harness: "claude", title: "I'll read the MetaHarness track plan and the phone composer" },
  { conversation: "b0b0b0b0-0002-4000-8000-00000000b0b0", session: "b0b0b0b0-1002-4000-8000-00000000b0b0", harness: "claude", title: "I'll read the MetaHarness track plan for the review screen" },
  { conversation: "b0b0b0b0-0003-4000-8000-00000000b0b0", session: "b0b0b0b0-1003-4000-8000-00000000b0b0", harness: "codex", title: "Cut bytes per streamed token" },
  { conversation: "b0b0b0b0-0004-4000-8000-00000000b0b0", session: "b0b0b0b0-1004-4000-8000-00000000b0b0", harness: "claude", title: "Cloud PRs as the person, opt-in" },
] as const

export const BUSY_TITLE = "Thread Environments and the phone's review screen"

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

function roster(binding: string): NativeAgent[] {
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

function busyRequests(prefix: string, count: number): LiveRequest[] {
  return PROMPTS.slice(0, count).map((text, index) => ({
    id: `${prefix}-${String(index).padStart(4, "0")}-4000-8000-000000000000`.slice(0, 36),
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
  const requests = busyRequests(`b${index}b0b0b0`, long ? PROMPTS.length : 2)
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
      ...(long && { backgroundTasks: AGENTS.length + COMMANDS.length }),
    },
    revision: 1,
    createdAt: STARTED + index * 60_000,
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
    const { session, revision, createdAt, threadId, sessionId } = busySnapshot(index)
    return { session, revision, createdAt, threadId, sessionId, threadTitle: BUSY_TITLE }
  })
}
