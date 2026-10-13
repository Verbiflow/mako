/* eslint-disable react-refresh/only-export-components -- This isolated acceptance entry exports controlled inputs; the application never imports it. */
// Explicit isolated fixture for quoting a reply; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { Composer } from "@/components/composer/composer"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { CommandPalette } from "@/components/palette/command-palette"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"
import { useDeskCommands } from "@/desk/use-desk-commands"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { acpStore } from "@/state/acp"
import { ConversationScopeContext } from "@/state/conversation-scope"
import { threadsStore } from "@/state/thread-store"
import { store } from "@/state/session"
import type { LiveSnapshot } from "@/lib/types"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

const mock = installMockBridge()
const cwd = "/fixture/project"
const activeId = "aaaaaaaa-1111-4111-8111-111111111111"
const otherId = "bbbbbbbb-2222-4222-8222-222222222222"
const harness = fixtureHarnesses[0]?.provider ?? "fixture"

const answer = [
  "Restoring a draft on that promise overwrites the paragraph the user has since typed, and can paint it into whatever session is on screen by then.",
  "",
  "Rejection is a preflight fact, so the fix reads it in one tick:",
  "",
  "1. Read `preflightResult` from the prompt options.",
  "2. Settle while the composer is still provably empty.",
  "3. Leave later repaints to check the draft first.",
  "",
  "```ts",
  "const result = await options.preflightResult",
  "if (result.rejected && draft.isEmpty()) restore(saved)",
  "```",
  "",
  "Anything that repaints the textarea later must first check that the draft is still empty and the session has not changed.",
].join("\n")

function snapshot(id: string, nativeId: string, title: string, blocks: LiveSnapshot["blocks"]): LiveSnapshot {
  return {
    session: { id, harness, nativeId, cwd, title, connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 1,
    createdAt: 1,
    base: null,
    permissions: [],
    requests: [],
    blocks,
    control: { activeBindingId: id, bindings: [], merges: [], transfers: [], actions: [] },
  }
}

const active = snapshot(activeId, "native-active", "Never lose a paragraph", [
  { type: "user", text: "Why did the restored draft overwrite what I typed after sending?" },
  { type: "tool", id: "read-composer", toolKind: "read", title: "Read src/components/composer/composer.tsx", input: "{\"path\":\"src/components/composer/composer.tsx\"}", output: "export function Composer() {}", status: "completed" },
  { type: "text", text: answer },
  { type: "user", text: "Which test covers it?" },
  { type: "tool", id: "run-tests", toolKind: "execute", title: "npm run test:live", input: "{\"command\":\"npm run test:live\"}", output: "All draft checks passed.", status: "completed" },
  { type: "text", text: "`test-prompt-delivery.tsx` refuses a send with no model and requires the draft back in the same tick, before any newer text could exist." },
])
const other = snapshot(otherId, "native-other", "Sign-in loop investigation", [
  { type: "user", text: "Why does sign-in loop after the session expires?" },
  { type: "text", text: "The guard redirects to sign-in before the refresh settles, so the refreshed session never sees the original destination. Keep `returnTo` until the refresh finishes, then restore it.\n\nCompare with `Map<K, V>` only when a > b && b < c.\n\n```ts\nconst pick = <T,>(a: T, b: T) => (a > b && b ? a : b)\n```" },
])

threadsStore.set({ composerHarness: harness, descriptors: fixtureHarnesses })
store.set({ messages: [], stream: null })
mock.setLiveSnapshot(active)
applyLiveSnapshot(other)
applyLiveSnapshot(active)
acpStore.set({ activeKey: activeId })

/** Builtins and the one key listener, as the desk installs them. */
function DeskCommands() {
  useDeskCommands()
  return null
}

function Fixture() {
  return (
    <TooltipProvider>
      <DeskCommands />
      <WorkspaceFocusContext value={{ identity: `live:${activeId}`, cwd, title: active.session.title, ready: true }}>
        <div className="flex h-screen bg-surface">
          <main data-quote-pane="active" className="flex min-w-0 flex-1 flex-col">
            <AcpPanel />
            <Composer />
          </main>
          <section data-quote-pane="other" aria-label="Another pane" className="flex w-[480px] shrink-0 flex-col border-l border-hairline">
            <ConversationScopeContext.Provider value={{ kind: "live", key: otherId }}>
              <AcpPanel />
            </ConversationScopeContext.Provider>
          </section>
        </div>
        <CommandPalette />
        <Toaster />
      </WorkspaceFocusContext>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
