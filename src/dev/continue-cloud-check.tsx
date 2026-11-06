// Explicit isolated fixture for Continue in the cloud in the web app; never imported by the application entry point.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { ContinueOffer, ContinueState } from "@mako/protocol/continues"
import type { ListedSession } from "@mako/protocol/thread-listing"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { Toaster } from "@/components/ui/sonner"
import { acp, acpStore } from "@/state/acp"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { store } from "@/state/session"
import { threadsStore } from "@/state/thread-store"
import { accountListStore } from "@/web-client/account-list"
import { WebClient, WebClientContext } from "@/web-client/client"
import Desk from "@/web-client/desk"
import { endMove, putMove } from "@/web-client/moves"
import type { WebRoute } from "@/web-client/route"
import { applyTheme } from "@/web-client/theme"
import { ThreadScreen } from "@/web-client/thread"
import type { WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/*
 * Continue in the cloud through the web app's production pieces, on the mock bridge: a Thread whose Mac went quiet
 * 25 minutes ago, its row idle in a worktree on a pushed branch, offered to continue in a cloud machine; the account's
 * answers come from here. `?form=phone` draws the phone's Thread screen, else the laptop's desk; `?theme=light`;
 * `?scene=` picks what the Thread shows: `offer` (the default), `behind` (the copy newer than what the Mac sent),
 * `making`, `arriving`, `done`, `failed` (a press refused), `failed-listed` (a continue that failed, as the list says it),
 * `working` (a row that was working as its Mac went quiet), `older` (a Mac from before continues).
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")
const scene = search.get("scene") ?? "offer"
const phone = search.get("form") === "phone"

const mock = installMockBridge()
const STUDIO = "5f0d0000-0000-4000-8000-00000000d0d0"
const THREAD = "7c0a0000-0000-4000-8000-0000000c0c01"
const SESSION = "7c0a0000-0000-4000-8000-0000000c0c02"
const CONVERSATION = "7c0a0000-0000-4000-8000-0000000c0c03"
const CLOUD_THREAD = "7c0a0000-0000-4000-8000-0000000c0c04"
const FOLDER = "/Users/ada/src/payments"
const BRANCH = "mako/retry-backoff"
const now = Date.now()
const quietSince = new Date(now - 25 * 60_000).toISOString()
const sentAt = new Date(now - 26 * 60_000).toISOString()

const continued = scene === "failed-listed" ? { op: "7c0a0000-0000-4000-8000-0000000c0c05", phase: "failed" as const, from: STUDIO, by: "browser-check", cloudThread: CLOUD_THREAD, at: quietSince, reason: "The cloud machine couldn't clone mako/retry-backoff: the branch isn't on GitHub any more." } : undefined
const row: ListedSession = {
  session: SESSION,
  thread: THREAD,
  conversation: CONVERSATION,
  harness: "codex",
  title: "Retry failed charges with backoff",
  threadTitle: "Retry failed charges with backoff",
  state: scene === "working" ? "working" : "idle",
  generation: 3,
  runsOn: { kind: "device", deviceId: STUDIO },
  createdAt: new Date(now - 3 * 3600_000).toISOString(),
  activityAt: sentAt,
  listedAt: sentAt,
  folder: FOLDER,
  project: { folder: FOLDER },
  nativeId: "019a0000-0000-7000-8000-00000000c0de",
  worktree: { branch: BRANCH },
  repository: { url: "https://github.com/ada/payments", branch: BRANCH },
}
if (continued) row.continued = continued
const others: ListedSession[] = [
  { ...row, session: "7c0a0000-0000-4000-8000-0000000d0d02", thread: "7c0a0000-0000-4000-8000-0000000d0d01", conversation: "7c0a0000-0000-4000-8000-0000000d0d03", harness: "claude", title: "Refund webhook signature check", threadTitle: "Refund webhook signature check", activityAt: new Date(now - 5 * 3600_000).toISOString(), worktree: { branch: "mako/refund-signature" }, repository: { url: "https://github.com/ada/payments", branch: "mako/refund-signature" } },
  { ...row, session: "7c0a0000-0000-4000-8000-0000000e0e02", thread: "7c0a0000-0000-4000-8000-0000000e0e01", conversation: "7c0a0000-0000-4000-8000-0000000e0e03", title: "Ledger export to CSV", threadTitle: "Ledger export to CSV", activityAt: new Date(now - 26 * 3600_000).toISOString(), worktree: { branch: "mako/ledger-csv" }, repository: { url: "https://github.com/ada/payments", branch: "mako/ledger-csv" } },
]

threadsStore.set({ composerHarness: "codex", descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
accountListStore.set({
  phase: "live",
  rows: [row, ...others],
  devices: new Map([[STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "darwin" }]]),
  quiet: new Map([[STUDIO, quietSince]]),
  continues: scene === "older" ? new Set() : new Set([STUDIO]),
})

const answer = [
  "The retry fix holds. Failed charges now back off from 200 ms, doubling up to 6.4 s, with jitter so two workers never retry in step.",
  "",
  "Next I'd move `MAX_ATTEMPTS` into the queue's config so each queue can tune it.",
].join("\n")

/** The Session's record as its copy holds it: two turns, the last ended. */
function opened(session: WebSession): LiveSnapshot {
  const first = { id: "7c0a0000-0000-4000-8000-0000000f0f01", text: "Retry failed charges with exponential backoff", attachments: [], status: "completed" as const }
  const second = { id: "7c0a0000-0000-4000-8000-0000000f0f02", text: "Add jitter and run the payments tests", attachments: [], status: "completed" as const }
  return {
    ...session.summary,
    session: { ...session.summary.session, connection: "connected", status: "ready" },
    base: null,
    permissions: [],
    requests: [first, second],
    blocks: [
      { type: "user", text: first.text, requestId: first.id },
      { type: "text", text: "Done: `retryDelay` doubles from 200 ms and stops at 6.4 s. The worker retries a failed charge up to six times." },
      { type: "user", text: second.text, requestId: second.id },
      { type: "text", text: answer },
    ],
  }
}

/** What the account answers: the offer (fresh, or with the copy ahead of what the Mac sent), and the press's state. */
const offer: ContinueOffer = {
  offer: true,
  thread: THREAD,
  from: STUDIO,
  since: quietSince,
  folder: FOLDER,
  repository: { url: "https://github.com/ada/payments", branch: BRANCH },
  sessions: [{ session: SESSION, harness: "codex", title: row.title, freshness: { originalsAt: sentAt, copyAt: scene === "behind" ? new Date(now - 25.2 * 60_000).toISOString() : sentAt, behind: scene === "behind" } }],
}
function state(op: string, phase: ContinueState["phase"]): ContinueState {
  const at = new Date().toISOString()
  const session = { session: SESSION, conversation: CONVERSATION, harness: "codex", nativeId: row.nativeId!, generation: row.generation, folder: FOLDER }
  return { op, thread: THREAD, from: STUDIO, by: "7c0a0000-0000-4000-8000-0000000c0c07", cloudThread: CLOUD_THREAD, folder: FOLDER, repository: offer.offer ? offer.repository : { url: "https://github.com/ada/payments" }, sessions: [session], phase, waiting: [], at, changedAt: at }
}
const rest = async (method: string, at: string): Promise<ContinueOffer | ContinueState> => {
  if (method === "GET" && at.endsWith("/continue")) return offer
  const op = /\/continue\/([^/?]+)/.exec(at)?.[1]
  if (op && method === "POST") return state(op, "arriving")
  if (op) {
    await new Promise((resolve) => setTimeout(resolve, 1_500))
    return state(op, "continued")
  }
  throw new Error("The fixture has no gateway")
}

// A stand-in for the started client, without its constructor's gateway: what the Thread asks of it, from the fixtures.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check", name: "Ada", email: "ada@example.com", image: null, entitlements: ["cloud"] },
  deviceId: "browser-check",
  options: { origin: location.origin, base: "/", build: "fixture" },
  gateway: { wake: () => undefined, rest },
  push: { seen: async () => undefined },
  conversations: async () => ({
    open: (session: WebSession) => {
      const snapshot = opened(session)
      mock.setLiveSnapshot(snapshot)
      applyLiveSnapshot(snapshot)
      acp.activate(session.row.conversation, false)
      return () => {
        if (acpStore.get().activeKey === session.row.conversation) acp.deactivate()
      }
    },
    followSteps: () => () => undefined,
    wake: () => undefined,
    resync: () => undefined,
    releaseHidden: () => undefined,
  }),
})

// A continue under way, as this browser follows it after its press.
const mac = { deviceId: STUDIO, name: "Studio" }
const op = "7c0a0000-0000-4000-8000-0000000c0c06"
if (scene === "making" || scene === "arriving" || scene === "done" || scene === "failed") {
  putMove({ thread: THREAD, conversation: CONVERSATION, way: "cloud", mac, move: op, step: scene === "making" ? "making" : "arriving", stepAt: now - (scene === "making" ? 2_000 : 12_000), handOff: false, ours: true, continued: true })
  if (scene === "done") endMove(THREAD, op, { kind: "done" })
  if (scene === "failed") endMove(THREAD, op, { kind: "failed", reason: "The cloud machine couldn't start: no machine was free in time. Nothing moved, and Studio keeps the Thread." })
}

/** The Thread at its scene, as the app draws it on a phone or at a desk. */
export function ContinueCloudPage() {
  const [route, setRoute] = useState<WebRoute>({ kind: "thread", thread: THREAD, session: SESSION })
  if (!phone) return <Desk route={route} navigate={(next) => setRoute(next)} back={() => setRoute({ kind: "list" })} onStarted={() => undefined} />
  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <ThreadScreen threadId={THREAD} sessionId={SESSION} wide={false} onBack={() => undefined} onSession={() => undefined} onThread={() => undefined} onStarted={() => undefined} />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <WebClientContext value={client}>
    <div className="web-app flex w-full overflow-hidden bg-shell text-foreground" data-form={phone ? "phone" : "desk"}>
      <ContinueCloudPage />
    </div>
    <Toaster position={phone ? "top-center" : "top-right"} />
  </WebClientContext>
)
