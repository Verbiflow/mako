// Explicit isolated fixture for Setup's pages; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import type { SetupView } from "@mako/host/contracts/setup"
import { ThreadSetup, SetupPage } from "@/components/setup/setup-page"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadsStore } from "@/state/thread-store"
import { choosePlace, setSetupSource } from "@/state/setup"
import { SetupScreenView } from "@/web-client/setup-screen"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * Setup's pages on the mock bridge, or on a page a host produced (`?page=<url of its JSON>`, as `scripts/test-setup-host.ts`
 * writes it with `MAKO_SETUP_PAGE`): `?view=phone|desk|panel`, `?project=<folder>` (`/Users/you/api` by default),
 * `?place=<place id>`, `?theme=light`.
 */
const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")
installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
const read = search.get("page")
const answer: unknown = read ? await (await fetch(read)).json() : undefined
// SAFETY: the file is the `SetupView` a host's `SetupViews.view` returned, written whole by the host test.
const page = answer === undefined ? undefined : (answer as SetupView)
if (page) setSetupSource({ read: async () => page, act: async () => ({ done: false, why: "This page is a host's reading, drawn as it was." }) })
const project = page?.root ?? search.get("project") ?? "/Users/you/api"
const place = search.get("place") ?? page?.places[0]?.id ?? "cloud"
choosePlace(project, place)
const view = search.get("view") ?? "phone"

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {view === "desk" ? (
      <div className="min-h-dvh bg-surface text-foreground">
        <div className="mx-auto max-w-[50rem] px-10 pt-9 pb-16">
          <SetupPage folder={project} />
        </div>
      </div>
    ) : view === "panel" ? (
      <div className="flex min-h-dvh justify-end bg-shell text-foreground">
        <div className="h-dvh w-[420px] bg-surface">
          <ThreadSetup folder={project} thread={search.get("thread") ?? undefined} elsewhere={place === "cloud" ? "a cloud machine" : undefined} />
        </div>
      </div>
    ) : (
      <div className="web-app flex min-h-dvh flex-col bg-shell text-foreground">
        <SetupScreenView project={project} onBack={() => history.back()} />
      </div>
    )}
    <Toaster position="top-center" />
  </TooltipProvider>
)
