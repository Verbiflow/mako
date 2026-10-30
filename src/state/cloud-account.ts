import { toast } from "sonner"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { ACTION_TOAST_MS } from "@/lib/toast-duration"
import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { CloudAccount, CloudBrowserSession, CloudDevice, CloudSignInsState } from "@/lib/types"

/**
 * This Mac's Mako account. The host owns it — the sign-in, the device
 * credential and the live connection — and pushes a `cloud-account` event
 * whenever any of it changes, so this store only mirrors it and every window
 * agrees. The account's other devices, and the browsers signed in to it, are
 * read on demand: the Settings section is the only place that lists them.
 *
 * A failed action keeps its sentence here, next to the action that asked,
 * because the section shows it inline where the person clicked.
 */
type Action =
  | "sign-in"
  | "cancel"
  | "sign-out"
  | "devices"
  | `remove:${string}`
  | "browsers"
  | `end-browser:${string}`
  | "end-browsers"
  | "share-sign-ins"

interface CloudAccountState {
  account?: CloudAccount
  devices?: { list: CloudDevice[]; current: string }
  browsers?: CloudBrowserSession[]
  /** Whether this Mac's harness sign-ins are shared with the cloud; the host pushes `cloud-sign-ins` as each is sent. */
  signIns?: CloudSignInsState
  busy?: Action
  failure?: { action: Action; message: string }
}

export const cloudAccountStore = createStore<CloudAccountState>({})
export const useCloudAccount = createHook(cloudAccountStore)

let loading: Promise<void> | undefined

async function run(action: Action, work: () => Promise<CloudAccount | void>): Promise<boolean> {
  if (cloudAccountStore.get().busy) return false
  cloudAccountStore.set({ busy: action, failure: undefined })
  try {
    const account = await work()
    if (account) cloudAccountStore.set({ account })
    return true
  } catch (error) {
    cloudAccountStore.set({ failure: { action, message: error instanceof Error ? error.message : String(error) } })
    return false
  } finally {
    cloudAccountStore.set({ busy: undefined })
  }
}

export const cloudAccount = {
  load() {
    if (!hasBridge() || cloudAccountStore.get().account) return
    loading ??= getMako()
      .cloudAccount()
      .then((account) => cloudAccountStore.set({ account }))
      .catch(() => undefined)
      .finally(() => (loading = undefined))
  },

  signIn: () => run("sign-in", () => getMako().cloudSignIn()),
  cancelSignIn: () => run("cancel", () => getMako().cloudSignInCancel()),
  signOut: () =>
    run("sign-out", async () => {
      const account = await getMako().cloudSignOut()
      cloudAccountStore.set({ devices: undefined, browsers: undefined })
      return account
    }),

  /** Quietly: the list is a convenience, and a failed refresh keeps the last one shown. */
  async loadDevices() {
    if (!hasBridge()) return
    try {
      const { devices, current } = await getMako().cloudDevices()
      cloudAccountStore.set({ devices: { list: devices, current } })
    } catch (error) {
      if (!cloudAccountStore.get().devices)
        cloudAccountStore.set({ failure: { action: "devices", message: error instanceof Error ? error.message : String(error) } })
    }
  },

  removeDevice: (id: string) =>
    run(`remove:${id}`, async () => {
      const account = await getMako().cloudDeviceRemove(id)
      cloudAccountStore.set((state) =>
        state.devices ? { devices: { ...state.devices, list: state.devices.list.filter((device) => device.id !== id) } } : state
      )
      return account
    }),

  /** Quietly, like the devices: a failed refresh keeps the last list shown. */
  async loadBrowsers() {
    if (!hasBridge()) return
    try {
      cloudAccountStore.set({ browsers: await getMako().cloudBrowserSessions() })
    } catch (error) {
      if (!cloudAccountStore.get().browsers)
        cloudAccountStore.set({ failure: { action: "browsers", message: error instanceof Error ? error.message : String(error) } })
    }
  },

  endBrowser: (id: string) =>
    run(`end-browser:${id}`, async () => {
      await getMako().cloudBrowserSessionEnd(id)
      cloudAccountStore.set((state) => (state.browsers ? { browsers: state.browsers.filter((browser) => browser.id !== id) } : state))
    }),

  endBrowsers: () =>
    run("end-browsers", async () => {
      await getMako().cloudBrowserSessionsEnd()
      cloudAccountStore.set({ browsers: [] })
    }),

  /** Quietly, like the devices: the rows fill in, and the host's events keep them current. */
  async loadSignIns() {
    if (!hasBridge()) return
    try {
      cloudAccountStore.set({ signIns: await getMako().cloudSignIns() })
    } catch {
      // The section shows the share switch either way; its rows come with the next event.
    }
  },

  shareSignIns: (sharing: boolean) =>
    run("share-sign-ins", async () => {
      cloudAccountStore.set({ signIns: await getMako().cloudSignInsShare(sharing) })
    }),

  dismissFailure() {
    cloudAccountStore.set({ failure: undefined })
  },
}

/** A place as the cloud read it, in words: "Frankfurt, Germany"; empty when it couldn't say. */
function placeWords(from: { city: string | null; country: string | null } | null): string {
  if (!from) return ""
  let country = from.country
  try {
    if (country) country = new Intl.DisplayNames(undefined, { type: "region" }).of(country) ?? country
  } catch {
    // A code the runtime doesn't know is shown as it came.
  }
  return [from.city, country].filter(Boolean).join(", ")
}

type AccountEvent = Extract<HostEvent, { type: "cloud-account-event" }>["event"]

const KIND_WORDS = { desktop: "A Mac", cli: "A terminal", runtime: "A machine", browser: "A browser" } as const

/**
 * Something happened to the account's devices, heard as it happened or when this Mac connected again: a device that
 * joined from elsewhere is said at once, with Remove, so a person who didn't add it can take it off in one click; one
 * the cloud signed out because its sign-in was used elsewhere is said too. The device list follows either way.
 */
export function heardAccountEvent(heard: { event: AccountEvent; mine: boolean }): void {
  const { event, mine } = heard
  if (cloudAccountStore.get().devices) void cloudAccount.loadDevices()
  if (mine) return
  if (event.type === "device-joined") {
    const { device } = event
    const place = placeWords(device.from)
    const how = device.enrolledBy === "browser" ? "signed in through the browser" : "with a code you approved"
    toast(`${device.name} joined your account`, {
      id: `device-joined:${device.id}`,
      duration: ACTION_TOAST_MS,
      description: `${KIND_WORDS[device.kind]} on ${device.platform}${place ? `, from ${place}` : ""}, ${how}. If it isn't yours, remove it.`,
      action: { label: "Remove", onClick: () => void cloudAccount.removeDevice(device.id) },
    })
  } else if (event.reason === "credential-reused") {
    const name = cloudAccountStore.get().devices?.list.find((device) => device.id === event.deviceId)?.name ?? "A device"
    toast(`Mako signed out ${name}`, {
      id: `device-reused:${event.deviceId}`,
      duration: ACTION_TOAST_MS,
      description: "Its sign-in was used from somewhere else. It can sign in again; check Devices for any you don't know.",
    })
  }
}
