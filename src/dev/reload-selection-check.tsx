// Disposable renderer acceptance fixture. Uses the real restoration, transcript
// and composer; the bridge contains no native executor or user data.
import { createRoot } from "react-dom/client"
import { Composer } from "@/components/composer/composer"
import { AcpPanel } from "@/components/viewer/acp-panel"
import { TooltipProvider } from "@/components/ui/tooltip"
import { acp, useAcp } from "@/state/acp"
import { hydrateLiveSummaries } from "@/state/live-recovery"
import { store } from "@/state/session"
import { installMockBridge } from "./mock-bridge"
import type { LiveSnapshot } from "@/lib/types"
import "../index.css"

const mock = installMockBridge()
const harnesses = ["claude", "codex", "cursor", "grok", "devin", "opencode"]
const snapshots: LiveSnapshot[] = harnesses.map((harness, index) => ({
  session: {
    id: `019d0011-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    harness, cwd: "/fixture", title: `${harness} reload verification`,
    connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [],
  },
  revision: 1, createdAt: index + 1, base: null, permissions: [], requests: [],
  blocks: [{ type: "text", text: `Retained ${harness} conversation. Reload should return here with the unsent draft.` }],
}))
for (const snapshot of snapshots) mock.setLiveSnapshot(snapshot)
store.set({ phase: "ready", messages: [], stream: null })
hydrateLiveSummaries(snapshots)
export function Review() {
  const active = useAcp(state => state.activeKey)
  return <TooltipProvider><main className="flex h-screen flex-col bg-surface">
    <nav className="flex items-center gap-4 border-b border-hairline p-4 text-ui">
      {snapshots.map(snapshot => <button key={snapshot.session.id} data-provider={snapshot.session.harness}
        aria-pressed={active === snapshot.session.id} onClick={() => acp.activate(snapshot.session.id)}>
        {snapshot.session.harness}
      </button>)}
      <button data-new onClick={() => acp.deactivate()}>New conversation</button>
    </nav>
    <AcpPanel /><Composer />
  </main></TooltipProvider>
}
createRoot(document.getElementById("root")!).render(<Review />)
