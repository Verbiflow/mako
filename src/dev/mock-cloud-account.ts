import type { CloudAccount, CloudDevice, CloudPerson, HostEvent } from "@/lib/types"

/**
 * The Mako account without a cloud: signing in "finishes in the browser"
 * after a moment, and the other devices can be removed, so every state of
 * Settings › Account can be looked at in `?mock`. `?mock&cloud=signed-in`
 * starts signed in, `cloud=removed` as just removed and `cloud=offline` with
 * the connection down.
 */
export function mockCloudAccount(emit: (event: HostEvent) => void) {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const person: CloudPerson = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements: [] }
  const thisMac: CloudDevice = {
    id: "d1",
    kind: "desktop",
    name: "Ada's MacBook Pro",
    platform: "macOS 26.0",
    appVersion: "0.4.0",
    enrolledBy: "browser",
    createdAt: minutesAgo(60 * 24 * 9),
    lastSeenAt: minutesAgo(1),
  }
  let others: CloudDevice[] = [
    { ...thisMac, id: "d2", name: "Studio", platform: "macOS 15.5", appVersion: "0.3.9", lastSeenAt: minutesAgo(60 * 5) },
    { ...thisMac, id: "d3", kind: "cli", name: "build-box", platform: "Linux", appVersion: null, enrolledBy: "device-code", lastSeenAt: minutesAgo(60 * 24 * 12) },
  ]
  const start = new URLSearchParams(globalThis.location?.search).get("cloud")
  let account: CloudAccount = {
    cloud: "127.0.0.1:8787",
    state:
      start === "signed-in" || start === "offline"
        ? { status: "signed-in", account: person, device: thisMac, connection: start === "offline" ? "offline" : "connected", kept: "keychain" }
        : start === "removed"
          ? { status: "signed-out", notice: { kind: "removed", message: "This Mac was removed from your Mako account. Sign in to connect it again." } }
          : { status: "signed-out" },
  }
  let finishing: ReturnType<typeof setTimeout> | undefined
  const set = (next: CloudAccount["state"]) => {
    account = { ...account, state: next }
    emit({ type: "cloud-account", account })
    return account
  }
  const signedOut = () => {
    clearTimeout(finishing)
    return set({ status: "signed-out" })
  }

  return {
    cloudAccount: async () => account,
    cloudSignIn: async () => {
      if (account.state.status !== "signed-out") return account
      finishing = setTimeout(() => {
        set({ status: "signed-in", account: person, device: thisMac, connection: "connecting", kept: "keychain" })
        setTimeout(() => {
          if (account.state.status === "signed-in") set({ ...account.state, connection: "connected" })
        }, 600)
      }, 2_500)
      return set({ status: "signing-in", url: "http://127.0.0.1:8787/sign-in?request=mock", startedAt: new Date().toISOString() })
    },
    cloudSignInCancel: async () => (account.state.status === "signing-in" ? signedOut() : account),
    cloudDevices: async () => ({ devices: [thisMac, ...others], current: thisMac.id }),
    cloudDeviceRemove: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      if (id === thisMac.id) return signedOut()
      others = others.filter((device) => device.id !== id)
      return account
    },
    cloudSignOut: async () => signedOut(),
  }
}
