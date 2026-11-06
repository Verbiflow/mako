import type { SyncFailureView, SyncStatus, SyncTier } from "@mako/host/contracts/sync-status"
import { JOIN_WAIT_MS } from "@mako/host/contracts/account-devices"
import { advanceFixtureClock } from "./fixture-clock"
import { mockCloudTurnOn } from "./mock-cloud-turn-on"
import type { CloudAccount, CloudBrowserSession, CloudDevice, CloudKeptSignIn, CloudPerson, CloudSignInRow, CloudSignInsState, HostEvent } from "@/lib/types"

type CloudSignInHarness = CloudSignInRow["harness"]

/** The fixture account's machines, by what each shows: one online, one quiet for three hours, one whose Mako is behind. */
export const MOCK_MACHINES = {
  online: "b0a1d2c3-4e5f-4a6b-8c7d-0e1f2a3b4c5d",
  quiet: "c1b2e3d4-5f6a-4b7c-9d8e-1f2a3b4c5d6e",
  behind: "d2c3f4e5-6a7b-4c8d-8e9f-2a3b4c5d6e7f",
} as const

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
 * `sharing` has this Mac already sharing its harnesses' sign-ins with it, and `joined` has a machine join the account a moment after the desk opens, and `kept` has the cloud keeping
 * Codex fresh, retrying Grok and needing Claude signed in again. Three browsers are signed in to the account's pages,
 * one of them last used from another country; `browsers=none` has none.
 *
 * The account's devices are every state Settings › Devices draws: this Mac; `build-box`, a Linux machine that's
 * online; `gpu-rig`, one quiet for three hours; `nas`, one whose Mako is too old for this build; Studio, a Mac seen
 * five hours ago; and a terminal that joined and never connected; `devices=one` has this Mac alone.
 * `globalThis.makoMockAccount` drives what the account would: `join()` has a machine join as its stream says it
 * (what Add a machine waits for), and lists it; `lapse()` moves the clock past a join code's life with no machine;
 * `failRemovals(true)` has the cloud refuse to remove a device.
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
  const machine = (device: Pick<CloudDevice, "id" | "name" | "platform" | "lastSeenAt"> & Partial<CloudDevice>): CloudDevice => ({
    kind: "runtime",
    appVersion: "0.4.0",
    enrolledBy: "device-code",
    enrolledFrom: { city: "Frankfurt", region: "Hesse", country: "DE" },
    createdAt: minutesAgo(60 * 24 * 6),
    ...device,
  })
  let others: CloudDevice[] = params.get("devices") === "one" ? [] : [
    machine({ id: MOCK_MACHINES.online, name: "build-box", platform: "Linux x64 · Ubuntu 24.04", lastSeenAt: minutesAgo(2) }),
    machine({ id: MOCK_MACHINES.quiet, name: "gpu-rig", platform: "Linux x64 · Debian 13", createdAt: minutesAgo(60 * 24 * 21), lastSeenAt: minutesAgo(60 * 3) }),
    machine({ id: MOCK_MACHINES.behind, name: "nas", platform: "Linux arm64 · Alpine 3.22", appVersion: "0.1.37", enrolledFrom: { city: "San Francisco", region: "California", country: "US" }, createdAt: minutesAgo(60 * 24 * 70), lastSeenAt: minutesAgo(4) }),
    { ...thisMac, id: "d2", name: "Studio", platform: "macOS 15.5", appVersion: "0.3.9", lastSeenAt: minutesAgo(60 * 5) },
    { ...thisMac, id: "d3", kind: "cli", name: "ada-terminal", platform: "Linux", appVersion: null, enrolledBy: "device-code", enrolledFrom: { city: "Frankfurt", region: "Hesse", country: "DE" }, createdAt: minutesAgo(60 * 24 * 40), lastSeenAt: minutesAgo(60 * 24 * 40) },
  ]
  const browser = (session: Partial<CloudBrowserSession> & Pick<CloudBrowserSession, "id">): CloudBrowserSession => ({
    method: "github",
    browser: "Chrome",
    os: "macOS",
    signedInAt: minutesAgo(60 * 24 * 9),
    signedInFrom: thisMac.enrolledFrom ?? null,
    lastSeenAt: minutesAgo(2),
    lastSeenFrom: thisMac.enrolledFrom ?? null,
    expiresAt: new Date(Date.now() + 5 * 24 * 3_600_000).toISOString(),
    ...session,
  })
  let browsers: CloudBrowserSession[] =
    params.get("browsers") === "none"
      ? []
      : [
          browser({ id: "b1" }),
          browser({ id: "b2", browser: "Safari", os: "iOS", method: "google", signedInAt: minutesAgo(60 * 24 * 4), lastSeenAt: minutesAgo(60 * 26) }),
          browser({ id: "b3", browser: "Firefox", os: "Windows", signedInAt: minutesAgo(60 * 50), signedInFrom: { city: "Tokyo", region: "Tokyo", country: "JP" }, lastSeenAt: minutesAgo(60 * 3), lastSeenFrom: { city: "Osaka", region: "Osaka", country: "JP" } }),
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

  // A machine joins the account, as its stream says it to every device: listed from then on, and said to the window.
  let seq = 0
  const join = (name = "render-box") => {
    const device = machine({ id: crypto.randomUUID(), name, platform: "Linux x64 · Ubuntu 24.04", createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() })
    others = [device, ...others]
    emit({ type: "cloud-account-event", seq: ++seq, at: new Date().toISOString(), mine: false, event: { type: "device-joined", device: { id: device.id, kind: "runtime", name, platform: device.platform, enrolledBy: "device-code", from: { city: "Frankfurt", region: "Hesse", country: "DE" } } } })
  }
  let removalsFail = false
  Reflect.set(globalThis, "makoMockAccount", {
    join,
    lapse: () => advanceFixtureClock(JOIN_WAIT_MS + 60_000),
    failRemovals: (fail: boolean) => {
      removalsFail = fail
    },
  })
  // `joined`: one joins a moment after the desk opens.
  if (params.has("joined")) setTimeout(join, 1_500)

  const sync = mockSyncStatus(params.get("sync"))
  const turnOn = mockCloudTurnOn(
    emit,
    () => account.state.status === "signed-in" && person.entitlements.includes("cloud"),
    () => {
      person.entitlements = ["cloud"]
      if (account.state.status === "signed-in") set({ ...account.state, account: { ...person } })
    }
  )
  return {
    ...turnOn,
    cloudAccount: async () => account,
    syncStatus: async () => (account.state.status === "signed-in" ? (person.entitlements.includes("cloud") ? sync() : { state: "off", reason: "no-cloud" }) : { state: "off", reason: "signed-out" }) satisfies SyncStatus,
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
      if (removalsFail) throw new Error("Mako Cloud couldn't be reached. Try again in a moment.")
      if (id === thisMac.id) return signedOut()
      others = others.filter((device) => device.id !== id)
      return account
    },
    cloudBrowserSessions: async () => browsers,
    cloudBrowserSessionEnd: async (id: string) => {
      await new Promise((resolve) => setTimeout(resolve, 400))
      browsers = browsers.filter((session) => session.id !== id)
    },
    cloudBrowserSessionsEnd: async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      const ended = browsers.length
      browsers = []
      return ended
    },
    cloudSignOut: async () => signedOut(),
  }
}

/**
 * This Mac's sync in each state Settings shows (`sync=`): catching up (the default), a little more each read, as a
 * first upload goes, the Thread at work and today's first; `synced`; `paused` on a low battery; `failing`, with the
 * cloud's words and correlation IDs, and `failing-one`, its first alone; `starting`.
 */
function mockSyncStatus(state: string | null): () => SyncStatus {
  const minutesAgo = (minutes: number) => Date.now() - minutes * 60_000
  const tier = (name: SyncTier["tier"], threads: number, sessions: number, readable: number, whole: number, held = sessions): SyncTier => {
    const inCloud = Math.min(readable, whole)
    return { tier: name, threads, sessions, readable, held, whole, inCloud, threadsInCloud: inCloud === sessions ? threads : Math.floor((threads * inCloud) / sessions) }
  }
  const whole = [tier("now", 2, 3, 3, 3), tier("day", 9, 14, 14, 14), tier("week", 31, 58, 58, 58)]
  if (state === "starting") return () => ({ state: "starting", sessions: 75 })
  if (state === "synced")
    return () => ({ state: "synced", sessions: 75, tiers: whole, sending: 0, stale: 0, lastSuccessAt: minutesAgo(0.2), failures: [], backfill: { sessions: 5_012, done: 5_012, startedAt: minutesAgo(40), endedAt: minutesAgo(12) } })
  if (state === "paused")
    return () => ({ state: "paused", sessions: 75, tiers: [whole[0]!, whole[1]!, tier("week", 31, 58, 41, 12, 50)], sending: 0, stale: 2, lastSuccessAt: minutesAgo(3), failures: [] })
  if (state === "failing" || state === "failing-one")
    return () => ({
      state: "failing", sessions: 75, tiers: [whole[0]!, whole[1]!, tier("week", 31, 58, 57, 50)], sending: 1, stale: 0, lastSuccessAt: minutesAgo(6),
      // The longest failing first, as the sync daemon orders them; one more retrying, said only in Diagnostics. The
      // first is named as the host lists it, a Session the rail doesn't show; the second has no title anywhere.
      failures: ([
        { at: minutesAgo(5), since: minutesAgo(40), harness: "claude", nativeId: "8d0c3a1e-2f4b-4c6d-9e8f-7a6b5c4d3e2f", title: "Fix the login race in the session store", kind: "refused", message: "The account refused one chunk of this Session (8fd50237a1c4, 40,960 bytes) and took the rest: The pack was refused: The chunk 8fd50237a1c4 isn't the chunk its hash names (PUT /chunks answered 400, correlation 0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d)", correlationId: "0a9b8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d" },
        { at: minutesAgo(2), since: minutesAgo(12), harness: "codex", nativeId: "019a2b7c-5d1e-7f20-9a3b-4c5d6e7f8091", kind: "unreachable", message: "The archive's storage couldn't be read; try again (POST /sessions/with-chunks answered 503, 4 tries, correlation 6f1c2d3e-8b9a-4c7d-a1e2-f3b4c5d6e7f8)", correlationId: "6f1c2d3e-8b9a-4c7d-a1e2-f3b4c5d6e7f8" },
      ] satisfies SyncFailureView[]).slice(0, state === "failing-one" ? 1 : 2),
      retrying: 1,
    })
  let reads = 0
  return () => {
    reads += 1
    const step = Math.min(reads, 20)
    return {
      state: "syncing",
      sessions: 75,
      tiers: [whole[0]!, whole[1]!, tier("week", 31, 58, Math.min(58, 39 + step), Math.min(58, 8 + step), Math.min(58, 44 + step))],
      sending: 2,
      stale: 1,
      lastSuccessAt: minutesAgo(0.1),
      failures: [],
      backfill: { sessions: 5_012, done: Math.min(5_012, 1_840 + step * 40), startedAt: minutesAgo(8) },
    }
  }
}
