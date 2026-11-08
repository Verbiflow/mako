import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import assert from "node:assert/strict"
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { uninstalledPackages } from "@mako/host/application/local-update-dependencies"
import { copyBuildSource, syncBuildCheckout, LocalUpdates, ensureBuildSpace, buildCopyBytes, PACKAGED_APP_BYTES, DISK_MARGIN_BYTES } from "@mako/host/application/local-updates"
import { testScratch } from "./lib/test-scratch.mjs"

const gitRunner = new Git()

const root = testScratch("mako-source-copy-")
try {
  const source = join(root, "source")
  const isolated = join(root, "isolated")
  await mkdir(join(source, "node_modules/@mako"), { recursive: true })
  await mkdir(join(source, "packages/sessions"), { recursive: true })
  await mkdir(join(source, "ignore"))
  await mkdir(join(source, "release"))
  await mkdir(isolated)
  await writeFile(join(source, "packages/sessions/value.txt"), "source")
  await writeFile(join(source, ".npmrc"), "minimum-release-age=10080\n")
  await writeFile(join(source, ".env"), "fixture=not-for-build\n")
  await symlink(
    "../../packages/sessions",
    join(source, "node_modules/@mako/sessions")
  )
  await copyBuildSource(source, isolated)
  assert.equal(
    await realpath(join(isolated, "node_modules/@mako/sessions")),
    await realpath(join(isolated, "packages/sessions"))
  )
  await writeFile(
    join(isolated, "node_modules/@mako/sessions/value.txt"),
    "isolated"
  )
  assert.equal(
    await readFile(join(source, "packages/sessions/value.txt"), "utf8"),
    "source"
  )
  assert.equal(
    await readFile(join(isolated, ".npmrc"), "utf8"),
    "minimum-release-age=10080\n"
  )
  for (const name of [".env", "ignore", "release"])
    await assert.rejects(realpath(join(isolated, name)), { code: "ENOENT" })

  // A workspace can be added after npm wrote its hidden lockfile. The
  // project's lockfile must invalidate the cached dependency copy too.
  const syncSource = join(root, "sync-source")
  const syncCheckout = join(root, "sync-checkout")
  await mkdir(join(syncSource, "node_modules/@mako"), { recursive: true })
  await writeFile(join(syncSource, "node_modules/.package-lock.json"), "{}")
  const lockfile = join(syncSource, "package-lock.json")
  await writeFile(lockfile, JSON.stringify({ packages: {} }))
  const beforeWorkspace = await syncBuildCheckout(syncSource, syncCheckout)
  assert.equal(await syncBuildCheckout(syncSource, syncCheckout), beforeWorkspace)
  await mkdir(join(syncSource, "packages/git"), { recursive: true })
  await writeFile(join(syncSource, "packages/git/package.json"), JSON.stringify({
    name: "@mako/git", type: "module", exports: "./index.js",
  }))
  await writeFile(join(syncSource, "packages/git/index.js"), "export const copied = true\n")
  await symlink("../../packages/git", join(syncSource, "node_modules/@mako/git"))
  await writeFile(lockfile, JSON.stringify({ packages: {
    "node_modules/@mako/git": { resolved: "packages/git", link: true },
    "node_modules/@esbuild/linux-x64": { version: "0.28.2", optional: true },
  } }))
  // Pulled, but npm install hasn't run since: the copy is taken anyway and says what it lacks, so the build installs
  // that there, never in the person's checkout.
  await syncBuildCheckout(syncSource, syncCheckout)
  assert.deepEqual(await uninstalledPackages(syncCheckout), ["@mako/git"])
  await writeFile(join(syncSource, "node_modules/.package-lock.json"), JSON.stringify({ packages: {
    "node_modules/@mako/git": { resolved: "packages/git", link: true },
  } }))
  const afterWorkspace = await syncBuildCheckout(syncSource, syncCheckout)
  assert.notEqual(afterWorkspace, beforeWorkspace)
  assert.equal(
    await realpath(join(syncCheckout, "node_modules/@mako/git")),
    await realpath(join(syncCheckout, "packages/git"))
  )
  execFileSync(process.execPath, ["--input-type=module", "--eval",
    "import assert from 'node:assert/strict'; assert.equal((await import('@mako/git')).copied, true)"],
    { cwd: syncCheckout })
  assert.equal(await syncBuildCheckout(syncSource, syncCheckout), afterWorkspace)

  await symlink(
    join(source, "packages/sessions"),
    join(source, "node_modules/escape")
  )
  const second = join(root, "second")
  await mkdir(second)
  await assert.rejects(copyBuildSource(source, second), /leaves the private/)
  const updatesRoot = join(root, "updates")
  await mkdir(updatesRoot)
  await writeFile(join(updatesRoot, "source.json"), JSON.stringify(join(root, "missing-checkout")))
  // Build directories an earlier host left behind go on the first load; the
  // receipt, the source selection, and anything not ours stay.
  await mkdir(join(updatesRoot, "build-Old1/output/mac-arm64/Mako.app"), { recursive: true })
  await writeFile(join(updatesRoot, "build-Old1/output/mac-arm64/Mako.app/stale"), "x")
  await mkdir(join(updatesRoot, "build-Old2"))
  await mkdir(join(updatesRoot, "not-a-build"))
  await symlink(join(root, "source"), join(updatesRoot, "build-Link"))
  await writeFile(join(updatesRoot, "install-result.json"), JSON.stringify({ ok: true }))
  let complete = () => {}
  const completed = new Promise<void>((resolve) => { complete = resolve })
  const updates = new LocalUpdates(gitRunner, updatesRoot, "A".repeat(40), () => { if (!updates.building && updates.snapshot().local.kind === "error") complete() })
  await updates.load()
  for (const name of ["build-Old1", "build-Old2"])
    await assert.rejects(realpath(join(updatesRoot, name)), { code: "ENOENT" })
  for (const name of ["not-a-build", "build-Link", "install-result.json", "source.json"])
    assert.ok(await realpath(join(updatesRoot, name)))
  assert.ok(await realpath(join(root, "source/packages/sessions/value.txt")), "a linked target is never followed")
  updates.start()
  await completed
  const failed = updates.snapshot().local
  assert.equal(failed.kind, "error")
  if (failed.kind === "error") assert.match(failed.message, /missing-checkout|Node.js and npm/)

  // Exercise the Settings build runner with real subprocess output, including
  // a failure after enough stdout to exceed the retained diagnostic budget.
  const checkingSource = join(root, "checking-source")
  await mkdir(checkingSource)
  await writeFile(join(checkingSource, "package.json"), JSON.stringify({
    name: "mako",
    scripts: {
      build: "node pass.cjs",
      lint: "node pass.cjs",
      "package:mac:local": "node pass.cjs",
      "test:performance": "node pass.cjs",
      "test:renderer-assets": "node pass.cjs",
      "test:application": "node fail.cjs",
    },
  }))
  await writeFile(join(checkingSource, "pass.cjs"), "process.exit(0)")
  await writeFile(join(checkingSource, "fail.cjs"), "process.stdout.write('x'.repeat(100000)); process.stderr.write('\\nAPPLICATION_FIXTURE_FAILURE: cancel button remained blocked\\n'); process.exitCode = 1")
  execFileSync("git", ["init", "-q", checkingSource])
  execFileSync("git", ["-C", checkingSource, "add", "."])
  execFileSync("git", ["-C", checkingSource, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Build fixture"])
  let finishCheck = () => {}
  const checkFinished = new Promise<void>(resolve => { finishCheck = resolve })
  const checking = new LocalUpdates(gitRunner, join(root, "checking-updates"), "A".repeat(40), () => {
    if (!checking.building && checking.snapshot().local.kind === "error") finishCheck()
  })
  await checking.select(checkingSource)
  checking.start()
  await checkFinished
  const checkFailure = checking.snapshot().local
  assert.equal(checkFailure.kind, "error")
  if (checkFailure.kind === "error") {
    assert.match(checkFailure.message, /^Checking \(test:application\) failed on the checkout at [0-9a-f]{8}\. Fix the checkout, then build again\./)
    assert.equal(checkFailure.failure?.blame, "code")
    assert.match(checkFailure.failure?.details ?? "", /APPLICATION_FIXTURE_FAILURE: cancel button remained blocked/)
    assert.ok((checkFailure.failure?.details ?? "").length <= 2000, "Build diagnostics remain bounded")
  }

  // The performance check runs alone after the others, and reads its verdicts
  // from the file it's handed: a Mac too busy to time it leaves the update
  // ready with that caveat, measured again on Retry or once the Mac is quiet;
  // a slower row is a failure that names it.
  const timedSource = join(root, "timed-source")
  const order = join(root, "timed-order.log")
  const mode = join(root, "timed-mode.txt")
  await mkdir(timedSource)
  await writeFile(join(timedSource, "package.json"), JSON.stringify({
    name: "mako",
    scripts: {
      build: "node pass.cjs",
      lint: "node pass.cjs",
      "package:mac:local": "node pass.cjs",
      "test:application": "node check.cjs application",
      "test:renderer-assets": "node check.cjs renderer",
      "test:performance": "node performance.cjs",
    },
  }))
  await writeFile(join(timedSource, "pass.cjs"), "process.exit(0)")
  await writeFile(join(timedSource, "check.cjs"), `const fs = require("fs")
fs.appendFileSync(${JSON.stringify(order)}, process.argv[2] + " start\\n")
setTimeout(() => fs.appendFileSync(${JSON.stringify(order)}, process.argv[2] + " end\\n"), 300)`)
  await writeFile(join(timedSource, "performance.cjs"), `const fs = require("fs")
fs.appendFileSync(${JSON.stringify(order)}, "performance\\n")
const mode = fs.readFileSync(${JSON.stringify(mode)}, "utf8").trim()
const row = { key: "merge/merge large (same)", beside: "3c2c7d6d".padEnd(40, "0"), outcome: mode, reference: 0.476, head: 0.681, change: mode === "slower" ? 1.6 : 1.43, interval: mode === "slower" ? [1.4, 1.8] : [0.96, 1.71], rounds: 15, busyShare: mode === "unsure" ? 0.8 : 0 }
const busy = mode === "unsure" ? ["other work kept 12.6 of 14 cores busy"] : []
fs.appendFileSync(process.env.MAKO_PERFORMANCE_VERDICT, JSON.stringify({ script: "perf:decoders", allowed: 1.25, rows: [row], machine: "other work 12.6 of 14 cores, load average 26.7, memory normal", busy }) + "\\n")
if (mode === "slower") { process.stderr.write("Rows that failed against the baseline (25% slower allowed)\\n"); process.exitCode = 1 }`)
  execFileSync("git", ["init", "-q", timedSource])
  execFileSync("git", ["-C", timedSource, "add", "."])
  execFileSync("git", ["-C", timedSource, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "Timed fixture"])
  const candidate = {
    async package(_checkout: string, output: string) {
      await mkdir(join(output, "mac-arm64/Mako.app"), { recursive: true })
    },
    async verify() {
      return { id: "c".repeat(16), builtAt: new Date().toISOString(), revision: null, dirty: false }
    },
  }
  let quietMac = false
  const reading = (othersBusy: number) => ({ cores: 14, othersBusy, loadAverage: othersBusy, memory: "normal" as const, thermal: "nominal" as const })
  const timedRoot = join(root, "timed-updates")
  // An updater from before the private copy was named for Spotlight to skip.
  await mkdir(join(timedRoot, "checkout"), { recursive: true })
  const seen: string[] = []
  const timed: LocalUpdates = new LocalUpdates(gitRunner, timedRoot, "A".repeat(40), () => {
    const local = timed.snapshot().local
    seen.push(local.kind === "building" ? `${local.phase}${local.remeasuring ? " again" : ""}` : local.kind === "ready" && local.performance ? "ready, unsure" : local.kind)
  }, null, { candidate, machine: async () => reading(quietMac ? 1 : 12.6), quietEveryMs: 10 })
  const settled = async (what: string) => {
    const deadline = Date.now() + 60_000
    while (timed.building || timed.snapshot().local.kind === "building") {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}: ${seen.join(", ")}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    return timed.snapshot().local
  }
  const runs = async () => (await readFile(order, "utf8")).split("\n").filter((line) => line === "performance").length
  await writeFile(mode, "unsure")
  await timed.select(timedSource)
  timed.start()
  const unsure = await settled("a build on a busy Mac")
  assert.equal(unsure.kind, "ready", `a Mac too busy to measure leaves the update ready: ${JSON.stringify(unsure)}`)
  if (unsure.kind === "ready") {
    assert.deepEqual(unsure.performance?.rows, ["merge/merge large (same): +43% beside 3c2c7d6d, between −4% and +71%, 15 rounds, 12 busy"])
    assert.deepEqual(unsure.performance?.busy, ["other work kept 12.6 of 14 cores busy"])
    assert.equal(unsure.performance?.machine, "other work 12.6 of 14 cores, load average 26.7, memory normal")
  }
  const steps = (await readFile(order, "utf8")).trim().split("\n")
  assert.deepEqual(steps.slice(-1), ["performance"])
  assert.deepEqual(new Set(steps.slice(0, 4)), new Set(["application start", "renderer start", "application end", "renderer end"]), "the other checks finish before the performance check starts")
  const names = await readdir(timedRoot)
  assert.ok(names.includes("checkout.noindex") && !names.includes("checkout"), `the private copy moves to a folder Spotlight skips: ${names.join(", ")}`)

  // Retry measures again without rebuilding; still busy, still unsure.
  timed.measureAgain()
  assert.deepEqual(seen.at(-1), "checking again")
  const retried = await settled("Retry on a busy Mac")
  assert.ok(retried.kind === "ready" && retried.performance, "still busy, still unsure")
  assert.equal(await runs(), 2)
  assert.ok(!(await readFile(order, "utf8")).split("\n").slice(4).some((line) => line.startsWith("application")), "measuring again rebuilds and rechecks nothing else")

  // A row measured again slower fails, naming it.
  await writeFile(mode, "slower")
  timed.measureAgain()
  const slowerAgain = await settled("Retry that measures slower")
  assert.equal(slowerAgain.kind, "error")
  if (slowerAgain.kind === "error") {
    assert.match(slowerAgain.message, /^The performance check found a timing clearly slower than the code before it, measured beside it on this Mac: merge\/merge large \(same\): \+60% beside 3c2c7d6d, between \+40% and \+80%, 15 rounds, 0 busy\. That's the code, not the Mac/)
    assert.equal(slowerAgain.failure?.blame, "code")
    assert.match(slowerAgain.failure?.details ?? "", /Rows that failed against the baseline \(25% slower allowed\)/)
  }

  // Built again on a busy Mac, it waits; an install pending holds it; once
  // the Mac reads quiet three times running, it measures again by itself.
  await writeFile(mode, "unsure")
  timed.start()
  assert.equal((await settled("a rebuild on a busy Mac")).kind, "ready")
  assert.equal(await runs(), 4, "an unsure build is built and measured again, not handed back")
  await writeFile(mode, "within")
  timed.hold(true)
  quietMac = true
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(await runs(), 4, "a pending install keeps the update as it is")
  timed.hold(false)
  const deadline = Date.now() + 30_000
  const measuredWithin = () => {
    const local = timed.snapshot().local
    return local.kind === "ready" && !local.performance
  }
  while (!measuredWithin()) {
    if (Date.now() > deadline) throw new Error(`The quiet Mac never measured again: ${seen.join(", ")}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.equal(await runs(), 5)
  assert.ok(seen.includes("checking again"))
  assert.ok(timed.ready, "measured within, it installs as any other")

  // A build whose own check is slower fails during checking, naming the row.
  await writeFile(mode, "slower")
  const slowRoot = join(root, "slow-updates")
  let finishSlow = () => {}
  const slowFinished = new Promise<void>((resolve) => { finishSlow = resolve })
  const slow: LocalUpdates = new LocalUpdates(gitRunner, slowRoot, "A".repeat(40), () => {
    if (!slow.building && slow.snapshot().local.kind === "error") finishSlow()
  }, null, { candidate })
  await slow.select(timedSource)
  slow.start()
  await slowFinished
  const slower = slow.snapshot().local
  assert.equal(slower.kind, "error")
  if (slower.kind === "error") {
    assert.equal(slower.failure?.step, "checking")
    assert.match(slower.message, /^The performance check found a timing clearly slower than the code before it, measured beside it on this Mac: merge\/merge large \(same\): \+60%/)
  }

  // The disk guard refuses below what the copy, a packaged app and the margin
  // need, says both numbers, and runs before anything is copied.
  const disk = (free: number) => async () => ({ bavail: free, bsize: 1 })
  const copied = 3e9
  const needed = copied + PACKAGED_APP_BYTES + DISK_MARGIN_BYTES
  assert.deepEqual(await ensureBuildSpace(root, copied, disk(needed)), { needed, free: needed })
  await assert.rejects(ensureBuildSpace(root, copied, disk(needed - 1)), (error: Error) => {
    assert.match(error.message, /needs about 9\.0 GB free on the disk holding .* and 9\.0 GB is free\. Nothing was copied or built/)
    return true
  })
  await assert.rejects(ensureBuildSpace(root, 0, disk(2e9)), /needs about 6\.0 GB free .* and 2\.0 GB is free/)
  const sizes = await Promise.all(["package.json", "pass.cjs", "fail.cjs"].map(async (name) => (await stat(join(checkingSource, name))).size))
  assert.equal(await buildCopyBytes(checkingSource), sizes.reduce((sum, size) => sum + size, 0), "the copy estimate counts what the sync copies, not .git")
  const fullRoot = join(root, "full-disk-updates")
  let finishFull = () => {}
  const fullFinished = new Promise<void>(resolve => { finishFull = resolve })
  const full = new LocalUpdates(gitRunner, fullRoot, "A".repeat(40), () => {
    if (!full.building && full.snapshot().local.kind === "error") finishFull()
  }, null, { statfs: disk(1e9) })
  await full.select(checkingSource)
  full.start()
  await fullFinished
  const refused = full.snapshot().local
  assert.equal(refused.kind, "error")
  if (refused.kind === "error") assert.match(refused.message, /Not enough free disk space to build Mako: it needs about .* and 1\.0 GB is free/)
  for (const name of await readdir(fullRoot)) assert.ok(!/^(checkout|build-)/.test(name), `nothing was copied before the refusal: ${name}`)

  // A failed in-app install followed by a newer build installed elsewhere
  // (the CLI never writes this receipt) must not keep reporting the old failure.
  const receipts = join(root, "receipt-updates")
  await mkdir(receipts)
  await writeFile(join(receipts, "install-result.json"), JSON.stringify({ ok: false, message: "Mako processes are still running" }))
  const failedAt = new Date(Date.now() - 60_000)
  await utimes(join(receipts, "install-result.json"), failedAt, failedAt)
  const build = (builtAt: Date) => ({ id: "a".repeat(16), builtAt: builtAt.toISOString(), revision: null, dirty: false })
  const newer = new LocalUpdates(gitRunner, receipts, "A".repeat(40), () => {}, build(new Date(failedAt.getTime() + 1000)))
  await newer.load()
  assert.equal(newer.snapshot().local.kind, "idle", "A receipt older than the running build is superseded")
  const same = new LocalUpdates(gitRunner, receipts, "A".repeat(40), () => {}, build(new Date(failedAt.getTime() - 1000)))
  await same.load()
  assert.equal(same.snapshot().local.kind, "error", "A failure after the running build was built still applies")
  console.log("Local build copies preserve workspace links and security configuration, isolate writes, exclude generated data, reject escaping links, prune earlier build directories, time performance alone after the other checks (a busy Mac leaves it ready to measure again, a slower row fails by name), refuse a build the disk can't hold, report the real preparation error and ignore superseded install receipts")
} finally {
  await rm(root, { recursive: true, force: true })
}
