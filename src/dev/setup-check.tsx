// Explicit isolated fixture for the phone's Setup screen; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadsStore } from "@/state/thread-store"
import { choosePlace } from "@/state/setup"
import { SetupScreenView } from "@/web-client/setup-screen"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * The phone's Setup screen (`SetupScreenView`) on the mock bridge's Setup, as the account's broker will answer it:
 * `?project=<folder>` (`/Users/you/api` by default), `?place=cloud|device:dev-mac|device:dev-studio`, `?theme=light`.
 */
const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")
installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
const project = search.get("project") ?? "/Users/you/api"
choosePlace(project, search.get("place") ?? "cloud")

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <div className="web-app flex min-h-dvh flex-col bg-shell text-foreground">
      <SetupScreenView project={project} onBack={() => history.back()} />
    </div>
    <Toaster position="top-center" />
  </TooltipProvider>
)
