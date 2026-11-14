// Explicit isolated fixture for the web app's Settings › Devices; never imported by the application entry point.
import { createRoot } from "react-dom/client"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { JOIN_WAIT_MS } from "@mako/host/contracts/account-devices"
import { advanceFixtureClock } from "./fixture-clock"
import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Avatar } from "@/components/ui/avatar"
import { accountListStore, heardDeviceJoined, type WebDevice } from "@/web-client/account-list"
import { WebClient, WebClientContext } from "@/web-client/client"
import { WebDevices } from "@/web-client/devices"
import { Group } from "@/web-client/settings-rows"
import { applyTheme } from "@/web-client/theme"
import "../web-client/style.css"

/*
 * The web app's Settings › Devices (`WebDevices`, the desktop's own `Devices`) in Settings' frame, on an account's
 * list held here: this browser; `build-box`, a Linux machine that's online and runs two Sessions; `gpu-rig`, one
 * quiet for three hours; `nas`, one whose Mako is behind; a Mac; and a terminal that never connected. A phone's
 * width draws the touch form and its sheet, a laptop's the desk's. `?theme=light` draws it light; `?devices=one` has
 * this browser alone, `?devices=none` nothing at all. `webDevicesCheck` drives what the account would: `join()` has a
 * machine join as its stream says it, `lapse()` moves the clock past a join code's life with no machine, and
 * `failRemovals(true)` has the gateway refuse to remove a device.
 */

const search = new URLSearchParams(location.search)
applyTheme(search.get("theme") === "light" ? "light" : "dark")

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const BROWSER = "a0000000-0000-4000-8000-0000000000b0"
const MAC = "a0000000-0000-4000-8000-0000000000d1"
const ONLINE = "a0000000-0000-4000-8000-0000000000e1"
const QUIET = "a0000000-0000-4000-8000-0000000000e2"
const BEHIND = "a0000000-0000-4000-8000-0000000000e3"
const TERMINAL = "a0000000-0000-4000-8000-0000000000c1"
const frankfurt = { city: "Frankfurt", region: "Hesse", country: "DE" }
const home = { city: "San Francisco", region: "California", country: "US" }

const devices: WebDevice[] = [
  { id: BROWSER, kind: "browser", name: "Safari on iPhone", platform: "iOS 26.0", appVersion: null, enrolledBy: "browser", enrolledFrom: home, createdAt: minutesAgo(60 * 24 * 2), lastSeenAt: minutesAgo(1) },
  { id: ONLINE, kind: "runtime", name: "build-box", platform: "Linux x64 · Ubuntu 24.04", appVersion: "0.4.0", enrolledBy: "device-code", enrolledFrom: frankfurt, createdAt: minutesAgo(60 * 24 * 6), lastSeenAt: minutesAgo(2) },
  { id: QUIET, kind: "runtime", name: "gpu-rig", platform: "Linux x64 · Debian 13", appVersion: "0.4.0", enrolledBy: "device-code", enrolledFrom: frankfurt, createdAt: minutesAgo(60 * 24 * 21), lastSeenAt: minutesAgo(60 * 3) },
  { id: BEHIND, kind: "runtime", name: "nas", platform: "Linux arm64 · Alpine 3.22", appVersion: "0.1.37", enrolledBy: "device-code", enrolledFrom: home, createdAt: minutesAgo(60 * 24 * 70), lastSeenAt: minutesAgo(4) },
  { id: MAC, kind: "desktop", name: "Ada's MacBook Pro", platform: "macOS 26.0", appVersion: "0.4.0", enrolledBy: "browser", enrolledFrom: home, createdAt: minutesAgo(60 * 24 * 9), lastSeenAt: minutesAgo(1) },
  { id: TERMINAL, kind: "cli", name: "ada-terminal", platform: "Linux", appVersion: null, enrolledBy: "device-code", enrolledFrom: frankfurt, createdAt: minutesAgo(60 * 24 * 40), lastSeenAt: minutesAgo(60 * 24 * 40) },
]

function row(index: number, deviceId: string, title: string): ListedSession {
  const id = (kind: number) => `b000000${index}-000${kind}-4000-8000-00000000000${index}`
  const at = minutesAgo(10 * index)
  return { session: id(1), thread: id(2), conversation: id(3), harness: "codex", title, state: "idle", folder: "/home/ada/api", createdAt: at, activityAt: at, generation: 1, runsOn: { kind: "device", deviceId }, listedAt: at }
}

const listed = search.get("devices") === "none" ? [] : search.get("devices") === "one" ? devices.slice(0, 1) : devices
accountListStore.set({
  phase: "live",
  asOf: Date.now(),
  rows: listed.length > 1 ? [row(1, ONLINE, "Rebuild the search index"), row(2, ONLINE, "Bisect the upload timeout"), row(3, MAC, "Fix the flaky login test")] : [],
  devices: new Map(listed.map((device) => [device.id, device])),
  // The account's own word on the machine it stopped hearing from, as its stream says it.
  quiet: new Map([[QUIET, minutesAgo(60 * 3)]]),
})

let removalsFail = false
/** How often Settings › Devices read the devices' records again. */
let refreshes = 0

// A stand-in for the started client, without its constructor's gateway: what Settings › Devices asks of it. Removing a
// device answers as the gateway does, after a moment.
const client: WebClient = Object.assign(Object.create(WebClient.prototype), {
  account: { id: "account-check", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements: [] },
  deviceId: BROWSER,
  options: { origin: location.origin, base: "/" },
  // The gateway's answer to this browser's sign-in, with its own address as it says it; `?cloud=unsaid` is a gateway
  // from before it did.
  gateway: { connection: async () => ({ token: "fixture", expiresAt: Date.now() + 300_000, deviceId: BROWSER, account: { id: "account-check", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements: [] }, ...(search.get("cloud") !== "unsaid" && { cloud: "https://cloud.example.com" }) }) },
  list: {
    refreshDevices: async () => {
      refreshes += 1
      // As the list does when it reads its devices again while it's followed: it's current as of now.
      accountListStore.set({ asOf: Date.now() })
    },
    removeDevice: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      if (removalsFail) throw new Error("Mako Cloud couldn't be reached. Try again in a moment.")
      const left = new Map(accountListStore.get().devices)
      left.delete(id)
      accountListStore.set({ devices: left })
    },
  },
})

/**
 * What `test-web-devices-ui.mjs` drives as the account would: a machine joins, said on the stream and then listed; a
 * join code runs out with no machine; the gateway refuses a removal.
 */
Reflect.set(window, "webDevicesCheck", {
  refreshes: () => refreshes,
  lapse: () => advanceFixtureClock(JOIN_WAIT_MS + 60_000),
  failRemovals(fail: boolean) {
    removalsFail = fail
  },
  join(name = "render-box") {
    const device: WebDevice = { id: crypto.randomUUID(), kind: "runtime", name, platform: "Linux x64 · Ubuntu 24.04", appVersion: "0.4.0", enrolledBy: "device-code", enrolledFrom: frankfurt, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
    heardDeviceJoined({ id: device.id, kind: device.kind, name, platform: device.platform, enrolledBy: "device-code", from: frankfurt })
    accountListStore.set({ devices: new Map([[device.id, device], ...accountListStore.get().devices]) })
  },
})

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    <WebClientContext value={client}>
      <div className="web-app flex min-h-dvh flex-col bg-shell text-foreground">
        <header className="web-bar flex shrink-0 items-center px-5">
          <h1 className="flex-1 text-ui font-semibold">Settings</h1>
        </header>
        <div className="mx-auto flex w-full max-w-[560px] flex-col gap-7 px-4 pt-3 pb-6">
          <Group>
            <div className="flex items-center gap-3 px-4 py-3.5">
              <Avatar name={client.account.name} size={8} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-ui font-medium">{client.account.name}</p>
                <p className="truncate text-label text-faint">{client.account.email}</p>
              </div>
            </div>
          </Group>
          <WebDevices />
        </div>
      </div>
      <Toaster position="top-center" />
    </WebClientContext>
  </TooltipProvider>
)
