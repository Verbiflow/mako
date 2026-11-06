// Explicit isolated fixture for choosing a Thread's Session on the web; never imported by the application entry point.
import { useState } from "react"
import { createRoot } from "react-dom/client"
import type { ListedSession } from "@mako/protocol/thread-listing"
import type { LiveRequest, LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { Toaster } from "@/components/ui/sonner"
import { acp, acpStore } from "@/state/acp"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { store } from "@/state/session"
import { threadsStore } from "@/state/thread-store"
import { accountListStore } from "@/web-client/account-list"
import { WebClient, WebClientContext } from "@/web-client/client"
import Desk from "@/web-client/desk"
import type { WebRoute } from "@/web-client/route"
import { applyTheme } from "@/web-client/theme"
import { ThreadScreen } from "@/web-client/thread"
import type { WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/*
 * A Thread of four Sessions as one Mac lists it to the account, the shape of the one whose old fork took a "Please
 * continue" meant for its newest Session: a Cursor fork started 22 days ago and last sent a message 20 days ago, two
 * Claude Code Sessions after it, and the Cursor Session worked in four hours ago, idle between turns. Through the web
 * app's production pieces on the mock bridge, under a finger (`?form=phone`, `?form=tablet`: `ThreadScreen`) or in a
 * laptop's browser (`?form=desk`: `Desk`). Unnamed, the Thread opens on its own pick, its first: the fork. `?session=fork`
 * names the fork in the address, as the person's pick; `?woke` gives it the message that woke it.
 * `?theme=light` draws it light. `test-session-picker-ui.mjs` drives it.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")
const form = search.get("form") === "tablet" ? "tablet" : search.get("form") === "desk" ? "desk" : "phone"

const mock = installMockBridge()
const refused = () => Promise.reject(new Error("That isn't offered in the browser."))
if (window.mako)
  window.mako = {
    ...window.mako,
    checkoutHeads: refused,
    worktrees: refused,
    worktreeSummaries: refused,
    worktreeInventory: refused,
    threadGroups: refused,
    threadTitles: refused,
    threadPurposes: refused,
    threadArchives: refused,
    threadAppMarks: refused,
    lostVersions: refused,
  }

const STUDIO = "5f0d0000-0000-4000-8000-00000000d0d0"
const THREAD = "98793b4c-0000-4000-8000-000000000098"
const FOLDER = "/Users/ana/mako"
const NOW = Date.now()
const minutes = (count: number) => NOW - count * 60_000
const days = (count: number) => NOW - count * 24 * 60 * 60_000
const iso = (at: number) => new Date(at).toISOString()

interface Scene {
  key: string
  session: string
  conversation: string
  harness: string
  title: string
  createdAt: number
  turns: { text: string; at: number; answer: string }[]
  forkOf?: string
}

const SCENES: Scene[] = [
  {
    key: "fork",
    session: "febe2eab-0000-4000-8000-000000000009",
    conversation: "f422704f-0000-4000-8000-000000000009",
    harness: "cursor",
    title: "Thread Environments, the review screen",
    createdAt: days(22),
    forkOf: "389ffc4d-0000-4000-8000-000000000008",
    turns: [{ text: "Wire the phone's review screen to the Thread's environment.", at: days(20), answer: "The review screen reads the Thread's environment now, and its tests pass." }],
  },
  {
    key: "claude-a",
    session: "66906e82-0000-4000-8000-000000000011",
    conversation: "66906e82-1111-4000-8000-000000000011",
    harness: "claude",
    title: "Audit the move dividers",
    createdAt: days(19),
    turns: [{ text: "Audit the move dividers on the phone.", at: days(19), answer: "Two dividers drew twice; both are fixed." }],
  },
  {
    key: "claude-b",
    session: "33db0c6d-0000-4000-8000-000000000012",
    conversation: "33db0c6d-1111-4000-8000-000000000012",
    harness: "claude",
    title: "Profile the rail on a cold start",
    createdAt: days(15),
    turns: [{ text: "Profile the rail on a cold start.", at: days(15), answer: "The rail paints in 140 ms; the fold was the slow part." }],
  },
  {
    key: "newest",
    session: "58424503-0000-4000-8000-000000000014",
    conversation: "58424503-1111-4000-8000-000000000014",
    harness: "cursor",
    title: "Ship the session picker",
    createdAt: days(2),
    turns: [{ text: "Make the session picker say which Session a message goes to.", at: minutes(240), answer: "The picker is in. Next, the line that asks before a send to an old Session." }],
  },
]

const WOKE = "Please continue and stop bothering me"
const woke = search.has("woke")

function requestsOf(scene: Scene): LiveRequest[] {
  const turns = woke && scene.key === "fork" ? [...scene.turns, { text: WOKE, at: minutes(3), answer: "Continuing with the review screen." }] : scene.turns
  return turns.map((turn, index) => ({ id: `${scene.conversation.slice(0, 8)}-${String(index).padStart(4, "0")}-4000-8000-000000000000`, createdAt: turn.at, text: turn.text, attachments: [], status: "completed" }))
}

function rowOf(scene: Scene): ListedSession {
  const requests = requestsOf(scene)
  const listed: ListedSession = {
    session: scene.session,
    thread: THREAD,
    threadTitle: "Thread Environments and the phone's review screen",
    conversation: scene.conversation,
    harness: scene.harness,
    title: scene.title,
    state: "idle",
    folder: FOLDER,
    createdAt: iso(scene.createdAt),
    // Read on another device this evening: its journal's write is the newest, and says nothing of who worked in it.
    activityAt: iso(scene.key === "fork" || scene.key === "claude-a" ? minutes(30) : requests.at(-1)!.createdAt!),
    promptedAt: iso(requests.at(-1)!.createdAt!),
    generation: 1,
    runsOn: { kind: "device", deviceId: STUDIO },
    listedAt: iso(NOW),
  }
  if (scene.forkOf) listed.forkOf = scene.forkOf
  return listed
}

function snapshotOf(scene: Scene): LiveSnapshot {
  const requests = requestsOf(scene)
  const answers = woke && scene.key === "fork" ? [...scene.turns.map((turn) => turn.answer), "Continuing with the review screen."] : scene.turns.map((turn) => turn.answer)
  return {
    session: { id: scene.conversation, harness: scene.harness, cwd: FOLDER, title: scene.title, connection: "hibernated", status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 1,
    createdAt: scene.createdAt,
    threadId: THREAD,
    sessionId: scene.session,
    base: null,
    permissions: [],
    requests,
    blocks: requests.flatMap((request, index) => [
      { type: "user" as const, text: request.text, requestId: request.id },
      { type: "text" as const, text: answers[index]! },
    ]),
    control: { activeBindingId: scene.conversation, bindings: [], merges: [], transfers: [], actions: [] },
  }
}

threadsStore.set({ composerHarness: "cursor", descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
accountListStore.set({
  phase: "live",
  rows: SCENES.map(rowOf),
  devices: new Map([[STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "darwin" }]]),
})

const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check", name: "You", email: "you@example.com", image: null, entitlements: [] },
  deviceId: "browser-check",
  options: { origin: location.origin, base: "/", build: "fixture" },
  gateway: { wake: () => undefined, rest: async () => Promise.reject(new Error("The fixture has no gateway")) },
  push: { seen: async () => undefined },
  conversations: async () => ({
    open: (session: WebSession) => {
      const scene = SCENES.find((each) => each.conversation === session.row.conversation)!
      const snapshot = snapshotOf(scene)
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

/** The Session the page opens on: the one named, else none, so the Thread picks its own. */
const named = SCENES.find((scene) => scene.key === search.get("session"))?.session

export function TouchPage() {
  const [session, setSession] = useState(named)
  return <ThreadScreen key={THREAD} threadId={THREAD} sessionId={session} wide={form === "tablet"} onBack={() => undefined} onSession={setSession} onThread={() => undefined} onStarted={() => undefined} />
}

export function DeskPage() {
  const [route, setRoute] = useState<WebRoute>({ kind: "thread", thread: THREAD, ...(named && { session: named }) })
  return <Desk route={route} navigate={(next) => setRoute(next)} back={() => setRoute({ kind: "list" })} onStarted={() => undefined} />
}

Reflect.set(window, "sessionPickerCheck", { scenes: SCENES.map(({ key, session, conversation }) => ({ key, session, conversation })) })

createRoot(document.getElementById("root")!).render(
  <WebClientContext value={client}>
    <div className="web-app flex h-dvh w-full overflow-hidden bg-shell text-foreground" data-form={form}>
      {form === "desk" ? (
        <DeskPage />
      ) : (
        <main className="relative flex min-w-0 flex-1 flex-col">
          <TouchPage />
        </main>
      )}
    </div>
    <Toaster />
  </WebClientContext>
)
