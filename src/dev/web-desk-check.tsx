// Explicit isolated fixture for the web app's desk form; never imported by the application entry point.
import { lazy, Suspense, useState } from "react"
import { createRoot } from "react-dom/client"
import type { ListedSession } from "@mako/protocol/thread-listing"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { nativeStartedAt, personPromptedAt } from "@mako/host/contracts/worked-at"
import { Toaster } from "@/components/ui/sonner"
import { acp, acpStore } from "@/state/acp"
import { getMako } from "@/lib/bridge"
import { applyLiveBatch, applyLiveSnapshot } from "@/state/live-recovery"
import { store } from "@/state/session"
import { threadsStore } from "@/state/thread-store"
import { setSetupSource } from "@/state/setup"
import { openSetup } from "@/web-client/setup-open"
import { accountListStore } from "@/web-client/account-list"
import { WebClient, WebClientContext } from "@/web-client/client"
import { WebApp } from "@/web-client/app"
import type { WebRoute } from "@/web-client/route"
import { webSetup } from "@/web-client/setup-source"
import { applyTheme } from "@/web-client/theme"
import type { WebSession } from "@/web-client/threads"
import { fixtureHarnesses } from "./harness-fixtures"
import { BUSY_CWD, BUSY_SESSIONS, BUSY_THREAD, BUSY_TITLE, busyActivity, busySnapshot } from "./mock-busy-thread"
import { apexFins, apexSnapshot, placedSnapshot, APEX_CONVERSATION, APEX_CWD, APEX_SESSION, APEX_THREAD, APEX_TITLE, PLACED_ASKS, PLACED_CONVERSATION, PLACED_DEVICE, PLACED_SCENE, PLACED_SESSION, PLACED_THREAD, PLACED_TITLE, PLACED_WHERE } from "./mock-apex-thread"
import { listedFins } from "@mako/host/contracts/children"
import { installMockBridge, MOCK_HEADS } from "./mock-bridge"
import { mockThreads } from "./mock-runtime-fixtures"
import "../web-client/style.css"

/*
 * The web app in a laptop's browser (`Desk`) through its production pieces, on the mock bridge: the account's list
 * holds the threads the desktop's `?mock&app=busy` desk lists (the same titles, agents and folders, run on one Mac),
 * and opening one draws its conversation from the same fixtures. `test-web-desk-ui.mjs` drives it beside the desktop.
 * `?thread=busy` opens the busy Thread, `?thread=apex` the mock Apex (`&turns=260` for a long one), `?settings` the
 * Settings pane, and `?setup=<project>` that project's Setup in it, on an account broker with nothing to list;
 * `?theme=light` draws it light; `?machine` runs the Threads on a Linux machine of the person's own.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

const mock = installMockBridge()
// As the browser's own bridge answers (`WebConversations`): a conversation's calls go to its owner, and what only a
// Mac's own window asks of its host (its checkouts' branches, worktrees, the Thread store) isn't offered.
const refused = () => Promise.reject(new Error("That isn't offered in the browser."))
if (window.mako)
  window.mako = {
    ...window.mako,
    checkoutHeads: refused,
    worktrees: refused,
    worktreeSummaries: refused,
    worktreeInventory: refused,
    storage: refused,
    freeStorage: refused,
    threadGroups: refused,
    threadTitles: refused,
    threadPurposes: refused,
    threadArchives: refused,
    threadAppMarks: refused,
    lostVersions: refused,
  }
const STUDIO = "5f0d0000-0000-4000-8000-00000000d0d0"
const now = new Date().toISOString()

/** A stable UUID from a fixture's own name, so a row keeps its IDs across reloads. */
function uuid(seed: string, kind: number): string {
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `${hash.toString(16).padStart(8, "0")}-000${kind}-4000-8000-${hash.toString(16).padStart(12, "0")}`
}

/**
 * A row as the Mac running it lists it (link version 14): with what its rail shows, the project it's filed under and
 * what that project has checked out (the desktop fixture's own checkouts), when the person last wrote to it, and
 * whether another app has it open.
 */
function row(fields: Pick<ListedSession, "session" | "thread" | "conversation" | "harness" | "createdAt" | "activityAt"> & Partial<ListedSession>): ListedSession {
  const listed: ListedSession = { state: "idle", generation: 1, runsOn: { kind: "device", deviceId: STUDIO }, listedAt: now, ...fields }
  if (fields.folder) {
    const head = MOCK_HEADS.get(fields.folder)
    listed.project = head ? { folder: fields.folder, head } : { folder: fields.folder }
  }
  return listed
}

// The desktop's native threads, as the Mac running them lists them to the account.
const native = mockThreads().threads.map((ref) => {
  const listed = row({
    session: uuid(ref.path, 1),
    thread: uuid(ref.path, 2),
    conversation: uuid(ref.path, 3),
    harness: ref.harness,
    title: ref.title,
    folder: ref.cwd,
    createdAt: new Date(nativeStartedAt(ref)!).toISOString(),
    activityAt: ref.updatedAt,
  })
  if ("lineage" in ref && ref.lineage) listed.lineage = ref.lineage.map((origin) => origin.harness)
  // A session its own app holds, as the Mac's rail rings it.
  if ("locked" in ref && ref.locked) listed.openElsewhere = true
  return listed
})
const busy = BUSY_SESSIONS.map((entry, index) => {
  const snapshot = busySnapshot(index)
  return row({
    session: entry.session,
    thread: BUSY_THREAD,
    threadTitle: BUSY_TITLE,
    conversation: entry.conversation,
    harness: entry.harness,
    title: entry.title,
    folder: BUSY_CWD,
    createdAt: new Date(snapshot.createdAt).toISOString(),
    activityAt: new Date(busyActivity(index)).toISOString(),
    promptedAt: new Date(personPromptedAt(snapshot.requests, snapshot.control?.actions)!).toISOString(),
    // The long Session's turn ended with its background work still running: at work on it, as its owner lists it.
    ...(index === 0 && { state: "working" as const, background: 25 }),
  })
})

// The Apex's host answering, as its owner's batches reach the browser: a message sent to it gets its turn.
getMako().onEvent((event) => {
  if (event.type === "live-batch" && event.batch.id === APEX_CONVERSATION) applyLiveBatch(event.batch)
})
const apex = row({ session: APEX_SESSION, thread: APEX_THREAD, threadTitle: APEX_TITLE, conversation: APEX_CONVERSATION, harness: "claude", title: APEX_TITLE, folder: APEX_CWD, createdAt: now, activityAt: now })

// `?placed=loft|off`: a Fin of the Apex's placed on Loft, which lists it to the account under its Apex; `off` leaves the
// Apex's own device quiet, the Fin's row still saying what it asks.
if (PLACED_SCENE) apex.fins = listedFins(apexFins())
const placedRow = row({ session: PLACED_SESSION, thread: PLACED_THREAD, conversation: PLACED_CONVERSATION, harness: "opencode", title: PLACED_TITLE, state: "waiting", waitingOn: PLACED_ASKS, waitingFor: "approval", runsOn: { kind: "device", deviceId: PLACED_DEVICE }, createdAt: now, activityAt: now })
threadsStore.set({ composerHarness: "claude", descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
accountListStore.set({
  phase: "live",
  ...(PLACED_SCENE === "off" && { quiet: new Map([[STUDIO, new Date(Date.now() - 25 * 60_000).toISOString()]]) }),
  rows: [...busy, apex, ...(placedSnapshot() ? [placedRow] : []), ...native],
  // `?machine`: the Threads run on a machine of the person's own, so the rail, the strip and the chip wear its server.
  devices: new Map([
    [STUDIO, search.has("machine") ? { id: STUDIO, kind: "runtime", name: "build-box", platform: "Linux x64 · Ubuntu 24.04" } : { id: STUDIO, kind: "desktop", name: "Studio", platform: "darwin" }],
    [PLACED_DEVICE, { id: PLACED_DEVICE, kind: "runtime", name: PLACED_WHERE, platform: "Linux x64 · Debian GNU/Linux 12" }],
  ]),
})

/** What another Session's owner answers when it's opened: its record, a short exchange. */
function opened(session: WebSession): LiveSnapshot {
  const index = BUSY_SESSIONS.findIndex((entry) => entry.conversation === session.row.conversation)
  if (index >= 0) return busySnapshot(index)
  if (session.row.conversation === APEX_CONVERSATION) return apexSnapshot()
  const placed = placedSnapshot()
  if (placed && session.row.conversation === PLACED_CONVERSATION) return placed
  const request = { id: uuid(session.row.conversation, 4), text: session.row.title ?? "Go on", attachments: [], status: "completed" as const }
  return {
    ...session.summary,
    session: { ...session.summary.session, connection: "connected", status: "ready" },
    base: null,
    permissions: [],
    requests: [request],
    blocks: [
      { type: "user", text: request.text, requestId: request.id },
      { type: "text", text: "Done. The change is in and its tests pass." },
    ],
  }
}

// A stand-in for the started client, without its constructor's gateway: what the desk asks of it, answered from the
// fixtures. Opening a Session applies its snapshot as its owner's would arrive.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check", name: "You", email: "you@example.com", image: null, entitlements: [] },
  deviceId: "browser-check",
  options: { origin: location.origin, base: search.get("app") !== null ? "/scripts/web-desk.html/" : "/", build: "fixture" },
  gateway: { wake: () => undefined, connection: async () => ({ cloud: location.origin }), rest: async (_method: string, path: string) => ((search.get("setup") || search.get("side") === "setup") && path.startsWith("/v1/borrow/") ? { grants: [], leases: [], events: [], asks: [] } : Promise.reject(new Error("The fixture has no gateway"))) },
  list: { refreshDevices: async () => undefined },
  push: { seen: async () => undefined, standing: async () => ({ standing: "unsupported", quietHours: null, timeZone: "UTC" }) },
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

/** What `test-web-desk-ui.mjs` drives as the account would: a Session another device starts, listed. */
Reflect.set(window, "webDeskCheck", {
  list(title: string, folder: string) {
    const listed = row({ session: uuid(title, 1), thread: uuid(title, 2), conversation: uuid(title, 3), harness: "codex", title, folder, createdAt: new Date().toISOString(), activityAt: new Date().toISOString(), state: "working" })
    accountListStore.set({ rows: [listed, ...accountListStore.get().rows] })
  },
})

// `&side=setup` opens Setup in the right rail over the Thread on screen.
if (search.get("side") === "setup") openSetup()
// The mock bridge would answer the page's first read; a real browser has only the account broker's source.
if (search.get("setup")) setSetupSource(webSetup(client.gateway, "acct", () => []))

function initialRoute(): WebRoute {
  if (search.get("thread") === "busy") return { kind: "thread", thread: BUSY_THREAD, session: BUSY_SESSIONS[0].session }
  if (search.get("thread") === "apex") return { kind: "thread", thread: APEX_THREAD, session: APEX_SESSION }
  if (search.get("setup")) return { kind: "setup", project: search.get("setup")! }
  if (search.get("settings") !== null) return { kind: "settings" }
  return { kind: "list" }
}

/**
 * The desk, read as the app reads it: a module of its own, so `?app` keeps the app's own chunks (the desk, a Thread, New)
 * apart from the page's first code, as `test-lazy-pieces-ui.mjs` needs to hold and fail them.
 */
const Desk = lazy(() => import("@/web-client/desk"))

/** The desk at its route, as the app holds it. */
export function WebDeskPage() {
  const [route, setRoute] = useState<WebRoute>(initialRoute)
  return (
    <Suspense fallback={null}>
      <Desk route={route} navigate={(next) => setRoute(next)} back={() => setRoute({ kind: "list" })} onStarted={() => undefined} />
    </Suspense>
  )
}

// `?app` mounts the web app itself (`WebApp`) on the same stand-in client, in whatever form the page's input and width
// ask for, with its screens read as code of their own: what `test-lazy-pieces-ui.mjs` holds and fails.
createRoot(document.getElementById("root")!).render(
  search.get("app") !== null ? (
    <WebClientContext value={client}>
      <WebApp />
    </WebClientContext>
  ) : (
    <WebClientContext value={client}>
      <div className="web-app flex w-full overflow-hidden bg-shell text-foreground" data-form="desk">
        <WebDeskPage />
      </div>
      <Toaster />
    </WebClientContext>
  )
)
