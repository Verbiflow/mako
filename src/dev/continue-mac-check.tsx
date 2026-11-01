// Explicit isolated fixture for Continue in the cloud on a Mac's desktop; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import type { ListedContinueChoice } from "@mako/host/contracts/live-conversations"
import type { ThreadContinueStep } from "@mako/host/contracts/cloud-threads"
import { Composer } from "@/components/composer/composer"
import { ContinueReadout } from "@/components/settings/continue-readout"
import { ConfirmHost } from "@/components/ui/confirm-host"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { installComposerNotices } from "@/desk/notices"
import type { LiveSnapshot } from "@/lib/types"
import { acpStore, updateAcpConversation } from "@/state/acp-state"
import { cloudContinuesStore, threadContinueStepped } from "@/state/cloud-continues"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { bindTheme, prefsStore } from "@/state/prefs"
import { store } from "@/state/session"
import { threadsStore } from "@/state/thread-store"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge, MOCK_CONTINUE_CONVERSATION, MOCK_CONTINUE_DEVICE, MOCK_CONTINUE_SESSION, MOCK_CONTINUE_THREAD } from "./mock-bridge"
import "../index.css"

/*
 * Another Mac's Thread on this Mac's desktop, read from the copy it keeps in the account because it went quiet 25
 * minutes ago, through the desk's production composer and notices on the mock bridge. `?theme=light`; `?scene=`
 * picks what it shows: `offer` (the default; pressing it opens the confirmation, and the mock carries it through),
 * `making`, `arriving`, `unconfirmed`, `failed`, `listed` (a continue pressed on another device, as the list says it),
 * `listed-failed`, `working` (a refusal a person can change), `older` (a Mac from before continues), `diagnostics`.
 */

const search = new URLSearchParams(location.search)
const scene = search.get("scene") ?? "offer"
installMockBridge()
installComposerNotices()
// The mock host's continue steps reach the window as the host's would.
window.mako!.onEvent((event) => {
  if (event.type === "thread-continue-step") threadContinueStepped(event.conversationId, event.op, event.step)
})
prefsStore.set({ theme: search.get("theme") === "light" ? "light" : "dark" })
bindTheme()

const id = MOCK_CONTINUE_CONVERSATION
const cwd = "/Users/ada/src/payments"
const now = Date.now()
const op = "7c0a0000-0000-4000-8000-0000000c0c05"
const cloudThread = "t-7c0a00000c0c04"
const at = new Date(now - 4 * 60_000).toISOString()
const snapshot: LiveSnapshot = {
  session: { id, harness: "codex", nativeId: "019a0000-0000-7000-8000-00000000c0de", cwd, title: "Retry failed charges with backoff", connection: "hibernated", status: "ready", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: now - 3 * 3_600_000,
  base: null,
  permissions: [],
  requests: [],
  blocks: [
    { type: "user", text: "Retry failed charges with exponential backoff, capped at five tries." },
    { type: "text", text: "The retry loop now waits 2, 4, 8 and 16 seconds between tries and gives up after the fifth, recording why on the charge. The tests cover a charge that succeeds on its third try and one that never does." },
    { type: "user", text: "Add jitter so a burst of failures doesn't retry in lockstep." },
    { type: "text", text: "Each wait now takes a random 0–20% on top. I kept the cap at five tries and added a test that two charges failing together retry at different times." },
  ],
  copy: { at: now - 26 * 60_000 },
}
const choices = new Map<string, ListedContinueChoice>([
  ["working", { refusal: "working" }],
  ["older", { refusal: "older-device" }],
  ["listed", { refusal: "continuing", continued: { op, phase: "arriving", from: MOCK_CONTINUE_DEVICE, by: MOCK_CONTINUE_DEVICE, cloudThread, at } }],
  ["listed-failed", { continued: { op, phase: "failed", from: MOCK_CONTINUE_DEVICE, by: MOCK_CONTINUE_DEVICE, cloudThread, at, reason: "The cloud machine couldn't clone mako/retry-backoff: the branch isn't on GitHub any more." } }],
])
const pressed = new Map<string, ThreadContinueStep>([
  ["making", { kind: "making" }],
  ["arriving", { kind: "arriving" }],
  ["unconfirmed", { kind: "unconfirmed", reason: "The network connection was lost." }],
  ["failed", { kind: "failed", reason: "The cloud machine couldn't clone mako/retry-backoff: the branch isn't on GitHub any more." }],
])

threadsStore.set({ composerHarness: "codex", descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
applyLiveSnapshot(snapshot)
updateAcpConversation(id, (conversation) => (conversation.kind === "live" ? { ...conversation, elsewhere: "Studio", quietSince: now - 25 * 60_000, threadId: MOCK_CONTINUE_THREAD, sessionId: MOCK_CONTINUE_SESSION, cloudContinue: choices.get(scene) ?? {} } : conversation))
acpStore.set({ activeKey: id })
const step = pressed.get(scene)
if (step) cloudContinuesStore.set({ continuing: { [id]: { op, step } } })

const readings = [
  { op, session: MOCK_CONTINUE_SESSION, thread: MOCK_CONTINUE_THREAD, title: "Retry failed charges with backoff", from: MOCK_CONTINUE_DEVICE, by: MOCK_CONTINUE_DEVICE, cloudThread, machine: "mako-machine-7f3a", phase: "continued" as const, here: true, heard: { asking: now - 52_000, making: now - 51_600, arriving: now - 45_100, continued: now - 9_800 }, at, asks: [{ at: now - 10_200, method: "GET" as const, correlationId: "0f6e2c1a-93d4-4b7e-a1c2-5d8e9f0a1b2c", ms: 412, outcome: "continued" }] },
  { op: "7c0a0000-0000-4000-8000-0000000c0c06", session: "7c0a0000-0000-4000-8000-0000000d0d02", thread: "7c0a0000-0000-4000-8000-0000000d0d01", title: "Refund webhook signature check", cloudThread: "t-7c0a00000d0d04", phase: "failed" as const, reason: "No cloud machine was free. Try again in a minute.", here: false, heard: {}, at: new Date(now - 3_600_000).toISOString(), asks: [] },
]

createRoot(document.getElementById("root")!).render(
  scene === "diagnostics" ? (
    <div className="mx-auto max-w-[640px] p-8">
      <ContinueReadout readings={readings} />
    </div>
  ) : (
    <TooltipProvider>
      <WorkspaceFocusContext value={{ identity: `live:${id}`, cwd, title: snapshot.session.title, ready: true }}>
        <div className="flex h-screen flex-col bg-surface">
          <main className="mx-auto flex min-h-0 w-full max-w-[860px] flex-1 flex-col">
            <AcpPanel />
            <Composer />
          </main>
        </div>
        <ConfirmHost />
        <Toaster />
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
)
