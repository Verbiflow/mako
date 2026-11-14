import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { testScratch } from "./lib/test-scratch.mjs"
import { rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { Git } from "@mako/git"
import { buildUncommitted, readUncommitted } from "../packages/host/src/application/local-update-source"
import { buildMetadataAt } from "../packages/host/src/base/build-identity"
import type { BuildIdentity, CheckoutStanding, RevisionChanges, UncommittedChanges, UpdateInstallation, UpdateSource, UpdateSourcePlan } from "../packages/host/src/contracts/app-lifecycle"
import { buildRevisionText, missingDependenciesText, updateSourceText } from "../packages/host/src/contracts/update-source-text"
import { UpdatesSection } from "../src/components/settings/updates-section"
import { applicationStore } from "../src/state/application"
import { updatesStore } from "../src/state/updates"

/**
 * Settings › Updates for a locally signed install says what Build will take
 * before it runs: the upstream's new changes and the one click that builds
 * them clean without touching the checkout, beside it the checkout as it is
 * with every uncommitted file and who changed it, or the revision already
 * installed. After a build, the revisions on either side, where it came
 * from, how long it took and what changed; after a failure, whose it is and
 * what to do.
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
const plan = (recommended: UpdateSourcePlan["recommended"], standing: CheckoutStanding, installed: { upstream?: boolean | null; checkout?: boolean } = {}): UpdateSourcePlan => ({
  recommended,
  upstream: installed.upstream === null ? null : { installed: installed.upstream ?? false },
  checkout: { standing, installed: installed.checkout ?? false },
})
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
  plan: plan("upstream", "behind"),
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
assert.match(behind, /Mako builds origin\/main at 079f9b31 in a clean copy of its own and leaves your checkout exactly as it is\. main is 21 commits behind origin\/main\./)
assert.deepEqual(buttons(behind), ["Change…", "Update to origin/main 079f9b31 (21 new changes)", "Build main 9a7a5c0c as it is", "Check again"])
assert.match(behind, /main at 9a7a5c0c · origin\/main at 079f9b31/)
assert.match(behind, /Revision <span[^>]*>9a7a5c0c<\/span> · Build <span[^>]*>b9c5c96a71e04f0d/, "the installed revision is on the page, not in a tooltip")
assert.match(behind, /Proofs and tests run harnesses in a home of their own \(#189\)/)
assert.match(behind, /and 19 more/)

// Already installed: no build to start.
const current = draw({ build: { ...build, revision: UPSTREAM }, checkout: reading({ head: UPSTREAM, behind: 0, plan: plan(null, "level", { upstream: true, checkout: true }), changes: { from: UPSTREAM, count: 0, titles: [] } }) })
assert.match(current, /You're already on 079f9b31/)
assert.match(current, /Your installed app was built from origin\/main at its newest commit\./)
assert.deepEqual(buttons(current), ["Change…", "Check again"])

// Behind with another session's uncommitted files, the day three updates built old code: Build takes the upstream
// clean and leaves them out, naming each and who changed it; the checkout as it is, with them, stands beside it.
const dirty = draw({ checkout: reading({ changed: 3, untracked: 1, uncommitted: { count: 4, files: [{ path: "packages/git/src/run.ts", change: "edited", by: ["Speed up the Git runner"] }, { path: "notes.md", change: "untracked", by: ["you"] }] } }) })
assert.match(dirty, /21 new changes on origin\/main/)
assert.match(decode(dirty), /main is 21 commits behind origin\/main, and it has uncommitted changes in 3 files and 1 untracked file, changed by “Speed up the Git runner” and you, that this build leaves out\./)
assert.deepEqual(buttons(dirty), ["Change…", "Update to origin/main 079f9b31 (21 new changes)", "Build main 9a7a5c0c with 4 uncommitted changes", "Check again"])
assert.match(dirty, /<summary[^>]*>.*Leaves out 4 uncommitted changes<\/summary>/)
assert.match(dirty, />packages\/git\/src\/run\.ts<\/span><span[^>]*>Edited · Speed up the Git runner</)
assert.match(dirty, /aria-label="Uncommitted changes this build leaves out"/)
assert.match(dirty, /Mako never moves or changes the checkout\./)

// Every uncommitted file Build takes is named before it runs: a count on the card, the files behind it.
const SHARED: UncommittedChanges = {
  count: 41,
  files: [
    { path: "packages/host/src/conversations/live-runtime.ts", change: "edited" },
    { path: "src/components/settings/sync-status.tsx", change: "renamed", from: "src/components/settings/sync-section.tsx" },
    { path: "packages/host/src/base/heap-watch.ts", change: "untracked" },
  ],
}
const taking = draw({ checkout: reading({ head: LOCAL, ahead: 1, behind: 0, changed: 39, untracked: 2, uncommitted: SHARED, plan: plan("checkout", "ahead"), target: LOCAL }) })
assert.match(taking, /<summary[^>]*>.*Includes 41 uncommitted changes<\/summary>/)
assert.match(taking, /aria-label="Uncommitted changes Build takes"/)
assert.match(taking, /packages\/host\/src\/conversations\/live-runtime\.ts<\/span><span[^>]*>Edited</)
assert.match(taking, />src\/components\/settings\/sync-status\.tsx<\/span><span[^>]*>Renamed from src\/components\/settings\/sync-section\.tsx</)
assert.match(taking, />packages\/host\/src\/base\/heap-watch\.ts<\/span><span[^>]*>Untracked</)
assert.match(taking, /and 38 more/)
assert.doesNotMatch(draw({ checkout: reading() }), /data-testid="uncommitted"/, "a clean checkout says nothing of them")
// Already installed, nothing to build: nothing taken either.
assert.doesNotMatch(draw({ checkout: reading({ head: UPSTREAM, behind: 0, uncommitted: SHARED, plan: plan(null, "level", { upstream: true, checkout: true }) }) }), /Uncommitted changes Build takes/)

// Another branch behind the upstream: named, never switched, offered beside the upstream.
const branch = draw({ checkout: reading({ head: LOCAL, branch: "approval-bar", ahead: 2, plan: plan("upstream", "branch") }) })
assert.match(branch, /The checkout is on approval-bar, not main/)
assert.deepEqual(buttons(branch), ["Change…", "Update to origin/main 079f9b31 (21 new changes)", "Build approval-bar 4be1d02a as it is", "Check again"])
const branchInstalled = draw({ build: { ...build, revision: LOCAL }, checkout: reading({ head: LOCAL, branch: "approval-bar", plan: plan("upstream", "branch", { checkout: true }) }) })
assert.deepEqual(buttons(branchInstalled), ["Change…", "Update to origin/main 079f9b31 (21 new changes)", "Check again"], "the installed revision isn't offered again")
// The checkout's own commits on top of the upstream: built as it is, the upstream offered instead.
const ahead = draw({ checkout: reading({ head: LOCAL, ahead: 2, behind: 0, plan: plan("checkout", "ahead"), target: LOCAL }) })
assert.match(ahead, /main has 2 commits origin\/main doesn't\. Mako builds main as it is, at 4be1d02a\./)
assert.deepEqual(buttons(ahead), ["Change…", "Build main 4be1d02a", "Build origin/main 079f9b31 instead", "Check again"])

// Diverged.
const diverged = draw({ checkout: reading({ head: LOCAL, ahead: 2, plan: plan("upstream", "diverged") }) })
assert.match(diverged, /main has 2 commits origin\/main doesn't and is 21 commits behind it/)

// Offline: said once, and what the reading compared with instead.
const offline = draw({ checkout: reading({ fetch: { kind: "failed", reason: "origin didn't answer in 15 seconds" } }) })
assert.match(offline, /Couldn't reach origin: origin didn't answer in 15 seconds\. This compares with what was fetched from it before\./)
assert.deepEqual(buttons(offline), ["Change…", "Update to origin/main 079f9b31 (21 new changes)", "Build main 9a7a5c0c as it is", "Check again"], "what was fetched before still updates")

// Reading: the checkout row says so while the fetch runs.
const checking = draw({ reading: true })
assert.match(checking, /Checking your checkout/)
assert.match(checking, /aria-label="Checking"/)
assert.match(buttons(checking).join("|"), /Checking…/)

// A folder Git can't read: no build to offer.
const unreadable = draw({ checkout: { kind: "unreadable", reason: "/Users/developer/Projects/mako isn't a Git checkout, so Mako can't tell which revision it holds." } })
assert.match(unreadable, /Mako can't read the checkout/)
assert.deepEqual(buttons(unreadable), ["Change…", "Check again"])

// Building names where from and the revision it builds.
const building = draw({ checkout: reading({ head: UPSTREAM, behind: 0, plan: plan("upstream", "level") }), local: { kind: "building", phase: "checking", from: "upstream", revision: UPSTREAM } })
assert.match(building, /Building origin\/main 079f9b31/)
assert.match(building, /Building in a clean copy of Mako's own; your checkout isn't touched\./)
assert.deepEqual(buttons(building), ["Change…", "Building…"])

// The upstream's package-lock.json lists more than the copy holds: the build installs it there first, and says so, on the Prepare step.
const installing = draw({
  checkout: reading({ head: UPSTREAM, behind: 0, plan: plan("upstream", "level") }),
  local: { kind: "building", phase: "installing", revision: UPSTREAM, dependencies: { count: 4, names: ["@mako/web-client", "esbuild", "vite"] } },
})
assert.match(installing, /data-testid="update-title"[^>]*>Installing dependencies…</)
assert.match(installing, /package-lock\.json lists 4 packages the checkout hasn't installed: @mako\/web-client, esbuild, vite and 1 more\. Mako is running npm install in its own copy before it builds\. Your checkout, installed app and agents stay as they are\./)
assert.match(installing, /<li aria-current="step"[^>]*><div[^>]*><\/div><span[^>]*>Prepare<\/span><\/li>/, "installing is part of Prepare")
assert.deepEqual(buttons(installing), ["Change…", "Building…"])
// Once it's installed, the build names its revision again.
assert.match(draw({ local: { kind: "building", phase: "copying", revision: UPSTREAM } }), /Building 079f9b31/)
// Refused: the checkout's own edits to package-lock.json, and what to run.
const refusal = "The update couldn't install dependencies: package-lock.json lists a package the checkout hasn't installed: @mako/web-client. The checkout has uncommitted changes to package-lock.json, so Mako won't run npm install there for you. Commit or discard them, or run npm install yourself, then build again. Your installed app and agents were not changed."
const command = "cd '/Users/developer/Projects/mako' && npm install"
const refused = draw({ checkout: reading({ head: LOCAL, ahead: 1, behind: 0, changed: 1, plan: plan("checkout", "ahead"), target: LOCAL }), local: { kind: "error", message: refusal, command } })
assert.ok(decode(refused).includes(`<p>${refusal}</p>`), "the refusal is said whole")
assert.ok(decode(refused).includes(`data-testid="update-command">${command}</code>`), "and the command to run by hand stands apart, to copy whole")
assert.doesNotMatch(draw({ local: { kind: "error", message: "The update failed during packaging: x" } }), /update-command/, "a failure with no command to run shows none")
assert.deepEqual(buttons(refused), ["Change…", "Build 4be1d02a with local changes", "Build origin/main 079f9b31 instead", "Check again"], "and Build is there to try again once it's resolved")
// A failure the build could word: whose it is, what to do, and what the command printed behind it.
const codeFailure = { step: "checking" as const, blame: "code" as const, what: "Checking (test:application) failed on origin/main at 079f9b31.", next: "It fails the same way for anyone on this commit, so wait for a fix on origin/main, then build again.", details: "AssertionError: with nobody to choose, unsure fails" }
const failedOnCode = decode(draw({ checkout: reading(), local: { kind: "error", message: `${codeFailure.what} ${codeFailure.next} Your installed app and agents were not changed.`, failure: codeFailure } }))
assert.match(failedOnCode, /data-testid="update-failure"><p><span[^>]*>The code:<\/span> Checking \(test:application\) failed on origin\/main at 079f9b31\.<\/p><p[^>]*>It fails the same way for anyone on this commit/)
assert.match(failedOnCode, /What it printed<\/summary><pre[^>]*>AssertionError: with nobody to choose, unsure fails<\/pre>/)
const machineFailure = { step: "compiling" as const, blame: "machine" as const, what: "Compiling failed: the Mac ran out of open files.", next: "This is the Mac, not the code. Wait for agents and builds to finish, then build again." }
assert.match(decode(draw({ checkout: reading(), local: { kind: "error", message: "x", failure: machineFailure } })), /<span[^>]*>This Mac:<\/span> Compiling failed: the Mac ran out of open files\./)
assert.equal(missingDependenciesText({ count: 1, names: ["dep"] }), "package-lock.json lists a package the checkout hasn't installed: dep.")
assert.equal(missingDependenciesText({ count: 2, names: ["a", "b"] }), "package-lock.json lists 2 packages the checkout hasn't installed: a and b.")
assert.equal(missingDependenciesText({ count: 3, names: ["a", "b", "c"] }), "package-lock.json lists 3 packages the checkout hasn't installed: a, b and c.")

// Ready: both revisions, where it came from and how long it took, and what changed.
const ready = draw({ checkout: reading(), local: { kind: "ready", build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM }, changes: CHANGES, from: "upstream", took: { ms: 312_000, steps: {} } } })
assert.match(ready, /data-testid="update-transition"[^>]*><span[^>]*>9a7a5c0c<\/span>.*079f9b31.*· 21 changes.*Signature verified/)
assert.match(ready, /Built in 5 min from origin\/main in a clean copy; your checkout wasn't touched\./)

// A build with uncommitted files says so on the way in, and lists the ones it took, read from the build itself.
const readyDirty = draw({ local: { kind: "ready", build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM, dirty: true, uncommitted: SHARED }, changes: CHANGES } })
assert.match(readyDirty, /data-testid="update-transition"[^>]*>.*079f9b31<\/span><span[^>]*>with 41 uncommitted changes<\/span>/)
assert.match(readyDirty, /aria-label="Uncommitted changes in this update"/)
assert.doesNotMatch(readyDirty, /Uncommitted changes Build takes/, "once built, the build's own list replaces the reading's")

// Installed from Settings: what this build brought, under its revision.
const installed = draw({ build: { ...build, id: "c41e7d2f9a0b3e65", revision: UPSTREAM }, installed: CHANGES, checkout: reading({ head: UPSTREAM, behind: 0, plan: plan(null, "level", { upstream: true, checkout: true }), changes: { from: UPSTREAM, count: 0, titles: [] } }) })
assert.match(installed, /Updated from <span[^>]*>9a7a5c0c<\/span> · 21 changes in this build/)
assert.match(installed, /aria-label="Changes in this build"/)

// The installed app's own metadata, end to end: Settings reads a checkout's uncommitted files as it takes its copy,
// hands them to packaging, package-mac.mjs stamps them into the bundle's makoBuild, and the installed app's host reads
// its bundle and Settings lists them under the installed revision.
const scratch = testScratch("mako-updates-metadata-")
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
  await git.close()
  await rm(scratch, { recursive: true, force: true })
}

// The CLI reads the same words.
const text = updateSourceText(reading())
assert.equal(text.action, "Update to origin/main 079f9b31 (21 new changes)")
assert.equal(updateSourceText(reading({ behind: 1, changes: { from: INSTALLED, count: 1, titles: ["One"] } })).action, "Update to origin/main 079f9b31 (1 new change)")
assert.equal(updateSourceText(reading({ upstream: null, behind: 0, plan: plan("checkout", "no-upstream", { upstream: null }), target: INSTALLED })).action, "Build main 9a7a5c0c")
assert.match(updateSourceText(reading({ branch: null, plan: plan("upstream", "detached") })).detail, /The checkout's HEAD isn't on a branch\./)

console.log("Updates section: says what Build will take before it runs (the upstream clean by default when behind or dirty, the checkout as it is beside it, already installed, another branch, ahead, diverged, offline, unreadable), names every uncommitted file and who changed it, names where from and the revision it builds, says when it installs dependencies first and why it won't, says whose a failure is and what to do, and shows both revisions, where it came from, how long it took, the changes and the uncommitted files once built and once installed")
