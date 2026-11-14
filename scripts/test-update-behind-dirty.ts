import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { z } from "zod"
import { Git } from "@mako/git"
import type { CiReading } from "@mako/host/application/local-update-ci"
import { LocalUpdates } from "@mako/host/application/local-updates"
import { UPDATE_CHECKS } from "@mako/host/application/local-update-checks"
import type { LocalBuildState } from "@mako/host/contracts/app-lifecycle"
import { updateSourceText } from "@mako/host/contracts/update-source-text"

/**
 * The update the person asked for on 2026-11-04, end to end: their checkout
 * 2 commits behind `origin/main`, with another session's uncommitted files,
 * its own code carrying a test that fails only in the updater's environment
 * (`concluded()`'s default took the updater's verdict file, fixed upstream).
 * Settings › Updates built that old code three times and failed each time.
 *
 * Against real repositories, Settings' own `LocalUpdates`:
 *   - the reading says what each build takes before anything builds: where
 *     from, which commit, how far behind, every uncommitted file and who
 *     changed it;
 *   - Build, unchosen, builds the upstream's commit in Mako's own clean copy,
 *     passes, and leaves the person's checkout exactly as it was: HEAD, branch,
 *     index, every file's bytes and times, the stash;
 *   - the checks are `UPDATE_CHECKS`, in order, the verdict variable seen by
 *     the performance check alone;
 *   - building the checkout as it is, chosen, fails on its old test, and the
 *     failure says so plainly: the checks, the checkout's code, and to build
 *     the upstream instead;
 *   - a check that runs the Mac out of file handles is the Mac's, said so.
 */

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-behind-dirty-")))
const globalConfig = join(root, "gitconfig")
await writeFile(globalConfig, "")
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
const log = join(root, "checks.jsonl")
const roomy = { statfs: async () => ({ bavail: 1e12, bsize: 1 }) }
const candidate = {
  async package(_checkout: string, output: string) {
    await mkdir(join(output, "mac-arm64/Mako.app"), { recursive: true })
  },
  async verify() {
    return { id: "c".repeat(16), builtAt: new Date().toISOString(), revision: null, dirty: false }
  },
}

/** Each check records where it ran, what it saw of the tree, and the updater's variables. */
const recorder = `const fs = require("fs"), path = require("path")
const script = process.argv[2]
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  script, cwd: process.cwd(),
  app: fs.readFileSync("app.txt", "utf8").trim(),
  draft: fs.existsSync("draft.md"),
  verdict: process.env.MAKO_PERFORMANCE_VERDICT ?? null,
  allowed: process.env.MAKO_PERFORMANCE_ALLOWED ?? null,
  revision: process.env.MAKO_BUILD_REVISION ?? null,
  dirty: process.env.MAKO_BUILD_DIRTY ?? null,
  source: process.env.MAKO_BUILD_SOURCE ?? null,
  changed: process.env.MAKO_UPDATE_CHANGED ? fs.readFileSync(process.env.MAKO_UPDATE_CHANGED, "utf8").split("\\n").filter(Boolean) : null,
}) + "\\n")
if (fs.existsSync(${JSON.stringify(join(root, "emfile"))}) && fs.readFileSync(${JSON.stringify(join(root, "emfile"))}, "utf8") === script) { process.stderr.write("Error: EMFILE: too many open files, open 'dist/index.js'\\n"); process.exit(1) }
`
/** The bug: the performance check's own test, which fails whenever the updater's verdict file is named. */
const oldPerformance = `require("./record.cjs")
if (process.env.MAKO_PERFORMANCE_VERDICT) {
  process.stderr.write("AssertionError [ERR_ASSERTION]: with nobody to choose, unsure fails\\n    at scripts/test-perf-reference.ts:141\\n")
  process.exit(1)
}
`
const scripts = (performance: Record<string, string>) => JSON.stringify({
  name: "mako",
  scripts: {
    build: "node record.cjs build",
    "test:application": "node record.cjs test:application",
    "test:renderer-assets": "node record.cjs test:renderer-assets",
    "package:mac:local": "node -e 0",
    "test:performance": "node performance.cjs test:performance",
    ...performance,
  },
}, null, 2)

/** Everything in the checkout a build could touch: every file's bytes and times, and Git's view of it. */
function snapshot(checkout: string) {
  const files: string[] = []
  const visit = (folder: string) => {
    for (const name of readdirSync(folder)) {
      const path = join(folder, name)
      if (name === ".git") continue
      const info = statSync(path)
      if (info.isDirectory()) visit(path)
      else files.push(`${relative(checkout, path)} ${info.size} ${info.mtimeMs} ${createHash("sha256").update(readFileSync(path)).digest("hex")}`)
    }
  }
  visit(checkout)
  const index = statSync(join(checkout, ".git/index"))
  return {
    files: files.sort(),
    head: run(checkout, "rev-parse", "HEAD"),
    branch: run(checkout, "symbolic-ref", "--short", "HEAD"),
    // Read without refreshing the index, as the updater reads it: a plain status rewrites the index's stat cache.
    status: run(checkout, "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"),
    index: `${index.size} ${index.mtimeMs} ${createHash("sha256").update(readFileSync(join(checkout, ".git/index"))).digest("hex")}`,
    stash: run(checkout, "stash", "list"),
    worktrees: run(checkout, "worktree", "list", "--porcelain"),
  }
}

const settled = async (updates: LocalUpdates): Promise<LocalBuildState> => {
  const deadline = Date.now() + 60_000
  while (updates.building) {
    if (Date.now() > deadline) throw new Error("the build never finished")
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return updates.snapshot().local
}
const CheckSchema = z.object({
  script: z.string(),
  cwd: z.string(),
  app: z.string(),
  draft: z.boolean(),
  verdict: z.string().nullable(),
  allowed: z.string().nullable(),
  revision: z.string().nullable(),
  dirty: z.string().nullable(),
  source: z.string().nullable(),
  changed: z.array(z.string()).nullable(),
})
const checksRun = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => CheckSchema.parse(JSON.parse(line)))

try {
  const remote = join(root, "remote.git")
  const writer = join(root, "writer")
  const person = join(root, "person")
  run(root, "init", "-q", "--bare", "-b", "main", remote)
  run(root, "clone", "-q", remote, writer)
  run(writer, "checkout", "-q", "-b", "main")
  await writeFile(join(writer, "record.cjs"), recorder)
  await writeFile(join(writer, "performance.cjs"), oldPerformance)
  await writeFile(join(writer, "app.txt"), "old\n")
  await writeFile(join(writer, "package.json"), scripts({}))
  run(writer, "add", ".")
  run(writer, "commit", "-qm", "Busy Macs no longer fail an update (#304)")
  run(writer, "push", "-q", "origin", "main")
  run(root, "clone", "-q", remote, person)
  const old = run(person, "rev-parse", "HEAD")

  // Upstream moves on: the test is fixed and the update gets its own performance check.
  await writeFile(join(writer, "performance.cjs"), `require("./record.cjs")\n`)
  run(writer, "commit", "-qam", "The performance check passes its own test (#363)")
  await writeFile(join(writer, "app.txt"), "new\n")
  await writeFile(join(writer, "package.json"), scripts({ [UPDATE_CHECKS.performance]: `node performance.cjs ${UPDATE_CHECKS.performance}` }))
  run(writer, "commit", "-qam", "An update checks only what protects the install (#364)")
  run(writer, "push", "-q", "origin", "main")
  const upstream = run(writer, "rev-parse", "HEAD")

  // Another session's work in the person's checkout: an edit and a new file.
  await writeFile(join(person, "app.txt"), "half-done edit\n")
  await writeFile(join(person, "draft.md"), "notes\n")
  const before = snapshot(person)

  const updatesRoot = join(root, "updates")
  const writers = (paths: string[]) => Object.fromEntries(paths.map((path) => [path, path.endsWith("app.txt") ? ["Speed up the Git runner"] : ["you"]]))
  const installed = { id: "a".repeat(16), builtAt: new Date(Date.now() - 86_400_000).toISOString(), revision: old, dirty: false }
  const updates = new LocalUpdates(git, updatesRoot, "A".repeat(40), () => {}, installed, { ...roomy, candidate, writers })
  await updates.load()
  await updates.select(person)
  const reading = await updates.check({ fetch: true, force: true })

  // What it will build, said before it builds.
  assert.ok(reading?.kind === "checkout")
  assert.deepEqual(reading.plan, { recommended: "upstream", upstream: { installed: false }, checkout: { standing: "behind", installed: false } })
  assert.equal(reading.behind, 2)
  assert.equal(reading.target, upstream)
  assert.deepEqual(reading.uncommitted, { count: 2, files: [{ path: "app.txt", change: "edited", by: ["Speed up the Git runner"] }, { path: "draft.md", change: "untracked", by: ["you"] }] })
  const text = updateSourceText(reading)
  assert.equal(text.title, "2 new changes on origin/main")
  assert.equal(text.action, `Update to origin/main ${upstream.slice(0, 8)} (2 new changes)`)
  assert.equal(text.from, "upstream")
  assert.deepEqual(text.alternative, { label: `Build main ${old.slice(0, 8)} with 2 uncommitted changes`, from: "checkout" })
  assert.equal(text.standing, `main at ${old.slice(0, 8)} · origin/main at ${upstream.slice(0, 8)}`)
  assert.equal(text.detail, `Mako builds origin/main at ${upstream.slice(0, 8)} in a clean copy of its own and leaves your checkout exactly as it is. main is 2 commits behind origin/main, and it has uncommitted changes in 1 file and 1 untracked file, changed by “Speed up the Git runner” and you, that this build leaves out.`)

  // Build, unchosen: the upstream, clean, and the person's checkout untouched.
  updates.start()
  const ready = await settled(updates)
  assert.equal(ready.kind, "ready", JSON.stringify(ready))
  if (ready.kind !== "ready") throw new Error("unreachable")
  assert.equal(ready.from, "upstream")
  assert.ok(ready.took && ready.took.ms >= 0, "the build is timed")
  assert.deepEqual(Object.keys(ready.took.steps).sort(), ["checking", "compiling", "copying", "packaging", "verifying"], "and each step")
  const after = snapshot(person)
  assert.deepEqual(after, before, "the person's checkout is exactly as it was")
  const ran = await checksRun()
  assert.deepEqual(ran.map((check) => check.script).slice(0, 1), [UPDATE_CHECKS.compile])
  assert.deepEqual(new Set(ran.slice(1, 3).map((check) => check.script)), new Set(UPDATE_CHECKS.checks))
  assert.deepEqual(ran.slice(3).map((check) => check.script), [UPDATE_CHECKS.performance], "the update's own performance check, last and alone")
  const copy = join(updatesRoot, "upstream.noindex")
  for (const check of ran) {
    assert.equal(check.cwd, copy, "every check ran in Mako's clean copy")
    assert.equal(check.app, "new", "on the upstream's code")
    assert.equal(check.draft, false, "with none of the checkout's uncommitted files")
    assert.equal(check.revision, upstream)
    assert.equal(check.dirty, "0")
    assert.equal(check.source, person, "a reference is exported from the checkout's history")
    assert.deepEqual(check.changed, ["app.txt", "package.json", "performance.cjs"], "the files the build differs in from the installed app")
    assert.equal(check.verdict !== null, check.script === UPDATE_CHECKS.performance, "only the performance check is handed the verdict file")
    assert.equal(check.allowed !== null, check.script === UPDATE_CHECKS.performance, "and the updater's gross line")
  }
  assert.ok(!existsSync(join(copy, "draft.md")))

  // The checkout as it is, chosen: its old test fails, and the failure says whose and what next.
  await rm(log, { force: true })
  updates.start("checkout")
  const failed = await settled(updates)
  assert.equal(failed.kind, "error")
  if (failed.kind !== "error") throw new Error("unreachable")
  assert.equal(failed.failure?.step, "checking")
  assert.equal(failed.failure?.blame, "code")
  assert.equal(failed.failure?.what, `Checking (test:performance) failed on the checkout at ${old.slice(0, 8)} with 2 uncommitted files.`)
  assert.equal(failed.failure?.next, "Build origin/main instead: it doesn't take the checkout's own changes. Or fix the checkout and build again.")
  assert.match(failed.failure?.details ?? "", /with nobody to choose, unsure fails/)
  assert.equal(failed.message, `${failed.failure?.what} ${failed.failure?.next} Your installed app and agents were not changed.`)
  const asIs = await checksRun()
  assert.ok(asIs.every((check) => check.app === "half-done edit" && check.draft === true), "the checkout as it is carries its uncommitted files")
  assert.deepEqual(snapshot(person), before, "and is still exactly as it was")

  // The Mac, not the code: a compile that runs out of file handles.
  await writeFile(join(root, "emfile"), UPDATE_CHECKS.compile)
  updates.start()
  const machine = await settled(updates)
  await rm(join(root, "emfile"))
  assert.equal(machine.kind, "error")
  if (machine.kind === "error") {
    assert.equal(machine.failure?.blame, "machine")
    assert.equal(machine.failure?.what, "Compiling failed: the Mac ran out of open files.")
    assert.equal(machine.failure?.next, "This is the Mac, not the code. Wait for agents and builds to finish, then build again.")
  }
  assert.deepEqual(snapshot(person), before)

  // What CI vouches for. Each build is a new updater's, as an identical one is handed back without building.
  let builds = 0
  const buildWith = async (reading: CiReading, from?: "upstream" | "checkout", checkout = person) => {
    const asked: string[] = []
    const fresh = new LocalUpdates(git, join(root, `ci-${(builds += 1)}`), "A".repeat(40), () => {}, installed, { ...roomy, candidate, writers, ciPassed: async (commit) => {
      asked.push(commit)
      return reading
    } })
    await fresh.load()
    await fresh.select(checkout)
    await rm(log, { force: true })
    fresh.start(from)
    return { state: await settled(fresh), asked, ran: (await checksRun()).map((check) => check.script).sort() }
  }
  const passed = { passed: true, run: "https://example.invalid/run" } as const
  const everything = [UPDATE_CHECKS.compile, ...UPDATE_CHECKS.checks, UPDATE_CHECKS.performance].sort()

  // A commit from before the machine checks has nothing lighter to run, whatever CI says: CI isn't even asked.
  const beforeThem = await buildWith(passed, "upstream")
  assert.equal(beforeThem.state.kind, "ready")
  assert.deepEqual(beforeThem.asked, [])
  assert.deepEqual(beforeThem.ran, everything, "a commit from before the machine checks runs every check")

  await writeFile(join(writer, "package.json"), scripts({
    [UPDATE_CHECKS.performance]: `node performance.cjs ${UPDATE_CHECKS.performance}`,
    [UPDATE_CHECKS.machine]: `node record.cjs ${UPDATE_CHECKS.machine}`,
  }))
  run(writer, "commit", "-qam", "The machine checks")
  run(writer, "push", "-q", "origin", "main")
  const vouchable = run(writer, "rev-parse", "HEAD")

  const green = await buildWith(passed, "upstream")
  assert.equal(green.state.kind, "ready")
  assert.deepEqual(green.asked, [vouchable], "CI is asked of the very commit it builds")
  assert.deepEqual(green.ran, [UPDATE_CHECKS.compile, UPDATE_CHECKS.machine].sort(), "a commit CI passed compiles and runs what only this Mac can tell")

  const unvouched = await buildWith({ passed: false, why: "no green run" }, "upstream")
  assert.equal(unvouched.state.kind, "ready")
  assert.deepEqual(unvouched.ran, everything, "a commit CI hasn't passed runs every check")

  // The working tree, as it is: CI passed nothing of it, so it isn't asked, whatever it would say. A checkout with the
  // machine checks, on the very commit CI passed, so its local changes are all that stands in the way.
  const local = join(root, "local")
  run(root, "clone", "-q", remote, local)
  await writeFile(join(local, "app.txt"), "a local edit\n")
  const dirty = await buildWith(passed, "checkout", local)
  assert.deepEqual(dirty.asked, [], "a build with local changes never asks CI")
  assert.deepEqual(dirty.ran, everything, "and runs every check")
  run(local, "checkout", "--", "app.txt")
  const clean = await buildWith(passed, "checkout", local)
  assert.deepEqual(clean.asked, [], "nor does the checkout as it is with none: only an upstream build is CI's commit, clean")
  assert.deepEqual(clean.ran, everything)

  // A machine check failing a commit CI passed: it blocks the update, and says where to look without claiming whose it is.
  await writeFile(join(root, "emfile"), UPDATE_CHECKS.machine)
  const mine = await buildWith(passed, "upstream")
  await rm(join(root, "emfile"))
  assert.equal(mine.state.kind, "error")
  if (mine.state.kind === "error") assert.match(mine.state.failure?.next ?? "", /what's different on this one/)
  assert.deepEqual(snapshot(person), before)

  console.log("Behind and dirty: the update says what it builds (upstream commit, how far behind, each uncommitted file and who changed it), builds the upstream clean in its own copy by default with the person's checkout byte-for-byte untouched, runs UPDATE_CHECKS in order with the verdict variable seen by the performance check alone, and says plainly when the checkout's own code fails (build the upstream instead) or the Mac does")
} finally {
  git.close()
  await rm(root, { recursive: true, force: true })
}
