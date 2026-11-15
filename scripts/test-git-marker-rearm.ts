import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { promisify } from "node:util"
import { watchGitMarkers } from "@mako/host/workspaces/git-dir-watch"

import { watchGitMarkersHere } from "@mako/host/workspaces/git-marker-native"

const root = fs.mkdtempSync(join(tmpdir(), "mako-ref-rearm-"))
let watching: { ready: Promise<void>; close(): void | Promise<void> } | undefined
try {
  const target = join(root, "prefix")
  const callbacks: (() => void)[] = []
  let appeared = false, changes = 0
  mock.method(fs, "watch", (_path: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
    callbacks.push(() => listener("rename", "prefix"))
    return Object.assign(new EventEmitter(), {
      close() { if (!appeared) { appeared = true; fs.mkdirSync(target) } },
      ref() { return this }, unref() { return this }, [Symbol.dispose]() { this.close() },
    })
  })
  syncBuiltinESMExports()
  watching = watchGitMarkersHere(root, () => changes++, ["prefix"])
  // The callback's stamp is still missing. Closing the parent watch makes it appear before arm's stamp.
  callbacks[0]!()
  assert.equal(changes, 1, "appearance between the callback and rearm stamps must be announced")
  callbacks[1]!()
  assert.equal(changes, 1, "the same unchanged path is not announced twice")
  await watching.close(); watching = undefined
  mock.restoreAll(); syncBuiltinESMExports()

  const run = promisify(execFile)
  const git = (...args: string[]) => run("git", args, { cwd: root })
  await git("init", "-q", "-b", "main")
  await git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "Fixture", "--allow-empty")
  await git("init", "-q", "--bare", join(root, "origin.git"))
  await git("remote", "add", "origin", join(root, "origin.git"))
  let pushes = 0
  watching = watchGitMarkers(join(root, ".git"), () => pushes++, ["refs/remotes/origin/new/prefix"])
  await watching.ready
  await git("push", "-q", "origin", "HEAD:refs/heads/new/prefix/fixture")
  for (const deadline = performance.now() + 10_000; !pushes; await new Promise(resolve => setTimeout(resolve, 25))) {
    if (performance.now() > deadline) throw new Error("First push to a missing remote prefix was not heard")
  }
  await watching.close(); watching = undefined
  // Native Git watches were persistent:false: readiness is joined, then they never hold a reader CLI open.
  const probe = join(root, "nonpersistent.mts")
  const entry = new URL("../packages/host/src/workspaces/git-dir-watch.ts", import.meta.url).href
  fs.writeFileSync(probe, `import assert from "node:assert/strict";
import { watchGitMarkers } from ${JSON.stringify(entry)};
const processes = () => process.getActiveResourcesInfo().filter(kind => kind === "ProcessWrap").length;
const before = processes();
const watch = watchGitMarkers(${JSON.stringify(join(root, ".git"))}, () => {}, ["HEAD"]);
await watch.ready;
assert.equal(processes(), before, "a non-persistent marker unrefs its child after readiness");
console.log("ready without a process hold");
`)
  const exited = await run(process.execPath, ["--import", "tsx", probe], { cwd: process.cwd(), timeout: 5_000 })
  assert.match(exited.stdout, /ready without a process hold/)
  const { Git } = await import("@mako/git")
  const { ThreadStore } = await import("@mako/host/threads/store")
  const { ThreadWorktreeService } = await import("@mako/host/workspaces/thread-worktrees")
  const runner = new Git(), store = new ThreadStore(join(root, "summary.sqlite"))
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const opening = Promise.withResolvers<import("@mako/host/workspaces/watch-backend").WatchSubscription>()
  let starts = 0, releases = 0, closed = false
  const service = new ThreadWorktreeService(runner, join(root, "summary-owner"), store,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => { starts++; entered.resolve(); return opening.promise })
  const thread = store.registerJournal({ conversationId: "a0000000-0000-4000-8000-000000000001", createdAt: Date.now(), harness: "codex", bindings: [] }, { kind: "service", name: "migration" }).thread
  const head = (await git("rev-parse", "HEAD")).stdout.trim()
  store.attachWorktree({ path: root, thread, repoRoot: root, project: root, branch: "main", base: head })
  const reading = service.summaries()
  try {
    await Promise.race([entered.promise, reading.then(() => { throw new Error("summary returned without subscribing") })])
    const beforeClose = starts
    const close = service.closeSummaries()
    assert.equal(service.closeSummaries(), close)
    void close.then(() => { closed = true })
    opening.resolve({ unsubscribe: () => { releases++; return release.promise } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(releases, beforeClose); assert.equal(closed, false, "summary close joins its late subscription release")
    release.resolve(); await close; await reading
    assert.equal(starts, beforeClose, "closing while ready prevents every remaining marker watch from starting")
  } finally {
    opening.resolve({ unsubscribe: async () => {} }); release.resolve()
    await service.closeSummaries(); await reading.catch(() => {}); store.close(); await runner.close()
  }
  const { childBackend } = await import("@mako/host/workspaces/watch-backend")
  const { HostStopping } = await import("@mako/host/base/host-stopping")
  const wedge = join(root, "summary-wedge.ts")
  fs.writeFileSync(wedge, 'process.on("message", () => {}); process.on("disconnect", () => process.exit());\n')
  const scope = new HostStopping(), wedged = scope.run(() => childBackend(wedge))
  const secondRunner = new Git(), secondStore = new ThreadStore(join(root, "summary.sqlite"))
  let asked = 0, askedAtFirstSettlement: number | undefined, timedOutPulls = 0
  const port: import("@mako/host/workspaces/watch-backend").WatchBackend = (...args) => {
    asked++
    return scope.run(() => wedged(...args)).finally(() => { askedAtFirstSettlement ??= asked })
  }
  const bounded = new ThreadWorktreeService(secondRunner, join(root, "summary-wedged-owner"), secondStore,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => { timedOutPulls++ }, port)
  try {
    const rows = await bounded.summaries()
    assert.equal(rows.length, 1, "a wedged watcher cannot prevent the actual summary API from answering")
    assert.equal(asked, 2, "both independent shared local and remote watches were asked for")
    assert.equal(askedAtFirstSettlement, undefined, "summary readiness stops waiting while the late subscriptions stay owned")
    assert.equal(timedOutPulls, 1, "the readiness timeout invalidates the unobserved remote-ref PR list")
    await scope.stop()
    assert.equal(askedAtFirstSettlement, 2, "both watches were armed before either subscription settled")
    await bounded.closeSummaries()
  } finally {
    await bounded.closeSummaries()
    await scope.stop()
    secondStore.close(); await secondRunner.close()
  }
  const thirdRunner = new Git(), thirdStore = new ThreadStore(join(root, "summary.sqlite"))
  const streams: { listener: import("@mako/host/workspaces/watch-backend").WatchListener; remote: boolean; releases: number }[] = []
  let invalidations = 0
  const terminal = new ThreadWorktreeService(thirdRunner, join(root, "summary-terminal-owner"), thirdStore,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => { invalidations++ },
    async (_root, _ignore, listener, native) => {
      const stream = { listener, remote: native?.kind === "git-markers" && native.markers.includes("FETCH_HEAD"), releases: 0 }
      streams.push(stream)
      return { unsubscribe: async () => { stream.releases++ } }
    })
  try {
    await terminal.summaries()
    const remote = streams.find(stream => stream.remote)!
    const before = streams.length
    remote.listener.gone()
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(remote.releases, 1, "a lost re-ready retires its dead proxy")
    assert.equal(invalidations, 1, "losing remote markers invalidates the PR list too")
    await terminal.summaries()
    assert.equal(streams.length, before + 1, "the next pass rearms only the lost subscription")
    const fresh = streams.at(-1)!
    remote.listener.gone(); remote.listener.events([])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(invalidations, 1, "late events from the lost proxy cannot invalidate its replacement")
    fresh.listener.events([])
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(invalidations, 2, "the replacement still follows remote refs")
    await terminal.closeSummaries()
    assert.ok(streams.every(stream => stream.releases === 1), "every acquired proxy is released once")
  } finally {
    await terminal.closeSummaries(); await terminal.settled(); thirdStore.close(); await thirdRunner.close()
  }
  console.log("Git markers: rearm, remote push, non-persistent lifetime, late close and bounded parallel summaries passed")
} finally {
  await watching?.close(); mock.restoreAll(); syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
