// Settings › Simulators as the production component draws it, from the mock bridge's fixture (`mock-simulators.ts`).
// `?theme=dark` draws the dark theme, anything else the light one; `&simulators=<scenario>` the line at one step;
// `&details` opens Details. No host is touched.
import { createRoot } from "react-dom/client"
import { SimulatorsSection } from "@/components/settings/simulators-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

const search = new URLSearchParams(location.search)
// The app is dark unless `light` is on the root.
document.documentElement.classList.toggle("light", search.get("theme") !== "dark")

installMockBridge()
const root = document.getElementById("root")
if (root && search.has("details")) {
  const open = new MutationObserver(() => {
    const toggle = root.querySelector<HTMLButtonElement>('[data-simulators-toggle="details"]')
    if (!toggle) return
    open.disconnect()
    toggle.click()
  })
  open.observe(root, { childList: true, subtree: true })
}
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <div className="min-h-screen bg-background p-6 text-foreground">
        <div className="w-[720px]" data-fixture-simulators>
          <SimulatorsSection />
        </div>
      </div>
    </TooltipProvider>,
  )
