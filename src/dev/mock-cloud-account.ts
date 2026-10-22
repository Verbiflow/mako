import type { CloudAccount, CloudDevice, CloudKeptSignIn, CloudPerson, CloudSignInRow, CloudSignInsState, HostEvent } from "@/lib/types"

type CloudSignInHarness = CloudSignInRow["harness"]

/** The mock gh CLI's user, so a mock account signed in with GitHub is the same person. */
export const MOCK_GITHUB_USER_ID = "583231"

/**
 * The Mako account without a cloud: signing in "finishes in the browser"
 * after a moment, and the other devices can be removed, so every state of
 * Settings › Account can be looked at in `?mock`. `?mock&cloud=signed-in`
 * starts signed in, `cloud=removed` as just removed, `cloud=reused` as signed out for a sign-in used elsewhere, `cloud=offline` with
 * the connection down and `cloud=connecting` still connecting. The account signed in with GitHub, as the mock's gh
 * user; `signin=google` with Google and no GitHub user, and `signin=legacy`
 * before the cloud said either. `invited` gives the account the cloud, and
 * `sharing` has this Mac already sharing its harnesses' sign-ins with it, and `joined` has a terminal join the account a moment after the desk opens, and `kept` has the cloud keeping
 * Codex fresh, retrying Grok and needing Claude signed in again.
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
    enrolledFrom: { city: "San Francisco", region: "California", country: "US" },
    createdAt: minutesAgo(60 * 24 * 9),
    lastSeenAt: minutesAgo(1),
  }
  let others: CloudDevice[] = [
    { ...thisMac, id: "d2", name: "Studio", platform: "macOS 15.5", appVersion: "0.3.9", lastSeenAt: minutesAgo(60 * 5) },
    { ...thisMac, id: "d3", kind: "cli", name: "build-box", platform: "Linux", appVersion: null, enrolledBy: "device-code", enrolledFrom: { city: "Frankfurt", region: "Hesse", country: "DE" }, createdAt: minutesAgo(60 * 24 * 40), lastSeenAt: minutesAgo(60 * 24 * 12) },
  ]
  const start = params.get("cloud")
  let account: CloudAccount = {
    cloud: "127.0.0.1:8787",
    state:
      start === "signed-in" || start === "offline" || start === "connecting"
        ? { status: "signed-in", account: person, device: thisMac, connection: start === "signed-in" ? "connected" : start, kept: "keychain" }
        : start === "removed"
          ? { status: "signed-out", notice: { kind: "removed", message: "This Mac was removed from your Mako account. Sign in to connect it again." } }
          : start === "reused"
            ? { status: "signed-out", notice: { kind: "reused", message: "This Mac's sign-in was used from somewhere else, so Mako signed it out to keep your account safe. Sign in again, then check Devices for any you don't know." } }
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
  // `refused`: Claude Code's sign-in signed out by its provider, Grok's provider not answering.
  const refused = params.has("refused")
  const shared = (harness: CloudSignInHarness, state: CloudKeptSignIn["state"], refreshedMinutesAgo: number): CloudKeptSignIn => {
    const signIn: CloudKeptSignIn = { harness, label: "ada@example.com", state, expiresAt: hoursFromNow(6), connectedAt: minutesAgo(60 * 24 * 3), refreshedAt: minutesAgo(refreshedMinutesAgo), problem: null, token: `${harness}-fp`, source: "shared", mine: true }
    if (state === "needs-reconnect") signIn.problem = { reason: "revoked", detail: "the provider refused the refresh token (400: invalid_grant)", at: minutesAgo(30) }
    if (state === "retrying") signIn.problem = { reason: "unavailable", detail: "the provider answered 503", at: minutesAgo(1) }
    return signIn
  }
  const rows = (sending: boolean): CloudSignInsState["harnesses"] => {
    const key = (harness: CloudSignInHarness, label: string | null, expiresAt: string | null): CloudSignInRow => {
      const row: CloudSignInRow = { harness, status: sending ? "sent" : "waiting", label, expiresAt }
      if (sending) row.sentAt = minutesAgo(40)
      return row
    }
    const rotating = (harness: CloudSignInHarness, kept: CloudKeptSignIn): CloudSignInRow => {
      const row: CloudSignInRow = { harness, status: sending ? "sent" : "waiting", label: kept.label, expiresAt: kept.expiresAt, rotates: true }
      if (sending) {
        row.kept = kept
        row.inStepAt = kept.refreshedAt ?? kept.connectedAt
      }
      return row
    }
    return [
      rotating("claude", shared("claude", refused ? "needs-reconnect" : "connected", 2)),
      rotating("codex", { ...shared("codex", "connected", 40), refreshedBecause: "returned", waitedFrom: minutesAgo(60 * 7) }),
      key("cursor", "ada@example.com", null),
      { harness: "opencode", status: "signed-out", label: null, expiresAt: null },
      rotating("grok", { ...shared("grok", refused ? "retrying" : "connected", 60 * 5), refreshedBecause: "machines" }),
      key("devin", null, null),
    ]
  }
  let signIns: CloudSignInsState = { sharing: !params.has("unshared"), checkedAt: minutesAgo(0), harnesses: rows(!params.has("unshared")) }
  const changed = () => {
    signIns = { ...signIns, checkedAt: new Date().toISOString(), harnesses: rows(signIns.sharing) }
    emit({ type: "cloud-sign-ins", signIns })
    return signIns
  }

  // `joined`: a terminal joins the account a moment after the desk opens, as the account's stream would say it.
  if (params.has("joined"))
    setTimeout(() => emit({ type: "cloud-account-event", seq: 1, at: new Date().toISOString(), mine: false, event: { type: "device-joined", device: { id: "d4f5a6b7-1c2d-4e3f-8a9b-0c1d2e3f4a5b", kind: "cli", name: "build-box", platform: "Linux", enrolledBy: "device-code", from: { city: "Frankfurt", region: "Hesse", country: "DE" } } } }), 1_500)

  return {
    cloudAccount: async () => account,
    cloudSignIns: async () => signIns,
    cloudSignInsShare: async (sharing: boolean) => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      signIns = { ...signIns, sharing }
      return changed()
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
