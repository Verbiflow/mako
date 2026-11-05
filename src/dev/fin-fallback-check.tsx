import { createRoot } from "react-dom/client"
import { SettingsDialog } from "@/components/settings/settings-dialog"
import { TooltipProvider } from "@/components/ui/tooltip"
import { bindTheme, prefsStore } from "@/state/prefs"
import { threadsStore } from "@/state/thread-store"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../index.css"

/** Settings › Fins on the mock bridge, `?theme=light` or dark: its rules and the switch for a Fin whose account runs out. */
installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
prefsStore.set({ theme: new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark" })
bindTheme()
const root = document.getElementById("root")
if (root)
  createRoot(root).render(
    <TooltipProvider>
      <SettingsDialog open section="fins" onOpenChange={() => {}} onSectionChange={() => {}} />
    </TooltipProvider>
  )
