import { createHook, createStore } from "@/state/store"
import { getMako, hasBridge } from "@/lib/bridge"
import type { CloudAccount, CloudDevice, CloudSignInsState } from "@/lib/types"

/**
 * This Mac's Mako account. The host owns it — the sign-in, the device
 * credential and the live connection — and pushes a `cloud-account` event
 * whenever any of it changes, so this store only mirrors it and every window
 * agrees. The account's other devices are read on demand: the Settings
 * section is the only place that lists them.
 *
 * A failed action keeps its sentence here, next to the action that asked,
 * because the section shows it inline where the person clicked.
 */
type Action = "sign-in" | "cancel" | "sign-out" | "devices" | `remove:${string}` | "share-sign-ins"

interface CloudAccountState {
  account?: CloudAccount
  devices?: { list: CloudDevice[]; current: string }
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
      cloudAccountStore.set({ devices: undefined })
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
