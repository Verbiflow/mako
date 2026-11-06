// Isolated fixture for Settings › Fins; never an app entry.
import { createRoot } from "react-dom/client"
import { FinsSection } from "@/components/settings/fins-section"
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
    <main className="min-h-screen bg-surface px-6 py-8">
      <div className="mx-auto max-w-2xl">
      <p className="mb-6 text-label text-faint">Settings / Fins</p>
      <FinsSection />
      </div>
    </main>
  </TooltipProvider>
)
