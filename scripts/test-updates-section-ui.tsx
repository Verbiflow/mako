import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { Git } from "@mako/git"
import { buildUncommitted, readUncommitted } from "../packages/host/src/application/local-update-source"
import { buildMetadataAt } from "../packages/host/src/base/build-identity"
import type { BuildIdentity, RevisionChanges, UncommittedChanges, UpdateInstallation, UpdateSource } from "../packages/host/src/contracts/app-lifecycle"
import { buildRevisionText, missingDependenciesText, updateSourceText } from "../packages/host/src/contracts/update-source-text"
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
  uncommitted: { count: 0, files: [] },
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
const ENTITIES = new Map([["&lt;", "<"], ["&gt;", ">"], ["&quot;", '"'], ["&#x27;", "'"], ["&amp;", "&"]])
/** Text as the page reads it: each entity decoded once, in one pass. */
const decode = (text: string) => text.replace(/&(?:lt|gt|quot|#x27|amp);/g, (entity) => ENTITIES.get(entity) ?? entity)
/**
 * Each button's label, read tag by tag. React escapes `<` and `>` in every
 * text node and attribute value it renders, so in its markup each `<` opens
 * a tag and the next `>` closes it; the text between tags inside a button is
 * its label.
 */
function buttons(html: string): string[] {
  const labels: string[] = []
  let label: string | null = null
  for (let at = 0; at < html.length; ) {
    if (html[at] === "<") {
      const end = html.indexOf(">", at)
      assert.notEqual(end, -1, "every tag React renders closes")
      const tag = html.slice(at + 1, end)
      if (tag === "/button") {
        if (label !== null) labels.push(decode(label).trim())
        label = null
      } else if (tag === "button" || tag.startsWith("button ")) label = ""
      at = end + 1
    } else {
      const next = html.indexOf("<", at)
      const stop = next === -1 ? html.length : next
      if (label !== null) label += html.slice(at, stop)
      at = stop
    }
  }
  return labels
}

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

// Every uncommitted file Build takes is named before it runs: a count on the card, the files behind it.
const SHARED: UncommittedChanges = {
  count: 41,
  files: [
    { path: "packages/host/src/conversations/live-runtime.ts", change: "edited" },
    { path: "src/components/settings/sync-status.tsx", change: "renamed", from: "src/components/settings/sync-section.tsx" },
    { path: "packages/host/src/base/heap-watch.ts", change: "untracked" },
  ],
}
const taking = draw({ checkout: reading({ head: UPSTREAM, behind: 0, changed: 39, untracked: 2, uncommitted: SHARED, plan: { kind: "as-is", why: "level", installed: false } }) })
assert.match(taking, /<summary[^>]*>.*Includes 41 uncommitted changes<\/summary>/)
assert.match(taking, /aria-label="Uncommitted changes Build takes"/)
assert.match(taking, /packages\/host\/src\/conversations\/live-runtime\.ts<\/span><span[^>]*>Edited</)
assert.match(taking, />src\/components\/settings\/sync-status\.tsx<\/span><span[^>]*>Renamed from src\/components\/settings\/sync-section\.tsx</)
assert.match(taking, />packages\/host\/src\/base\/heap-watch\.ts<\/span><span[^>]*>Untracked</)
assert.match(taking, /and 38 more/)
assert.doesNotMatch(draw({ checkout: reading() }), /data-testid="uncommitted"/, "a clean checkout says nothing of them")
// Already installed, nothing to build: nothing taken either.
assert.doesNotMatch(draw({ checkout: reading({ head: UPSTREAM, behind: 0, uncommitted: SHARED, plan: { kind: "as-is", why: "level", installed: true } }) }), /Uncommitted changes Build takes/)

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

// The fast-forward changed package-lock.json: the build installs what it lists first, and says so, on the Prepare step.
const installing = draw({
  checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "as-is", why: "level", installed: false } }),
  local: { kind: "building", phase: "installing", revision: UPSTREAM, dependencies: { count: 4, names: ["@mako/web-client", "esbuild", "vite"] } },
})
assert.match(installing, /data-testid="update-title"[^>]*>Installing dependencies…</)
assert.match(installing, /package-lock\.json lists 4 packages the checkout hasn't installed: @mako\/web-client, esbuild, vite and 1 more\. Mako is running npm install in the checkout before it builds\. Your installed app and agents stay running\./)
assert.match(installing, /<li aria-current="step"[^>]*><div[^>]*><\/div><span[^>]*>Prepare<\/span><\/li>/, "installing is part of Prepare")
assert.deepEqual(buttons(installing), ["Change…", "Building…"])
// Once it's installed, the build names its revision again.
assert.match(draw({ local: { kind: "building", phase: "copying", revision: UPSTREAM } }), /Building 079f9b31/)
// Refused: the checkout's own edits to package-lock.json, and what to run.
const refusal = "The update couldn't install dependencies: package-lock.json lists a package the checkout hasn't installed: @mako/web-client. The checkout has uncommitted changes to package-lock.json, so Mako won't run npm install there for you. Commit or discard them, or run npm install yourself, then build again. Your installed app and agents were not changed."
const command = "cd '/Users/developer/Projects/mako' && npm install"
const refused = draw({ checkout: reading({ head: UPSTREAM, behind: 0, changed: 1, plan: { kind: "as-is", why: "level", installed: false } }), local: { kind: "error", message: refusal, command } })
assert.ok(decode(refused).includes(`<p>${refusal}</p>`), "the refusal is said whole")
assert.ok(decode(refused).includes(`data-testid="update-command">${command}</code>`), "and the command to run by hand stands apart, to copy whole")
assert.doesNotMatch(draw({ local: { kind: "error", message: "The update failed during packaging: x" } }), /update-command/, "a failure with no command to run shows none")
assert.deepEqual(buttons(refused), ["Change…", "Build 079f9b31 with local changes", "Check again"], "and Build is there to try again once it's resolved")
assert.equal(missingDependenciesText({ count: 1, names: ["dep"] }), "package-lock.json lists a package the checkout hasn't installed: dep.")
assert.equal(missingDependenciesText({ count: 2, names: ["a", "b"] }), "package-lock.json lists 2 packages the checkout hasn't installed: a and b.")
assert.equal(missingDependenciesText({ count: 3, names: ["a", "b", "c"] }), "package-lock.json lists 3 packages the checkout hasn't installed: a, b and c.")

// Ready: both revisions, the fast-forward, and what changed.
const ready = draw({ local: { kind: "ready", build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM }, changes: CHANGES, forwarded: { branch: "main", from: INSTALLED, to: UPSTREAM } } })
assert.match(ready, /data-testid="update-transition"[^>]*><span[^>]*>9a7a5c0c<\/span>.*079f9b31.*· 21 changes.*Signature verified/)
assert.match(ready, /Moved main forward from <span[^>]*>9a7a5c0c<\/span> to <span[^>]*>079f9b31<\/span>\./)

// A build with uncommitted files says so on the way in, and lists the ones it took, read from the build itself.
const readyDirty = draw({ local: { kind: "ready", build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM, dirty: true, uncommitted: SHARED }, changes: CHANGES, forwarded: null } })
assert.match(readyDirty, /data-testid="update-transition"[^>]*>.*079f9b31<\/span><span[^>]*>with 41 uncommitted changes<\/span>/)
assert.match(readyDirty, /aria-label="Uncommitted changes in this update"/)
assert.doesNotMatch(readyDirty, /Uncommitted changes Build takes/, "once built, the build's own list replaces the reading's")

// Installed from Settings: what this build brought, under its revision.
const installed = draw({ build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM }, installed: CHANGES, checkout: reading({ head: UPSTREAM, behind: 0, plan: { kind: "current" }, changes: { from: UPSTREAM, count: 0, titles: [] } }) })
assert.match(installed, /Updated from <span[^>]*>9a7a5c0c<\/span> · 21 changes in this build/)
assert.match(installed, /aria-label="Changes in this build"/)

// The installed app's own metadata, end to end: Settings reads a checkout's uncommitted files as it takes its copy,
// hands them to packaging, package-mac.mjs stamps them into the bundle's makoBuild, and the installed app's host reads
// its bundle and Settings lists them under the installed revision.
const scratch = await mkdtemp(join(tmpdir(), "mako-updates-metadata-"))
const git = new Git()
try {
  const repo = join(scratch, "checkout")
  const gitIn = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "F", GIT_AUTHOR_EMAIL: "f@example.invalid", GIT_COMMITTER_NAME: "F", GIT_COMMITTER_EMAIL: "f@example.invalid" } })
  execFileSync("git", ["init", "-q", "-b", "main", repo])
  await writeFile(join(repo, "app.ts"), "one\n")
  await writeFile(join(repo, "old name.ts"), "two\n")
  gitIn("add", ".")
  gitIn("commit", "-qm", "First")
  await writeFile(join(repo, "app.ts"), "someone's edit\n")
  gitIn("mv", "old name.ts", "new name.ts")
  await writeFile(join(repo, "draft.md"), "not added\n")
  const uncommitted = await readUncommitted(git, repo)
  // As LocalUpdates passes it to the packaging step, and package-mac.mjs stamps it.
  const taken = await buildUncommitted({ MAKO_BUILD_UNCOMMITTED: JSON.stringify(uncommitted), MAKO_BUILD_DIRTY: "1" }, async () => assert.fail("read again"))
  const app = join(scratch, "app")
  execFileSync("mkdir", ["-p", app])
  await writeFile(join(app, "package.json"), JSON.stringify({ name: "mako", makoBuild: { ...build, ...taken } }))
  const stamped = buildMetadataAt(app).makoBuild
  assert.deepEqual(stamped?.uncommitted, { count: 3, files: [{ path: "app.ts", change: "edited" }, { path: "new name.ts", change: "renamed", from: "old name.ts" }, { path: "draft.md", change: "untracked" }] })
  const installedDirty = decode(draw({ build: stamped }))
  assert.match(installedDirty, /Revision <span[^>]*>9a7a5c0c<\/span> with 3 uncommitted changes · Build/)
  assert.match(installedDirty, /aria-label="Uncommitted changes in the installed app"/)
  assert.match(installedDirty, />app\.ts<\/span><span[^>]*>Edited</)
  assert.match(installedDirty, />new name\.ts<\/span><span[^>]*>Renamed from old name\.ts</)
  assert.match(installedDirty, />draft\.md<\/span><span[^>]*>Untracked</)
  assert.equal(buildRevisionText(stamped!), "9a7a5c0c with 3 uncommitted changes", "the CLI says it in the same words")
  // A build stamped before the list, or by an updater that passed only that it was dirty, says only that.
  const unnamed = draw({ build: { ...build, dirty: true } })
  assert.match(unnamed, /Revision <span[^>]*>9a7a5c0c<\/span> with uncommitted changes · Build/)
  assert.doesNotMatch(unnamed, /data-testid="uncommitted"/)
  const clean = draw({ build })
  assert.doesNotMatch(clean, /data-testid="uncommitted"/, "a clean build lists none")
  assert.match(clean, /Revision <span[^>]*>9a7a5c0c<\/span> · Build/, "and says none")
} finally {
  git.close()
  await rm(scratch, { recursive: true, force: true })
}

// The CLI reads the same words.
const text = updateSourceText(reading())
assert.equal(text.action, "Update to main 079f9b31 (21 new changes)")
assert.equal(updateSourceText(reading({ behind: 1, changes: { from: INSTALLED, count: 1, titles: ["One"] } })).action, "Update to main 079f9b31 (1 new change)")
assert.equal(updateSourceText(reading({ upstream: null, behind: 0, plan: { kind: "as-is", why: "no-upstream", installed: false }, target: INSTALLED })).action, "Build main 9a7a5c0c")
assert.equal(updateSourceText(reading({ branch: null, plan: { kind: "as-is", why: "detached", installed: false }, target: INSTALLED })).title, "The checkout isn't on a branch")

console.log("Updates section: says what Build will take before it runs (fast-forward, already installed, local changes, another branch, diverged, offline, unreadable), names every uncommitted file it takes, names the revision it builds, says when it installs dependencies first and why it won't, and shows both revisions, the changes and the uncommitted files once built and once installed, read from the build's own metadata")
