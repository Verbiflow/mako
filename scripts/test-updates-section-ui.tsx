import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import type { BuildIdentity, RevisionChanges, UpdateInstallation, UpdateSource } from "../packages/host/src/contracts/app-lifecycle"
import { updateSourceText } from "../packages/host/src/contracts/update-source-text"
import { UpdatesSection } from "../src/components/settings/updates-section"
import { applicationStore } from "../src/state/application"
import { updatesStore } from "../src/state/updates"

/**
 * Settings › Updates for a locally signed install says what Build will take
 * before it runs: the upstream's new changes and the one click that brings
 * them in, the revision already installed, or why the checkout is built as it
 * is. After a build, the revisions on either side and what changed.
 */

const INSTALLED = "9a7a5c0c4c9be872bbbbab91721f326d461fa830"
const UPSTREAM = "079f9b315af4593fec599bf9926fad1797dbec64"
const LOCAL = "4be1d02a7e93c5f18a0d6b2c97e4f3a1d8c0b5e6"
const CHANGES: RevisionChanges = {
  from: INSTALLED,
  count: 21,
  titles: ["Proofs and tests run harnesses in a home of their own (#189)", "Sync the last 30 days whole (#188)"],
}
const build: BuildIdentity = { id: "b9c5c96a71e04f0d", builtAt: "2026-10-28T08:22:00.000Z", revision: INSTALLED, dirty: false }
type Checkout = Extract<UpdateSource, { kind: "checkout" }>
const reading = (overrides: Partial<Checkout> = {}): Checkout => ({
  kind: "checkout",
  head: INSTALLED,
  branch: "main",
  upstream: { name: "origin/main", commit: UPSTREAM, branch: "main" },
  ahead: 0,
  behind: 21,
  changed: 0,
  untracked: 0,
  fetch: { kind: "fetched" },
  plan: { kind: "fast-forward" },
  target: UPSTREAM,
  changes: CHANGES,
  readAt: "2026-10-28T08:20:00.000Z",
  ...overrides,
})
updatesStore.set({ version: "0.0.1", status: "unsupported" })
const draw = (installation: Partial<UpdateInstallation>) => {
  applicationStore.set({
    installation: { distribution: "local", build, source: "/Users/developer/Projects/mako", local: { kind: "idle" }, checkout: null, reading: false, installed: null, ...installation },
    lifecycle: { revision: "r", operation: { kind: "idle" }, work: [] },
    busy: false,
    error: null,
  })
  return renderToStaticMarkup(<UpdatesSection />).replaceAll("&#x27;", "'")
}
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1]!.replace(/<[^>]+>/g, ""))

// The day this was written: 21 merged pull requests on origin/main, the checkout clean and behind.
const behind = draw({ checkout: reading() })
assert.match(behind, /data-testid="update-title"[^>]*>21 new changes on origin\/main</)
assert.match(behind, /Mako moves main forward to 079f9b31, then builds and verifies the app\./)
assert.deepEqual(buttons(behind), ["Change…", "Update to main 079f9b31 (21 new changes)", "Check again"])
assert.match(behind, /main at 9a7a5c0c · origin\/main at 079f9b31/)
assert.match(behind, /Revision <span[^>]*>9a7a5c0c<\/span> · Build <span[^>]*>b9c5c96a71e04f0d/, "the installed revision is on the page, not in a tooltip")
assert.match(behind, /Proofs and tests run harnesses in a home of their own \(#189\)/)
assert.match(behind, /and 19 more/)

// Already installed: no build to start.
const current = draw({ build: { ...build, revision: UPSTREAM }, checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "current" }, changes: { from: UPSTREAM, count: 0, titles: [] } }) })
assert.match(current, /You're already on 079f9b31/)
assert.match(current, /Your installed app was built from origin\/main at its newest commit\./)
assert.deepEqual(buttons(current), ["Change…", "Check again"])

// Uncommitted changes keep the branch where it is; the build takes them as they are and says so.
const dirty = draw({ checkout: reading({ changed: 3, untracked: 1, plan: { kind: "as-is", why: "changes", installed: false }, target: INSTALLED, changes: { from: INSTALLED, count: 0, titles: [] } }) })
assert.match(dirty, /21 new changes on origin\/main/)
assert.match(dirty, /main has uncommitted changes in 3 files and 1 untracked file, so Mako won't move it\. Commit or discard them to take the update, or build 9a7a5c0c as it is\./)
assert.deepEqual(buttons(dirty), ["Change…", "Build 9a7a5c0c as it is", "Check again"])

// Another branch: named, never switched.
const branch = draw({ checkout: reading({ head: LOCAL, branch: "approval-bar", ahead: 2, plan: { kind: "as-is", why: "branch", installed: false }, target: LOCAL }) })
assert.match(branch, /The checkout is on approval-bar/)
assert.match(branch, /Updates come from origin\/main, which main tracks, and approval-bar is 21 commits behind it\. Mako never switches branches\. Mako builds approval-bar as it is, at 4be1d02a\./)
assert.deepEqual(buttons(branch), ["Change…", "Build approval-bar 4be1d02a", "Check again"])
const branchInstalled = draw({ build: { ...build, revision: LOCAL }, checkout: reading({ head: LOCAL, branch: "approval-bar", plan: { kind: "as-is", why: "branch", installed: true }, target: LOCAL }) })
assert.match(branchInstalled, /Your app is already on 4be1d02a, so there's nothing to build\./)
assert.deepEqual(buttons(branchInstalled), ["Change…", "Check again"], "the installed revision isn't offered again")

// Diverged.
const diverged = draw({ checkout: reading({ head: LOCAL, ahead: 2, plan: { kind: "as-is", why: "diverged", installed: false }, target: LOCAL }) })
assert.match(diverged, /main and origin\/main have diverged/)
assert.match(diverged, /2 commits here, 21 commits there\. Mako won't merge them\./)

// Offline: said once, and what the reading compared with instead.
const offline = draw({ checkout: reading({ fetch: { kind: "failed", reason: "origin didn't answer in 15 seconds" } }) })
assert.match(offline, /Couldn't reach origin: origin didn't answer in 15 seconds\. This compares with what was fetched from it before\./)
assert.deepEqual(buttons(offline), ["Change…", "Update to main 079f9b31 (21 new changes)", "Check again"], "what was fetched before still updates")

// Reading: the checkout row says so while the fetch runs.
const checking = draw({ reading: true })
assert.match(checking, /Checking your checkout/)
assert.match(checking, /aria-label="Checking"/)
assert.match(buttons(checking).join("|"), /Checking…/)

// A folder Git can't read: no build to offer.
const unreadable = draw({ checkout: { kind: "unreadable", reason: "/Users/developer/Projects/mako isn't a Git checkout, so Mako can't tell which revision it holds." } })
assert.match(unreadable, /Mako can't read the checkout/)
assert.deepEqual(buttons(unreadable), ["Change…", "Check again"])

// Building names the revision it builds.
const building = draw({ checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "as-is", why: "level", installed: false } }), local: { kind: "building", phase: "checking", revision: UPSTREAM } })
assert.match(building, /Building 079f9b31/)
assert.deepEqual(buttons(building), ["Change…", "Building…"])

// Ready: both revisions, the fast-forward, and what changed.
const ready = draw({ local: { kind: "ready", build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM }, changes: CHANGES, forwarded: { branch: "main", from: INSTALLED, to: UPSTREAM } } })
assert.match(ready, /data-testid="update-transition"[^>]*><span[^>]*>9a7a5c0c<\/span>.*079f9b31.*· 21 changes.*Signature verified/)
assert.match(ready, /Moved main forward from <span[^>]*>9a7a5c0c<\/span> to <span[^>]*>079f9b31<\/span>\./)

// Installed from Settings: what this build brought, under its revision.
const installed = draw({ build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM }, installed: CHANGES, checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "current" }, changes: { from: UPSTREAM, count: 0, titles: [] } }) })
assert.match(installed, /Updated from <span[^>]*>9a7a5c0c<\/span> · 21 changes in this build/)
assert.match(installed, /aria-label="Changes in this build"/)

// The CLI reads the same words.
const text = updateSourceText(reading())
assert.equal(text.action, "Update to main 079f9b31 (21 new changes)")
assert.equal(updateSourceText(reading({ behind: 1, changes: { from: INSTALLED, count: 1, titles: ["One"] } })).action, "Update to main 079f9b31 (1 new change)")
assert.equal(updateSourceText(reading({ upstream: null, behind: 0, plan: { kind: "as-is", why: "no-upstream", installed: false }, target: INSTALLED })).action, "Build main 9a7a5c0c")
assert.equal(updateSourceText(reading({ branch: null, plan: { kind: "as-is", why: "detached", installed: false }, target: INSTALLED })).title, "The checkout isn't on a branch")

console.log("Updates section: says what Build will take before it runs (fast-forward, already installed, local changes, another branch, diverged, offline, unreadable), names the revision it builds, and shows both revisions and the changes once built and once installed")
