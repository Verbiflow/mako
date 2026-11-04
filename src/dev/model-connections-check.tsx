// Isolated fixture for Settings › Models › Connections; never an app entry.
import { createRoot } from "react-dom/client"
import { ModelConnections } from "@/components/settings/model-connection-list"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threads } from "@/state/threads"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

installMockBridge()
// Each harness's name and mark, as the desk reads them when it starts.
void threads.refreshCapabilities()
document.documentElement.classList.toggle("light", new URLSearchParams(location.search).get("theme") === "light")

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <main className="mx-auto max-w-2xl px-6 py-8">
      <p className="mb-6 text-label text-faint">Settings / Models</p>
      <ModelConnections />
    </main>
  </TooltipProvider>
)
