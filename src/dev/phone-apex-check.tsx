// Explicit isolated fixture for the phone's Apex and its Fins; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { applyLiveBatch, applyLiveSnapshot, hydrateLive, unloadLive } from "@/state/live-recovery"
import { getMako } from "@/lib/bridge"
import { acp } from "@/state/acp"
import { acpStore } from "@/state/acp-state"
import { threadsStore } from "@/state/thread-store"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { WebClient, WebClientContext } from "@/web-client/client"
import { accountListStore } from "@/web-client/account-list"
import { syncingStore } from "@/web-client/syncing"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { apexSnapshots, APEX_CONVERSATION, APEX_CWD, APEX_SESSION, APEX_THREAD, APEX_TITLE } from "./mock-apex-thread"
import { PhoneApexScreen } from "./phone-apex-screen"
import "../web-client/style.css"

/**
 * The phone's list and an Apex's screen through their production pieces (`ThreadList`, `ThreadScreen`: the bar, the
 * chips, the Fin, the dock and its Stop) on the mock bridge's Apex scene (`?app=apex`), for `test-orch-ui.mjs`.
 * The list's Apex row wears its badge from the Apex's snapshot this page holds, as a phone that opened it does.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
for (const snapshot of apexSnapshots()) applyLiveSnapshot(snapshot)
// The Apex's host moving its Fins on (an answer, a stop), as the gateway brings its batches to the phone.
getMako().onEvent((event) => {
  if (event.type === "live-batch") applyLiveBatch(event.batch)
})

const DEVICE = "00000000-0000-4000-8000-0000000000d1"
const STUDIO = "00000000-0000-4000-8000-0000000000d2"
const now = new Date().toISOString()

function row(session: string, thread: string, conversation: string, title: string, harness: string, state: ListedSession["state"], minutes: number): ListedSession {
  const at = new Date(Date.now() - minutes * 60_000).toISOString()
  return { session, thread, threadTitle: title, conversation, harness, title, state, folder: APEX_CWD, createdAt: at, activityAt: at, generation: 1, runsOn: { kind: "device", deviceId: DEVICE }, listedAt: now }
}

accountListStore.set({
  phase: "live",
  rows: [
    row(APEX_SESSION, APEX_THREAD, APEX_CONVERSATION, APEX_TITLE, "claude", "working", 1),
    row("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000c1", "Release 3 checks", "codex", "idle", 12),
    row("00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000c2", "Fix the flaky login test", "cursor", "idle", 20),
    row("00000000-0000-4000-8000-0000000000a3", "00000000-0000-4000-8000-0000000000b3", "00000000-0000-4000-8000-0000000000c3", "Composer focus after paste", "claude", "idle", 64),
  ],
  // `?machine`: they run on a machine of the person's own, beside a Mac, so its rows and bar wear a server and its name.
  devices: new Map(
    search.has("machine")
      ? [[DEVICE, { id: DEVICE, kind: "runtime", name: "build-box", platform: "Linux x64 · Ubuntu 24.04" }], [STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "darwin" }]]
      : [[DEVICE, { id: DEVICE, kind: "desktop", name: "Studio", platform: "darwin" }]]
  ),
})

// A stand-in for the started client, without its constructor's gateway: its conversations are in the store already,
// and opening one shows it.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check", name: "Ada", email: "", image: null, entitlements: [] },
  list: { refresh: async () => undefined },
  options: { origin: location.origin, base: "/" },
  gateway: { wake: () => undefined },
  push: { seen: async () => undefined },
  conversations: async () => ({
    open: (session: { row: { conversation: string } }) => {
      const conversation = session.row.conversation
      acp.activate(conversation, false)
      // One this page doesn't hold (`phoneApex.forget()`, as a reload leaves it) is read from its owner, "Syncing…"
      // meanwhile, as `WebConversations.open` reads it. One it holds isn't read again here: the checks that move it by
      // batches would see a read put it back.
      if ((acpStore.get().conversations[conversation]?.projection?.exchanges.length ?? 0) > 0) return () => undefined
      syncingStore.set({ conversation })
      void hydrateLive(conversation).finally(() => syncingStore.set({ conversation: undefined }))
      return () => undefined
    },
  }),
})

// The owner's answer to a read takes `?answer=` ms, over the network (default: at once).
const ANSWER_MS = Number(search.get("answer") ?? 0)
const mako = getMako()
const answered = mako.liveSnapshot.bind(mako)
mako.liveSnapshot = async (id) => {
  if (ANSWER_MS) await new Promise((resolve) => setTimeout(resolve, ANSWER_MS))
  return answered(id)
}
/** `forget()`: the Apex's transcript let go, as a reload leaves it, so its next open reads it from its owner. */
Reflect.set(window, "phoneApex", { forget: () => unloadLive(APEX_CONVERSATION) })

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <PhoneApexScreen opened={search.get("open") ?? undefined} inbox={search.get("screen") === "inbox"} />
      <Toaster position="top-center" />
    </WebClientContext>
  </TooltipProvider>
)
