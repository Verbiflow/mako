// Settings › Storage as the production component draws it, from the mock bridge's
// fixture (`mock-storage.ts`). `?theme=dark` draws the dark theme, anything else the
// light one; `&storage=low` a disk under the warning line; `&free` presses Free up space
// once the parts are measured. No host is touched.
import { createRoot } from "react-dom/client"
import { StorageSection } from "@/components/settings/storage-section"
import { TooltipProvider } from "@/components/ui/tooltip"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

const search = new URLSearchParams(location.search)
// The app is dark unless `light` is on the root.
document.documentElement.classList.toggle("light", search.get("theme") !== "dark")

installMockBridge()
const root = document.getElementById("root")
if (root && search.has("free")) {
  const press = new MutationObserver(() => {
    if (!root.querySelector("[data-storage-parts]")) return
    press.disconnect()
    ;[...root.querySelectorAll("button")].find((button) => button.textContent?.includes("Free up space"))?.click()
  })
  press.observe(root, { childList: true, subtree: true })
}
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <div className="min-h-screen bg-background p-6 text-foreground">
        <div className="w-[720px]" data-fixture-storage>
          <StorageSection />
        </div>
      </div>
    </TooltipProvider>,
  )
