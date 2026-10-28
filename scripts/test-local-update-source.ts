import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { bringForward, readUpdateSource } from "@mako/host/application/local-update-source"
import { LocalUpdates } from "@mako/host/application/local-updates"
import type { UpdateSource } from "@mako/host/contracts/app-lifecycle"

/**
 * What a Settings build takes from its source checkout, against real
 * repositories and a local bare remote: a checkout behind its upstream and
 * clean is fast-forwarded (files and index with it), anything else is built
 * as it is with the reason named, uncommitted and untracked work is never
 * touched, the branch never changes, and the installed revision is never
 * rebuilt.
 */

const root = await mkdtemp(join(tmpdir(), "mako-update-source-"))
const globalConfig = join(root, "gitconfig")
await writeFile(globalConfig, "")
// The person's own Git configuration (hooks, signing, aliases) stays out of the fixture.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
})
const git = new Git()
const run = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
const commit = async (cwd: string, file: string, text: string, subject: string) => {
  await writeFile(join(cwd, file), text)
  run(cwd, "add", file)
  run(cwd, "commit", "-qm", subject)
  return run(cwd, "rev-parse", "HEAD")
}
const checkout = (reading: UpdateSource) => {
  assert.equal(reading.kind, "checkout")
  if (reading.kind !== "checkout") throw new Error("unreachable")
  return reading
}

try {
  const remote = join(root, "remote.git")
  const writer = join(root, "writer")
  const source = join(root, "source")
  run(root, "init", "-q", "--bare", "-b", "main", remote)
  run(root, "clone", "-q", remote, writer)
  run(writer, "checkout", "-q", "-b", "main")
  const first = await commit(writer, "app.txt", "one\n", "First (#1)")
  run(writer, "push", "-q", "origin", "main")
  run(root, "clone", "-q", remote, source)
  assert.equal(run(source, "rev-parse", "HEAD"), first)
  const installed = { revision: first, dirty: false }

  // Level with the upstream and installed: nothing to build.
  const level = checkout(await readUpdateSource(git, source, { fetch: true, installed }))
  assert.deepEqual(level.plan, { kind: "current" })
  assert.equal(level.fetch.kind, "fetched")
  assert.deepEqual(level.upstream, { name: "origin/main", commit: first, branch: "main" })
  assert.deepEqual(level.changes, { from: first, count: 0, titles: [] })

  // Three pull requests land upstream. Without a fetch the checkout can't know; with one it is behind by three.
  await commit(writer, "app.txt", "two\n", "Second (#2)")
  await commit(writer, "other.txt", "other\n", "Third (#3)")
  const newest = await commit(writer, "app.txt", "four\n", "Fourth (#4)")
  run(writer, "push", "-q", "origin", "main")
  assert.deepEqual(checkout(await readUpdateSource(git, source, { fetch: false, installed })).plan, { kind: "current" }, "what was fetched before is all an unfetched reading knows")
  await writeFile(join(source, "notes.txt"), "someone's untracked notes\n")
  const behind = checkout(await readUpdateSource(git, source, { fetch: true, installed }))
  assert.deepEqual(behind.plan, { kind: "fast-forward" }, "untracked files don't keep a checkout from moving forward")
  assert.equal(behind.behind, 3)
  assert.equal(behind.ahead, 0)
  assert.equal(behind.untracked, 1)
  assert.equal(behind.target, newest)
  assert.deepEqual(behind.changes, { from: first, count: 3, titles: ["Fourth (#4)", "Third (#3)", "Second (#2)"] })

  // Fast-forward moves the branch, the index and the files; the untracked notes stay as they were.
  assert.deepEqual(await bringForward(git, source, behind), { branch: "main", from: first, to: newest })
  assert.equal(run(source, "rev-parse", "HEAD"), newest)
  assert.equal(run(source, "symbolic-ref", "--short", "HEAD"), "main")
  assert.equal(await readFile(join(source, "app.txt"), "utf8"), "four\n")
  assert.equal(await readFile(join(source, "other.txt"), "utf8"), "other\n")
  assert.equal(run(source, "status", "--porcelain", "--untracked-files=no"), "", "the index moved with the branch")
  assert.equal(await readFile(join(source, "notes.txt"), "utf8"), "someone's untracked notes\n")
  assert.match(run(source, "reflog", "-1", "--format=%gs"), /Fast-forward/)
  assert.equal(run(source, "stash", "list"), "", "nothing was stashed")
  const forwarded = checkout(await readUpdateSource(git, source, { fetch: false, installed }))
  assert.deepEqual(forwarded.plan, { kind: "as-is", why: "level", installed: false }, "level with the upstream, ahead of the installed build")
  assert.equal(forwarded.changes?.count, 3)
  await rm(join(source, "notes.txt"))
  assert.deepEqual(checkout(await readUpdateSource(git, source, { fetch: false, installed: { revision: newest, dirty: false } })).plan, { kind: "current" })
  assert.equal(checkout(await readUpdateSource(git, source, { fetch: false, installed: { revision: newest, dirty: true } })).plan.kind, "as-is", "an installed build with local changes is never taken for the clean revision")

  // A reading that went stale is refused rather than applied: HEAD moved after it was read.
  const fifth = await commit(writer, "app.txt", "five\n", "Fifth (#5)")
  run(writer, "push", "-q", "origin", "main")
  const stale = checkout(await readUpdateSource(git, source, { fetch: true, installed }))
  assert.equal(stale.plan.kind, "fast-forward")
  run(source, "checkout", "-q", "--detach")
  await assert.rejects(bringForward(git, source, stale), /Couldn't bring main up to .*moved since it was read.*Nothing in the checkout changed/)
  run(source, "checkout", "-q", "main")
  assert.equal(run(source, "rev-parse", "HEAD"), newest)

  // Uncommitted changes to tracked files: built as they are, and a fast-forward asked for anyway is refused.
  await writeFile(join(source, "app.txt"), "someone's edit\n")
  const changed = checkout(await readUpdateSource(git, source, { fetch: false, installed }))
  assert.deepEqual(changed.plan, { kind: "as-is", why: "changes", installed: false })
  assert.equal(changed.changed, 1)
  assert.equal(changed.target, newest, "a checkout built as it is carries its own HEAD")
  assert.equal(await bringForward(git, source, changed), null)
  await assert.rejects(bringForward(git, source, { ...changed, plan: { kind: "fast-forward" }, target: fifth }), /uncommitted changes in 1 file/)
  assert.equal(await readFile(join(source, "app.txt"), "utf8"), "someone's edit\n", "someone's edit is untouched")
  run(source, "checkout", "--", "app.txt")

  // An untracked file the update would overwrite: Git refuses and the file stays.
  await commit(writer, "fresh.txt", "upstream\n", "Sixth (#6)")
  run(writer, "push", "-q", "origin", "main")
  await writeFile(join(source, "fresh.txt"), "mine\n")
  const collides = checkout(await readUpdateSource(git, source, { fetch: true, installed }))
  assert.equal(collides.plan.kind, "fast-forward")
  await assert.rejects(bringForward(git, source, collides), /untracked files there would be overwritten/)
  assert.equal(await readFile(join(source, "fresh.txt"), "utf8"), "mine\n")
  assert.equal(run(source, "rev-parse", "HEAD"), newest)
  await rm(join(source, "fresh.txt"))

  // Another branch: built as it is, never switched. Its revision installed, there is nothing to build.
  run(source, "checkout", "-q", "-b", "feature")
  const other = checkout(await readUpdateSource(git, source, { fetch: false, installed }))
  assert.deepEqual(other.plan, { kind: "as-is", why: "branch", installed: false })
  assert.equal(other.upstream?.branch, "main", "the branch that tracks the upstream is named")
  assert.deepEqual(checkout(await readUpdateSource(git, source, { fetch: false, installed: { revision: newest, dirty: false } })).plan, { kind: "as-is", why: "branch", installed: true })
  assert.equal(await bringForward(git, source, other), null)
  assert.equal(run(source, "symbolic-ref", "--short", "HEAD"), "feature")
  run(source, "checkout", "-q", "main")

  // Detached, and diverged.
  run(source, "checkout", "-q", "--detach")
  assert.deepEqual(checkout(await readUpdateSource(git, source, { fetch: false, installed })).plan, { kind: "as-is", why: "detached", installed: false })
  run(source, "checkout", "-q", "main")
  await commit(source, "local.txt", "local\n", "Local work")
  const diverged = checkout(await readUpdateSource(git, source, { fetch: false, installed }))
  assert.deepEqual(diverged.plan, { kind: "as-is", why: "diverged", installed: false })
  assert.equal(diverged.ahead, 1)
  assert.equal(diverged.behind, 2)
  run(source, "reset", "-q", "--hard", newest)

  // Offline: the fetch fails with a reason, and the reading compares with what was fetched before.
  run(source, "remote", "set-url", "origin", join(root, "gone.git"))
  const offline = checkout(await readUpdateSource(git, source, { fetch: true, installed }))
  assert.equal(offline.fetch.kind, "failed")
  if (offline.fetch.kind === "failed") assert.match(offline.fetch.reason, /gone\.git|does not appear|not found/i)
  assert.equal(offline.plan.kind, "fast-forward", "the upstream as last fetched still counts")
  run(source, "remote", "set-url", "origin", remote)

  // No remote at all, and a folder that isn't a checkout.
  const alone = join(root, "alone")
  run(root, "init", "-q", "-b", "main", alone)
  const only = await commit(alone, "a.txt", "a\n", "Only")
  assert.deepEqual(checkout(await readUpdateSource(git, alone, { fetch: true, installed: null })).plan, { kind: "as-is", why: "no-upstream", installed: false })
  assert.deepEqual(checkout(await readUpdateSource(git, alone, { fetch: false, installed: { revision: only, dirty: false } })).plan, { kind: "current" })
  const plain = await mkdtemp(join(tmpdir(), "mako-update-plain-"))
  try {
    const unreadable = await readUpdateSource(git, plain, { fetch: true, installed: null })
    assert.equal(unreadable.kind, "unreadable")
  } finally {
    await rm(plain, { recursive: true, force: true })
  }

  // Settings' builder: a build of the installed revision stops before copying anything.
  await writeFile(join(writer, "package.json"), JSON.stringify({
    name: "mako",
    scripts: { build: "node -e 0", lint: "node -e 0", "package:mac:local": "node -e 0", "test:performance": "node -e 0", "test:application": "node -e 0", "test:renderer-assets": "node -e 0" },
  }))
  run(writer, "add", "package.json")
  run(writer, "commit", "-qm", "Package (#7)")
  run(writer, "push", "-q", "origin", "main")
  run(source, "pull", "-q", "--ff-only")
  const head = run(source, "rev-parse", "HEAD")
  const identity = (revision: string) => ({ id: "c".repeat(16), builtAt: new Date().toISOString(), revision, dirty: false })
  const finished = (updates: LocalUpdates) => new Promise<void>((resolve) => {
    const poll = () => (updates.building ? setTimeout(poll, 20) : resolve())
    poll()
  })
  const currentRoot = join(root, "current-updates")
  // A disk with room, so the fixture doesn't depend on the machine's.
  const roomy = { statfs: async () => ({ bavail: 1e12, bsize: 1 }) }
  const current = new LocalUpdates(git, currentRoot, "A".repeat(40), () => {}, identity(head), roomy)
  await current.load()
  await current.select(source)
  current.start()
  await finished(current)
  assert.deepEqual(current.snapshot().local, { kind: "idle" }, "the installed revision isn't rebuilt")
  const reading = current.snapshot().checkout
  assert.equal(reading?.kind === "checkout" && reading.plan.kind, "current")
  assert.deepEqual((await readdir(currentRoot)).filter((name) => /^(checkout|build-)/.test(name)), [], "nothing was copied")

  // Behind: Build brings the checkout forward before it copies, builds the new revision, and names it.
  await commit(writer, "app.txt", "eight\n", "Eighth (#8)")
  run(writer, "push", "-q", "origin", "main")
  const target = run(writer, "rev-parse", "HEAD")
  const phases: string[] = []
  const buildRoot = join(root, "build-updates")
  const builder: LocalUpdates = new LocalUpdates(git, buildRoot, "A".repeat(40), () => {
    const state = builder.snapshot().local
    if (state.kind === "building") phases.push(`${state.phase}:${state.revision?.slice(0, 8) ?? ""}`)
  }, identity(head), roomy)
  await builder.load()
  await builder.select(source)
  builder.start()
  await finished(builder)
  assert.equal(run(source, "rev-parse", "HEAD"), target, "the source was fast-forwarded")
  assert.ok(phases.includes(`compiling:${target.slice(0, 8)}`), `the build names the revision it builds: ${phases.join(", ")}`)
  const failed = builder.snapshot().local
  // The fixture has no packaging script, so packaging is where it stops.
  assert.equal(failed.kind, "error")
  if (failed.kind === "error") assert.match(failed.message, /failed during packaging/)

  // What a build brought is shown once that build runs.
  await writeFile(join(buildRoot, "build-changes.json"), JSON.stringify({ build: "d".repeat(16), changes: { from: head, count: 1, titles: ["Eighth (#8)"] } }))
  const after = new LocalUpdates(git, buildRoot, "A".repeat(40), () => {}, { ...identity(target), id: "d".repeat(16) })
  await after.load()
  assert.deepEqual(after.snapshot().installed, { from: head, count: 1, titles: ["Eighth (#8)"] })
  const stranger = new LocalUpdates(git, buildRoot, "A".repeat(40), () => {}, { ...identity(target), id: "e".repeat(16) })
  await stranger.load()
  assert.equal(stranger.snapshot().installed, null, "another build's changes aren't claimed")

  console.log("Update source: fetches the upstream, fast-forwards a clean checkout on its tracking branch (files and index, never untracked work), builds anything else as it is with the reason, refuses stale readings, and never rebuilds the installed revision")
} finally {
  git.close()
  await rm(root, { recursive: true, force: true })
}
