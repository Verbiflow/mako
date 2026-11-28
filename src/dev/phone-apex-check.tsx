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
import { webApexesStore } from "@/web-client/apexes"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { apexCopySnapshot, apexFins, apexSnapshot, apexSnapshots, placedSnapshot, APEX_CONVERSATION, APEX_CWD, APEX_SESSION, APEX_THREAD, APEX_TITLE, PLACED_ASKS, PLACED_CONVERSATION, PLACED_DEVICE, PLACED_SCENE, PLACED_SESSION, PLACED_THREAD, PLACED_TITLE, PLACED_WHERE } from "./mock-apex-thread"
import { listedFins } from "@mako/host/contracts/children"
import { checkPlanItem, listedApex } from "@mako/host/contracts/apexes"
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
// `?placed=loft|off`: a Fin placed on Loft, which lists it to the account; `off` leaves the Apex's device quiet.
const placed = placedSnapshot()
if (placed) applyLiveSnapshot(placed)
// The Apex's host moving its Fins on (an answer, a stop), as the gateway brings its batches to the phone.
// A Mac that's off sends nothing: its conversation stands as its copy says until it's back (`?listed=off`).
getMako().onEvent((event) => {
  if (event.type === "live-batch" && !(LISTED === "off" && event.batch.id === APEX_CONVERSATION && accountListStore.get().quiet.has(DEVICE))) applyLiveBatch(event.batch)
})

const DEVICE = "00000000-0000-4000-8000-0000000000d1"
const STUDIO = "00000000-0000-4000-8000-0000000000d2"
const now = new Date().toISOString()

function row(session: string, thread: string, conversation: string, title: string, harness: string, state: ListedSession["state"], minutes: number): ListedSession {
  const at = new Date(Date.now() - minutes * 60_000).toISOString()
  return { session, thread, threadTitle: title, conversation, harness, title, state, folder: APEX_CWD, createdAt: at, activityAt: at, generation: 1, runsOn: { kind: "device", deviceId: DEVICE }, listedAt: now }
}

const apexRow = row(APEX_SESSION, APEX_THREAD, APEX_CONVERSATION, APEX_TITLE, "claude", "working", 1)
if (PLACED_SCENE) apexRow.fins = listedFins(apexFins())
// `?listed=off`: a page opened while the Apex's Mac is off, which has read nothing from it: its digest is the one the
// account lists on its row (`apex`, with its Fins), as last known; `phoneApex.back()` brings the Mac back, its row
// saying the plan a line on.
const LISTED = search.get("listed")
const [sceneApexes, scenePlan] = await Promise.all([getMako().apexes(), getMako().apexPlan(APEX_THREAD)])
const sceneApex = sceneApexes.find((apex) => apex.thread === APEX_THREAD)
if (LISTED && sceneApex) {
  apexRow.apex = listedApex(sceneApex, scenePlan.text, Date.now() - 30 * 60_000)
  apexRow.fins = listedFins(apexFins())
  // As the browser holds a conversation whose Mac is quiet: read from the copy it keeps in the account.
  if (LISTED === "off") applyLiveSnapshot(apexCopySnapshot("Studio", Date.now() - 26 * 60_000))
}
const placedRow: ListedSession = { ...row(PLACED_SESSION, PLACED_THREAD, PLACED_CONVERSATION, PLACED_TITLE, "opencode", "waiting", 3), folder: "/home/you/.mako/projects/mako/.mako/worktrees/docs-sweep", runsOn: { kind: "device", deviceId: PLACED_DEVICE }, waitingOn: PLACED_ASKS, waitingFor: "approval" }
accountListStore.set({
  phase: "live",
  ...((PLACED_SCENE === "off" || LISTED === "off") && { quiet: new Map([[DEVICE, new Date(Date.now() - 25 * 60_000).toISOString()]]) }),
  rows: [
    apexRow,
    ...(placed ? [placedRow] : []),
    row("00000000-0000-4000-8000-0000000000a1", "00000000-0000-4000-8000-0000000000b1", "00000000-0000-4000-8000-0000000000c1", "Release 3 checks", "codex", "idle", 12),
    row("00000000-0000-4000-8000-0000000000a2", "00000000-0000-4000-8000-0000000000b2", "00000000-0000-4000-8000-0000000000c2", "Fix the flaky login test", "cursor", "idle", 20),
    row("00000000-0000-4000-8000-0000000000a3", "00000000-0000-4000-8000-0000000000b3", "00000000-0000-4000-8000-0000000000c3", "Composer focus after paste", "claude", "idle", 64),
  ],
  // `?machine`: they run on a machine of the person's own, beside a Mac, so its rows and bar wear a server and its name.
  // The placed Fin's device, Loft, is listed either way.
  devices: search.has("machine")
    ? new Map([
        [DEVICE, { id: DEVICE, kind: "runtime", name: "build-box", platform: "Linux x64 · Ubuntu 24.04" }],
        [STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "darwin" }],
        [PLACED_DEVICE, { id: PLACED_DEVICE, kind: "runtime", name: PLACED_WHERE, platform: "Linux x64 · Debian GNU/Linux 12" }],
      ])
    : new Map([
        [DEVICE, { id: DEVICE, kind: "desktop", name: "Studio", platform: "darwin" }],
        [PLACED_DEVICE, { id: PLACED_DEVICE, kind: "runtime", name: PLACED_WHERE, platform: "Linux x64 · Debian GNU/Linux 12" }],
      ]),
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

// The scene's deliberate Apex, as its Mac's `mako:apexes` and plan read answer: the digest under its bar and the Inbox.
// Read before anything is drawn, as the phone's list reads each Mac's Apexes before one is opened. A page that opened
// with the Mac off has read neither.
if (!LISTED) webApexesStore.set({ byDevice: { [DEVICE]: sceneApexes }, plans: { [APEX_THREAD]: scenePlan.text } })

// The owner's answer to a read takes `?answer=` ms, over the network (default: at once).
const ANSWER_MS = Number(search.get("answer") ?? 0)
const mako = getMako()
const answered = mako.liveSnapshot.bind(mako)
mako.liveSnapshot = async (id) => {
  if (ANSWER_MS) await new Promise((resolve) => setTimeout(resolve, ANSWER_MS))
  return answered(id)
}
/** `forget()`: the Apex's transcript let go, as a reload leaves it, so its next open reads it from its owner. */
Reflect.set(window, "phoneApex", {
  forget: () => unloadLive(APEX_CONVERSATION),
  // The Mac back: no longer quiet, and its row says its plan as it stands now, its merge word given meanwhile.
  back: () => {
    const list = accountListStore.get()
    const plan = checkPlanItem(scenePlan.text, "Waiting on you", 0, true) ?? scenePlan.text
    const rows = list.rows.map((each) => (each.thread === APEX_THREAD && each.apex && sceneApex ? { ...each, apex: listedApex(sceneApex, plan, Date.now()) } : each))
    accountListStore.set({ quiet: new Map(), rows })
    // Read live from the Mac again, as `WebConversations` does once it's back: its roster, its turn, its asks.
    applyLiveSnapshot({ ...apexSnapshot(), epoch: `back-${Date.now()}` })
  },
})

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <PhoneApexScreen opened={search.get("open") ?? undefined} inbox={search.get("screen") === "inbox"} />
      <Toaster position="top-center" />
    </WebClientContext>
  </TooltipProvider>
)
