import type { CloudAccount, CloudDevice, CloudPerson, CloudSignInsState, HostEvent } from "@/lib/types"

/** The mock gh CLI's user, so a mock account signed in with GitHub is the same person. */
export const MOCK_GITHUB_USER_ID = "583231"

/**
 * The Mako account without a cloud: signing in "finishes in the browser"
 * after a moment, and the other devices can be removed, so every state of
 * Settings › Account can be looked at in `?mock`. `?mock&cloud=signed-in`
 * starts signed in, `cloud=removed` as just removed, `cloud=offline` with
 * the connection down and `cloud=connecting` still connecting. The account signed in with GitHub, as the mock's gh
 * user; `signin=google` with Google and no GitHub user, and `signin=legacy`
 * before the cloud said either. `invited` gives the account the cloud, and
 * `sharing` has this Mac already sharing its harnesses' sign-ins with it.
 */
export function mockCloudAccount(emit: (event: HostEvent) => void) {
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
  const params = new URLSearchParams(globalThis.location?.search)
  const signIn = params.get("signin")
  const person: CloudPerson = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null, entitlements: params.has("invited") ? ["cloud"] : [] }
  if (signIn !== "legacy") {
    person.signedInWith = signIn === "google" ? "google" : "github"
    person.githubId = signIn === "google" ? null : MOCK_GITHUB_USER_ID
  }
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
  const start = params.get("cloud")
  let account: CloudAccount = {
    cloud: "127.0.0.1:8787",
    state:
      start === "signed-in" || start === "offline" || start === "connecting"
        ? { status: "signed-in", account: person, device: thisMac, connection: start === "signed-in" ? "connected" : start, kept: "keychain" }
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

  const hoursFromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()
  const rows = (sending: boolean): CloudSignInsState["harnesses"] => [
    { harness: "claude", status: sending ? "sent" : "waiting", label: "ada@example.com", expiresAt: hoursFromNow(7.5), ...(sending ? { sentAt: minutesAgo(3) } : {}) },
    { harness: "codex", status: sending ? "sent" : "waiting", label: "ada@example.com", expiresAt: hoursFromNow(24 * 6), ...(sending ? { sentAt: minutesAgo(40) } : {}) },
    { harness: "cursor", status: sending ? "sent" : "waiting", label: "ada@example.com", expiresAt: null, ...(sending ? { sentAt: minutesAgo(40) } : {}) },
    { harness: "opencode", status: "signed-out", label: null, expiresAt: null },
    { harness: "grok", status: sending ? "failed" : "waiting", label: "ada@example.com", expiresAt: hoursFromNow(0.1), ...(sending ? { problem: "Grok didn't refresh its sign-in. Open Grok on this Mac to sign in again." } : {}) },
    { harness: "devin", status: sending ? "sent" : "waiting", label: null, expiresAt: null, ...(sending ? { sentAt: minutesAgo(40) } : {}) },
  ]
  let signIns: CloudSignInsState = { sharing: params.has("sharing"), checkedAt: minutesAgo(0), harnesses: rows(params.has("sharing")) }

  return {
    cloudAccount: async () => account,
    cloudSignIns: async () => signIns,
    cloudSignInsShare: async (sharing: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      signIns = { sharing, checkedAt: new Date().toISOString(), harnesses: rows(sharing) }
      emit({ type: "cloud-sign-ins", signIns })
      return signIns
    },
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
