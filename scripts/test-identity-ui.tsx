import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import { IdentityRow } from "../src/components/identity/identity-row"
import { IdentityMenu } from "../src/components/identity/identity-menu"
import { cloudAccountStore } from "../src/state/cloud-account"
import { github, githubStore } from "../src/state/github"
import { CloudPersonSchema } from "@mako/host/contracts/cloud-account"
import type { CloudAccount, CloudDevice, CloudPerson } from "../src/lib/types"

/**
 * Whose desk the rail's footer says it is: the Mako account over GitHub's
 * login, each picture standing in for the other, and the first step when
 * neither is connected. Rendered from fixture stores, without a host.
 */

const person: CloudPerson = { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null, signedInWith: "github", githubId: "583231", entitlements: [] }
const device: CloudDevice = {
  id: "d1",
  kind: "desktop",
  name: "Ada's Mac",
  platform: "macOS",
  appVersion: null,
  enrolledBy: "browser",
  createdAt: "2026-10-01T00:00:00Z",
  lastSeenAt: "2026-10-01T00:00:00Z",
}
const signedIn = (connection: "connected" | "offline", image: string | null = null, account: Partial<CloudPerson> = {}): CloudAccount => ({
  cloud: "cloud.example.com",
  state: { status: "signed-in", account: { ...person, image, ...account }, device, connection, kept: "keychain" },
})
const gh = { installed: true, authenticated: true, login: "ada-gh", userId: "583231", repo: "ada/engine" }
const githubPicture = "data:image/png;base64,github"
const makoPicture = "https://example.com/ada.png"
const footer = () => renderToStaticMarkup(<IdentityRow />)
const menu = () => renderToStaticMarkup(<IdentityMenu />)

// Signed in to Mako: the account is the face, with GitHub's picture when the account has none.
githubStore.set({ status: gh, userAvatar: githubPicture })
cloudAccountStore.set({ account: signedIn("connected") })
assert.match(footer(), /Ada Lovelace/)
assert.doesNotMatch(footer(), /ada-gh/, "the account outranks GitHub's login")
assert.match(footer(), new RegExp(`src="${githubPicture}"`))
cloudAccountStore.set({ account: signedIn("connected", makoPicture) })
assert.match(footer(), new RegExp(`src="${makoPicture}"`), "the account's own picture comes first")
assert.match(menu(), /ada@example\.com/)
assert.doesNotMatch(menu(), />Sign in</)

// Under the account, what it has. Signed in with GitHub as gh's own user: one line says both.
const text = () => menu().replace(/<[^>]+>/g, "")
assert.match(text(), /ada-gh · your sign-in and pull requests/)
assert.match(menu(), />Connected</)
assert.doesNotMatch(text(), /how you sign in/, "the same GitHub user isn't said twice")

// With Google: how you sign in, then GitHub's own line.
cloudAccountStore.set({ account: signedIn("connected", null, { signedInWith: "google", githubId: null }) })
assert.match(text(), /Google · how you sign in/)
assert.match(text(), /ada-gh · pull requests and checks/)
assert.match(menu(), />Connected</)

// gh is someone else: said, with the way to change it, and never called connected as the account.
cloudAccountStore.set({ account: signedIn("connected") })
githubStore.set({ status: { ...gh, login: "ada-work", userId: "9100224" }, userAvatar: githubPicture })
assert.match(text(), /GitHub · how you sign in/)
assert.match(text(), /ada-work · pull requests/)
assert.match(text(), /Not the GitHub user you sign in with\./)
assert.match(menu(), /text-caution/)
assert.match(text(), /gh auth login/)
assert.doesNotMatch(menu(), />Connected</)
assert.doesNotMatch(footer(), new RegExp(`src="${githubPicture}"`), "someone else's GitHub picture is never the account's face")
cloudAccountStore.set({ account: signedIn("connected", null, { signedInWith: "google" }) })
assert.match(text(), /Not the GitHub user on your Mako account\./, "a GitHub user linked to a Google sign-in is the account's")

// No gh login under the account: how to connect it, beneath how you sign in.
githubStore.set({ status: { installed: true, authenticated: false }, userAvatar: undefined })
cloudAccountStore.set({ account: signedIn("connected", null, { signedInWith: "google", githubId: null }) })
assert.match(text(), /Google · how you sign in/)
assert.match(text(), /Connect GitHub/)
assert.match(text(), /Sign in to the gh CLI to open pull requests and see checks\./)
assert.match(text(), /gh auth login/)
githubStore.set({ status: { installed: false, authenticated: false }, userAvatar: undefined })
assert.match(text(), /Install the gh CLI/)

// Before gh has answered, nothing about GitHub is guessed.
githubStore.set({ status: undefined, userAvatar: undefined })
cloudAccountStore.set({ account: signedIn("connected") })
assert.match(text(), /GitHub · how you sign in/)
assert.doesNotMatch(text(), /Connect GitHub|Connected/)

// An account kept before the cloud said how it signed in, or a gh without an ID: connected, with nothing compared.
githubStore.set({ status: { ...gh, userId: undefined }, userAvatar: githubPicture })
assert.match(text(), /ada-gh · pull requests and checks/)
cloudAccountStore.set({ account: signedIn("connected", null, { signedInWith: undefined, githubId: undefined }) })
githubStore.set({ status: gh, userAvatar: githubPicture })
assert.match(text(), /ada-gh · pull requests and checks/)
assert.doesNotMatch(text(), /how you sign in|Not the GitHub user/)

// The contract: an account kept before these fields, or with values this build doesn't know, still parses.
const kept = { id: "u1", name: "Ada", email: "ada@example.com", image: null, entitlements: [] }
assert.deepEqual(CloudPersonSchema.parse(kept), kept)
const later = CloudPersonSchema.parse({ ...kept, signedInWith: "apple", githubId: "octocat" })
assert.deepEqual([later.signedInWith, later.githubId], [null, null])
assert.deepEqual(Object.values(CloudPersonSchema.pick({ signedInWith: true, githubId: true }).parse({ signedInWith: "github", githubId: "583231" })), ["github", "583231"])
githubStore.set({ status: gh, userAvatar: githubPicture })
cloudAccountStore.set({ account: signedIn("connected", makoPicture) })

// Offline: said in the menu beside the name, never as a mark on the footer's picture.
cloudAccountStore.set({ account: signedIn("offline") })
assert.doesNotMatch(footer(), /offline|bg-caution/i)
assert.match(menu(), />Offline</)

// GitHub only: its login is the face, and the account is one sign-in away.
cloudAccountStore.set({ account: { cloud: "cloud.example.com", state: { status: "signed-out" } } })
assert.match(footer(), /ada-gh/)
assert.match(footer(), new RegExp(`src="${githubPicture}"`))
assert.match(menu(), /Mako account/)
assert.match(menu(), /Sign in, or create one, in your browser\./)
assert.doesNotMatch(menu(), /Connect GitHub/)

// Neither: the footer asks for the first step.
githubStore.set({ status: { installed: true, authenticated: false }, userAvatar: undefined })
assert.match(footer(), />Sign in</)
assert.match(menu(), /Connect GitHub/)
assert.match(menu(), /open pull requests and see checks/)
assert.match(menu(), /gh auth login/)

// Waiting on the browser, then signed out from elsewhere.
cloudAccountStore.set({ account: { cloud: "cloud.example.com", state: { status: "signing-in", url: "https://cloud.example.com/sign-in", startedAt: "2026-10-01T00:00:00Z" } } })
assert.match(footer(), /Signing in…/)
assert.match(menu(), /Waiting for your browser/)
cloudAccountStore.set({
  account: { cloud: "cloud.example.com", state: { status: "signed-out", notice: { kind: "removed", message: "This Mac was removed from your Mako account." } } },
})
assert.match(menu(), /This Mac was signed out/)
assert.match(menu(), /Sign in again/)

// No cloud for this build: GitHub is the only identity there is, and nothing offers a Mako sign-in.
cloudAccountStore.set({ account: { cloud: null, state: { status: "unavailable", message: "No cloud is configured." } } })
assert.match(footer(), /Connect GitHub/)
assert.doesNotMatch(menu(), /Mako account|>Sign in</)

console.log("identity ui: the account over GitHub, pictures standing in for each other, every first step")


// A rate-limited account lookup is still checking, not a prompt to change the person's login.
cloudAccountStore.set({ account: signedIn("connected") })
githubStore.set({ status: { installed: true, authenticated: false, limited: { until: 1_000_100 } }, userAvatar: undefined })
assert.doesNotMatch(text(), /Connect GitHub|gh auth login/)

// The actual frontend cache waits until the shared deadline, then retries on demand without a polling timer.
const originalClock = Date.now
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
let clock = 1_000_000, statusReads = 0, avatarReads = 0
Date.now = () => clock
Object.defineProperty(globalThis, "window", { configurable: true, value: { mako: {
  githubStatus: async () => { statusReads++; return statusReads === 1 ? { installed: true, authenticated: false, limited: { until: 1_000_100 } } : gh },
  userAvatar: async () => { avatarReads++; return undefined },
  pullRequest: async () => { throw new Error("A limited lookup must not ask for a PR") },
} } })
try {
  githubStore.set({ status: undefined, statusRoot: undefined, root: undefined, userAvatar: undefined })
  await github.ensureStatus("fixture")
  assert.equal(statusReads, 1)
  assert.equal(avatarReads, 0, "a limited lookup does not ask for an avatar")
  await github.refresh("fixture", "fix")
  assert.equal(statusReads, 1, "refresh during cooldown reuses the known refusal")
  clock = 1_000_100
  await github.ensureStatus("fixture")
  assert.equal(statusReads, 2, "the next demand at the deadline rechecks GitHub")
  assert.equal(githubStore.get().status?.limited, undefined)
} finally {
  Date.now = originalClock
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow)
  else Reflect.deleteProperty(globalThis, "window")
}
console.log("GitHub limit UI: no sign-in prompt, no extra reads before deadline, demand refresh after deadline")
