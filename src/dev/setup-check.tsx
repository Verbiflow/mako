// Explicit isolated fixture for Setup's pages; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import { SetupViewSchema } from "@mako/host/contracts/setup"
import { ThreadSetup, SetupPage } from "@/components/setup/setup-page"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { threadsStore } from "@/state/thread-store"
import { choosePlace, setSetupSource } from "@/state/setup"
import type { Grant } from "@mako/protocol/borrow"
import { SetupScreenOn, SetupScreenView } from "@/web-client/setup-screen"
import type { BorrowGateway } from "@/web-client/setup-source"
import { applyTheme } from "@/web-client/theme"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import "../web-client/style.css"

/**
 * Setup's pages on the mock bridge, or on a page a host produced (`?page=<url of its JSON>`, as `scripts/test-setup-host.ts`
 * writes it with `MAKO_SETUP_PAGE`): `?view=phone|desk|panel`, `?project=<folder>` (`/Users/you/api` by default),
 * `?place=<place id>`, `?theme=light`. `?view=screen` mounts the phone's actual screen (`SetupScreenOn`), which installs its
 * own source over a fake gateway answering the account broker's lists; `window.setupRequests` counts what it asked.
 */
const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")
// The phone has no desktop bridge: its actual screen reads only through the source it installs.
if (search.get("view") !== "screen") installMockBridge()
threadsStore.set({ descriptors: fixtureHarnesses })
const read = search.get("page")
const page = read ? SetupViewSchema.parse(await (await fetch(read)).json()) : undefined
if (page) setSetupSource({ read: async () => page, act: async () => ({ done: false, why: "This page is a host's reading, drawn as it was." }) })
const project = page?.root ?? search.get("project") ?? "/Users/you/api"
const place = search.get("place") ?? page?.places[0]?.id ?? "cloud"
choosePlace(project, place)
const view = search.get("view") ?? "phone"

const NOW = Date.now()
const requests: string[] = []
Reflect.set(window, "setupRequests", requests)
const pricing: Grant = {
  id: "g-pricing",
  resource: { kind: "credential", ref: "github:acme/pricing" },
  source: { kind: "mint", service: "github" },
  scope: { level: "project", account: "acct", repository: "acme/shop" },
  mode: "minted",
  access: "read",
  lifetime: { until: "revoked" },
  ask: "never",
  secret: false,
  grantedBy: { kind: "person", account: "acct" },
  grantedAt: NOW - 86_400_000,
  version: 1,
}
/** The account broker's lists, as the gateway answers them, counting each request. */
const fakeGateway: BorrowGateway = {
  rest: async (method, path) => {
    const route = path.split("?")[0]
    requests.push(`${method} ${route}`)
    const answer =
      route === "/v1/borrow/grants" ? { grants: [pricing] }
      : route === "/v1/borrow/leases" ? { leases: [] }
      : route === "/v1/borrow/events" ? { events: [] }
      : route === "/v1/borrow/asks" ? { asks: [] }
      : undefined
    return answer === undefined ? undefined : JSON.parse(JSON.stringify(answer))
  },
}

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {view === "screen" ? (
      <div className="web-app flex min-h-dvh flex-col bg-shell text-foreground">
        <SetupScreenOn project="shop" onBack={() => history.back()} gateway={fakeGateway} account="acct" />
      </div>
    ) : view === "desk" ? (
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
