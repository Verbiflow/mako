// Explicit isolated fixture for the phone's live Session; never imported by the application entry point.
import { Profiler } from "react"
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveRequest, LiveSnapshot } from "@/lib/types"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { listedOwner, listedSummary } from "@mako/host/contracts/listed-conversations"
import { WebClient, WebClientContext } from "@/web-client/client"
import LiveSession from "@/web-client/live-session"
import { applyTheme } from "@/web-client/theme"
import type { WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * The phone's live Session through its production pieces (`LiveSession`: the transcript, the dock, the composer and
 * its chips) on the mock bridge, for `test-phone-composer-ui.mjs` and its screenshots. `window.phoneCheck` drives what
 * the host would: a turn starting and ending, words heard by the platform's recognizer.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

/** The recognizers listening now, which `phoneCheck.say` speaks to. */
const listening = new Set<FakeRecognition>()

/** The platform's recognizer, as Safari's: it hears what `phoneCheck.say` gives it, and ends when stopped. */
class FakeRecognition extends EventTarget {
  lang = ""
  continuous = false
  interimResults = false
  onresult: ((event: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  start() {
    listening.add(this)
  }
  stop() {
    listening.delete(this)
    setTimeout(() => this.onend?.(), 20)
  }
  abort() {
    listening.delete(this)
  }
}
window.SpeechRecognition = FakeRecognition
window.webkitSpeechRecognition = FakeRecognition
// No microphone to share: the bars move with the words heard (`DictationSession`'s fallback), never asking for one.
localStorage.setItem("mako.dictation.meter", "off")

const mock = installMockBridge()
const harness = "codex"
const conversation = "cccccccc-3333-4333-8333-333333333333"
const cwd = "/fixture/payments"

const answer = [
  "The retry fix holds. The backoff now doubles from 200 ms and stops at 6.4 s, so a slow runner gets six tries before the job fails, and the jitter keeps two runners from retrying in step.",
  "",
  "What changed:",
  "",
  "1. `retryDelay` takes the attempt and returns the capped delay.",
  "2. The worker reads `MAX_ATTEMPTS` from the queue's config instead of a constant.",
  "3. A failed charge is kept with its last error, so the dashboard can say why.",
  "",
  "To try it on your machine:",
  "",
  "```sh",
  "npm run test:payments -- --grep backoff",
  "```",
  "",
  "Every case passes, including the one that used to time out on the slow runner.",
].join("\n")

function request(id: string, text: string, model: string, effort: string, mode: string): LiveRequest {
  return { id, text, attachments: [], status: "completed", tuning: { model, options: { effort } }, mode }
}

/** The Session's record: three turns, the access raised and the model changed before the third. */
const requests: LiveRequest[] = [
  request("11111111-1111-4111-8111-111111111111", "Check the retry fix", "gpt-5.5", "medium", "auto"),
  request("22222222-2222-4222-8222-222222222222", "Run the payments tests again", "gpt-5.5", "medium", "auto"),
  request("33333333-3333-4333-8333-333333333333", "Explain what changed", "gpt-5.6-sol", "high", "full-access"),
]

function snapshot(status: "ready" | "running", extra: LiveRequest[] = []): LiveSnapshot {
  return {
    session: {
      id: conversation,
      harness,
      nativeId: "native-phone",
      cwd,
      title: "Retry backoff on slow runners",
      connection: "connected",
      status,
      modes: [
        { id: "read-only", name: "Read Only", access: "plan" },
        { id: "auto", name: "Auto", access: "ask" },
        { id: "full-access", name: "Full Access", access: "full" },
      ],
      currentMode: "full-access",
      configOptions: [],
    },
    revision: Date.now(),
    createdAt: 1,
    base: null,
    permissions: [],
    requests: [...requests, ...extra],
    blocks: [
      { type: "user", text: requests[0]!.text, requestId: requests[0]!.id },
      { type: "tool", id: "read-retry", toolKind: "read", title: "Read src/payments/retry.ts", input: "{\"path\":\"src/payments/retry.ts\"}", output: "export function retryDelay(attempt: number) {}", status: "completed" },
      { type: "text", text: "The fix is in `retryDelay`: it now caps the delay. Running the tests next." },
      { type: "user", text: requests[1]!.text, requestId: requests[1]!.id },
      { type: "tool", id: "run-tests", toolKind: "execute", title: "npm run test:payments", input: "{\"command\":\"npm run test:payments\"}", output: "42 passing", status: "completed" },
      { type: "text", text: "All 42 payment tests pass." },
      { type: "user", text: requests[2]!.text, requestId: requests[2]!.id },
      { type: "text", text: answer },
      ...(status === "running" ? [{ type: "user" as const, text: "Now check the webhook retries too", requestId: "44444444-4444-4444-8444-444444444444" }] : []),
    ],
    control: { activeBindingId: conversation, bindings: [], merges: [], transfers: [], actions: [] },
  }
}

threadsStore.set({ composerHarness: harness, descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
const opened = snapshot("ready")
mock.setLiveSnapshot(opened)
applyLiveSnapshot(opened)
acpStore.set({ activeKey: conversation })

const listed: ListedSession = {
  session: "00000000-0000-4000-8000-000000000001",
  thread: "00000000-0000-4000-8000-000000000002",
  conversation,
  harness,
  state: "idle",
  folder: cwd,
  createdAt: new Date(1).toISOString(),
  activityAt: new Date().toISOString(),
  generation: 1,
  runsOn: { kind: "device", deviceId: "00000000-0000-4000-8000-000000000003" },
  listedAt: new Date().toISOString(),
}
const session: WebSession = { row: listed, owner: listedOwner(listed), summary: listedSummary(listed, "Studio", undefined), where: "Studio", waiting: [] }
// A stand-in for the started client, without its constructor's gateway: this page opens none, and its conversation is
// already in the store. `LiveSession` asks it only for these.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check" },
  gateway: { wake: () => undefined },
  conversations: async () => ({ open: () => () => undefined }),
})

/** Commits of the composer's tree, counted for the re-render check. */
const renders = { composer: 0 }

const check = {
  renders,
  /** A turn starts (with a message queued behind it) or ends, as the host's batch says. */
  setRunning(running: boolean) {
    const queued: LiveRequest[] = running ? [{ id: "44444444-4444-4444-8444-444444444444", text: "Now check the webhook retries too", attachments: [], status: "dispatching", tuning: requests[2]!.tuning, mode: "full-access" }] : []
    applyLiveSnapshot(snapshot(running ? "running" : "ready", queued))
  },
  /** A message waits behind the running turn. */
  queue(text: string) {
    const current = snapshot("running", [
      { id: "44444444-4444-4444-8444-444444444444", text: "Now check the webhook retries too", attachments: [], status: "dispatching", tuning: requests[2]!.tuning, mode: "full-access" },
      { id: "55555555-5555-4555-8555-555555555555", text, attachments: [], status: "queued", tuning: requests[2]!.tuning },
    ])
    applyLiveSnapshot(current)
  },
  /** The recognizer hears `words`, settled or still being heard. */
  say(words: string, final = false) {
    for (const recognizer of listening) recognizer.onresult?.({ resultIndex: 0, results: [{ isFinal: final, 0: { transcript: words } }] })
  },
  listening: () => listening.size > 0,
}
Reflect.set(window, "phoneCheck", check)

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <div className="web-app flex flex-col bg-surface text-foreground">
        <Profiler id="phone" onRender={() => (renders.composer += 1)}>
          <LiveSession session={session} />
        </Profiler>
      </div>
      <Toaster />
    </WebClientContext>
  </TooltipProvider>
)
