// Explicit isolated fixture for the phone's and the tablet's list in the rail's anatomy; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import type { ListedSession } from "@mako/protocol/thread-listing"
import type { WorkStatus } from "@mako/host/contracts/thread-marks"
import { listedFins } from "@mako/host/contracts/children"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyLiveSnapshot, hydrateLive } from "@/state/live-recovery"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { threadsStore } from "@/state/thread-store"
import { WebClient, WebClientContext } from "@/web-client/client"
import { accountListStore } from "@/web-client/account-list"
import { syncingStore } from "@/web-client/syncing"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { apexFins, apexSnapshots, APEX_CONVERSATION, APEX_CWD, APEX_SESSION, APEX_THREAD, APEX_TITLE } from "./mock-apex-thread"
import { RailScreen } from "./phone-rail-screen"
import "../web-client/style.css"

/*
 * The phone's list (`?form=phone`, the default) and the tablet's rail beside the open Apex (`?form=ipad`), in the
 * desk's rail's anatomy, on the mock bridge's Apex scene (open this page with `?app=apex`): three projects and the
 * chats, the Apex "Mobile polish" with its Fins, a Thread for each Status, one marked unread on another device, one
 * waiting on the person, and Done ones past three days that fold. `?theme=light` draws it light; `?push=on|off|...`
 * is where this browser's notifications stand. `phoneRail.calls()` is every call the list made of an owner, as
 * `conversations.call` would have sent it; `phoneRail.mark(thread, change)` changes a row as its owner would report.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
for (const snapshot of apexSnapshots()) applyLiveSnapshot(snapshot)

const DEVICE = "00000000-0000-4000-8000-0000000000d1"
const now = new Date().toISOString()
const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const id = (index: number, kind: string) => `0000000${kind}-0000-4000-8000-0000000002${String(index).padStart(2, "0")}`

/** The fixture's Threads, by their own ID: `thread(index)`. */
const thread = (index: number) => id(index, "b")

function row(index: number, title: string, folder: string | undefined, minutes: number, extra: Partial<ListedSession> = {}): ListedSession {
  const at = new Date(Date.now() - minutes * MINUTE).toISOString()
  const listed: ListedSession = { session: id(index, "a"), thread: thread(index), threadTitle: title, conversation: id(index, "c"), harness: "claude", title, state: "idle", createdAt: at, activityAt: at, generation: 1, runsOn: { kind: "device", deviceId: DEVICE }, listedAt: now, ...extra }
  if (folder) {
    listed.folder = folder
    listed.project = { folder }
  }
  return listed
}

const status = (workStatus: WorkStatus, ago: number): Partial<ListedSession> => ({ workStatus, workStatusAt: Date.now() - ago })
const API = "/Users/you/api"
const SITE = "/Users/you/site"

const apexRow: ListedSession = {
  session: APEX_SESSION,
  thread: APEX_THREAD,
  threadTitle: APEX_TITLE,
  conversation: APEX_CONVERSATION,
  harness: "claude",
  title: APEX_TITLE,
  state: "working",
  folder: APEX_CWD,
  project: { folder: APEX_CWD },
  createdAt: new Date(Date.now() - MINUTE).toISOString(),
  activityAt: new Date(Date.now() - MINUTE).toISOString(),
  generation: 1,
  runsOn: { kind: "device", deviceId: DEVICE },
  listedAt: now,
  fins: listedFins(apexFins()),
}

accountListStore.set({
  phase: "live",
  rows: [
    apexRow,
    row(1, "Refactor the composer focus", APEX_CWD, 60, status("in-progress", DAY)),
    row(2, "Sheet motion review", APEX_CWD, 34, { markedUnread: true, harness: "codex" }),
    row(3, "Haptics audit", APEX_CWD, 8, { state: "waiting", waitingFor: "approval", waitingOn: "Approve: npm ci", harness: "cursor" }),
    row(4, "Push token refresh", APEX_CWD, 26 * 60, status("done", DAY)),
    row(5, "Dictation fallback", APEX_CWD, 6 * 24 * 60, status("done", 5 * DAY)),
    row(6, "Offline outbox retry", APEX_CWD, 9 * 24 * 60, status("done", 8 * DAY)),
    row(7, "Ship the billing webhooks", API, 10, status("in-review", 2 * 60 * MINUTE)),
    row(8, "Trace the flaky webhook", API, 20, { ...status("backlog", DAY), harness: "codex" }),
    row(9, "Wire the payments retry queue", API, 40, { state: "failed" }),
    row(10, "Make the pricing table responsive", SITE, 23 * 60, status("done", 20 * 60 * MINUTE)),
    row(11, "What does the probe read?", undefined, 3 * 60, { harness: "codex" }),
  ],
  devices: new Map([[DEVICE, { id: DEVICE, kind: "desktop", name: "Studio", platform: "darwin" }]]),
})

/** Every call made of an owner, as `conversations.call` would have sent it. */
const calls: Array<{ conversation: string; channel: string; args: unknown[] }> = []

// A stand-in for the started client, without its constructor's gateway: its conversations are in the store already,
// opening one shows it, and a call is noted and answered at once.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-rail-check", name: "Ada", email: "ada@example.com", image: null, entitlements: [] },
  list: { refresh: async () => undefined },
  options: { origin: location.origin, base: "/" },
  gateway: { wake: () => undefined },
  push: {
    seen: async () => undefined,
    standing: async () => ({ standing: search.get("push") ?? "off", quietHours: null }),
    enable: async () => "on",
  },
  conversations: async () => ({
    open: (session: { row: { conversation: string } }) => {
      const conversation = session.row.conversation
      acp.activate(conversation, false)
      if ((acpStore.get().conversations[conversation]?.projection?.exchanges.length ?? 0) > 0) return () => undefined
      syncingStore.set({ conversation })
      void hydrateLive(conversation).finally(() => syncingStore.set({ conversation: undefined }))
      return () => undefined
    },
    call: async (conversation: string, channel: string, args: unknown[]) => {
      calls.push({ conversation, channel, args })
      return null
    },
  }),
})

Reflect.set(window, "phoneRail", {
  calls: () => calls,
  /** A row changed as its owner reports it: `{ markedUnread: undefined }` clears the mark. */
  mark(threadId: string, change: Partial<Pick<ListedSession, "workStatus" | "workStatusAt" | "markedUnread">>) {
    accountListStore.set({
      rows: accountListStore.get().rows.map((each) => {
        if (each.thread !== threadId) return each
        const next: ListedSession = { ...each, ...change }
        // A field set to undefined is one the owner no longer says.
        for (const key of ["workStatus", "workStatusAt", "markedUnread"] as const) if (next[key] === undefined) delete next[key]
        return next
      }),
    })
  },
})

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <RailScreen wide={search.get("form") === "ipad"} opened={search.get("open") ?? undefined} />
      <Toaster position="top-center" />
    </WebClientContext>
  </TooltipProvider>
)
