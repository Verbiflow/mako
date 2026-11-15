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
    const close = service.closeSummaries()
    assert.equal(service.closeSummaries(), close)
    void close.then(() => { closed = true })
    opening.resolve({ unsubscribe: () => { releases++; return release.promise } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(releases, 1); assert.equal(closed, false, "summary close joins its late subscription release")
    release.resolve(); await close; await reading
    assert.equal(starts, 1, "closing while ready prevents every remaining marker watch from starting")
  } finally {
    opening.resolve({ unsubscribe: async () => {} }); release.resolve()
    await service.closeSummaries(); await reading.catch(() => {}); store.close(); await runner.close()
  }
  console.log("Git markers: rearm, remote push, non-persistent lifetime and late summary close passed")
} finally {
  await watching?.close(); mock.restoreAll(); syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
