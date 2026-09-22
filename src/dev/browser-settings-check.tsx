// Isolated fixture for the production Settings component; never an app entry.
import { createRoot } from "react-dom/client"
import { BrowserConnections } from "@/components/settings/browser-connections"
import { mcpStore } from "@/state/mcp"
import { installMockBridge } from "./mock-bridge"
import type { BrowserControlStatus } from "@/lib/types"
import "../index.css"
installMockBridge()
const profiles: BrowserControlStatus[] = [
  {
    id: "aside",
    name: "Aside · Work",
    product: "Aside",
    profileName: "Work",
    kind: "chromium",
    transport: "extension",
    preferred: true,
    guidance: "Aside selection popup",
    connection: { status: "connected", generation: "fixture" },
  },
  {
    id: "chrome",
    name: "Chrome · Kashyab",
    product: "Chrome",
    profileName: "Kashyab",
    kind: "chromium",
    transport: "extension",
    connection: { status: "disconnected" },
  },
  {
    id: "direct",
    name: "Aside — direct connection",
    product: "Aside",
    kind: "chromium",
    transport: "direct",
    connection: { status: "disconnected" },
  },
]
mcpStore.set({ browsers: profiles, status: "ready" })
window.mako!.preferBrowser = async (id) => {
  await new Promise((r) => setTimeout(r, 80))
  return mcpStore.get().browsers.map((b) => ({ ...b, preferred: b.id === id }))
}
window.mako!.connectBrowser = async (id) =>
  mcpStore
    .get()
    .browsers.map((b) =>
      b.id === id
        ? { ...b, connection: { status: "connected", generation: "fixture" } }
        : b
    )
window.mako!.disconnectBrowser = async (id) =>
  mcpStore
    .get()
    .browsers.map((b) =>
      b.id === id ? { ...b, connection: { status: "disconnected" } } : b
    )
window.mako!.browserControlStatus = async () => mcpStore.get().browsers
createRoot(document.getElementById("root")!).render(
  <main className="mx-auto max-w-2xl px-6 py-8">
    <p className="mb-6 text-label text-faint">Settings / Tools</p>
    <BrowserConnections />
  </main>
)
