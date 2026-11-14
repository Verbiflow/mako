import { z } from "zod"
import assert from "node:assert/strict"
import {
  MAX_UI_EXTENSIONS,
  MAX_UI_EXTENSION_BYTES,
  uiExtensionName,
  validateUiExtensionWrite,
} from "@mako/host/tools/plugin-policy"

assert.equal(uiExtensionName("../../hello world"), "hello-world")
assert.equal(validateUiExtensionWrite("hello", "export {}", []), "hello")
assert.equal(
  validateUiExtensionWrite(
    "existing",
    "export {}",
    Array.from({ length: MAX_UI_EXTENSIONS }, (_, index) =>
      index === 0 ? "existing" : `extension-${index}`
    )
  ),
  "existing"
)
assert.throws(
  () =>
    validateUiExtensionWrite(
      "new",
      "export {}",
      Array.from(
        { length: MAX_UI_EXTENSIONS },
        (_, index) => `extension-${index}`
      )
    ),
  /at most 64/
)
assert.throws(
  () =>
    validateUiExtensionWrite(
      "large",
      "x".repeat(MAX_UI_EXTENSION_BYTES + 1),
      []
    ),
  /cannot exceed 512 KB/
)
assert.throws(() => validateUiExtensionWrite("..", "export {}", []), /needs a name/)

console.log("Local UI extension policy checks passed")

// The same owner contract used by the host, with controlled readiness and delivery.
const { test, after } = await import("node:test")
const { mkdtemp, rm } = await import("node:fs/promises")
const { tmpdir } = await import("node:os")
const { join } = await import("node:path")
const { watchPlugins } = await import("@mako/host/tools/plugins")
const { watchGitMarkers } = await import("@mako/host/workspaces/git-dir-watch")
const folder = await mkdtemp(join(tmpdir(), "mako-plugin-owner-"))
after(() => rm(folder, { recursive: true, force: true }))
const StartedChild = z.object({ pid: z.number().int() })
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

void test("plugin watch readiness, debounce and recovery notifications use the injected owner", async (t) => {
  let changed: (() => void) | undefined
  let changes = 0, releases = 0
  const owner = watchPlugins(folder, () => changes++, async (_dir, heard) => {
    changed = heard
    return { unsubscribe: async () => { releases++ } }
  })
  await owner.ready
  t.mock.timers.enable({ apis: ["setTimeout"] })
  changed!(); t.mock.timers.tick(60); changed!(); t.mock.timers.tick(79)
  assert.equal(changes, 0)
  t.mock.timers.tick(1)
  assert.equal(changes, 1, "a burst has the original80ms debounce")
  changed!(); t.mock.timers.tick(80)
  assert.equal(changes, 2, "a recovery/drop notification asks for the current plugins")
  changed!()
  const closing = owner.close()
  assert.equal(owner.close(), closing, "repeated close joins one completion")
  await closing
  changed!(); t.mock.timers.tick(1000)
  assert.equal(changes, 2, "neither an armed timer nor late delivery publishes after close")
  assert.equal(releases, 1)
})

void test("plugin close joins a late subscription and its release exactly once", async () => {
  let changed: (() => void) | undefined
  let opened: ((value: { unsubscribe(): Promise<void> }) => void) | undefined
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const entering = new Promise<void>((resolve) => { entered = resolve })
  let changes = 0, calls = 0, done = false
  const owner = watchPlugins(folder, () => changes++, (_dir, heard) => {
    changed = heard; entered!()
    return new Promise(resolve => { opened = resolve })
  })
  await entering
  const closing = owner.close().then(() => { done = true })
  changed!(); await tick(); assert.equal(done, false)
  opened!({ unsubscribe: () => { calls++; return new Promise(resolve => { release = resolve }) } })
  await tick(); assert.equal(done, false, "close waits for the actual owner's release")
  assert.equal(calls, 1)
  release!(); await closing; await owner.close()
  assert.equal(calls, 1); assert.equal(changes, 0)
})

void test("a plugin closed before mkdir settles never asks for a watch", async () => {
  let starts = 0
  const owner = watchPlugins(folder, () => assert.fail("closed"), async () => { starts++; return { unsubscribe: async () => {} } })
  await owner.close(); await owner.ready
  assert.equal(starts, 0)
})

void test("plugin startup failure is visible and known no-owner cleanup completes", async () => {
  const owner = watchPlugins(folder, () => assert.fail("failed"), async () => { throw 0 })
  await owner.ready.then(() => assert.fail("must reject"), error => assert.equal(error, 0))
  await owner.close()
})

void test("late plugin release failure retains its falsey cause", async () => {
  let opened: ((value: { unsubscribe(): Promise<void> }) => void) | undefined
  let entered: (() => void) | undefined
  const entering = new Promise<void>((resolve) => { entered = resolve })
  const owner = watchPlugins(folder, () => assert.fail("closed"), () => { entered!(); return new Promise(resolve => { opened = resolve }) })
  await entering
  const closing = owner.close()
  opened!({ unsubscribe: async () => { throw 0 } })
  await closing.then(() => assert.fail("must reject"), error => assert.equal(error, 0))
  assert.equal(owner.close(), closing)
})

void test("Git marker proxies preserve native mode, recovery and late-close fencing", async () => {
  let heard: import("@mako/host/workspaces/watch-backend").WatchListener | undefined
  let opened: ((value: { unsubscribe(): Promise<void> }) => void) | undefined
  let changes = 0, releases = 0
  const owner = watchGitMarkers(folder, () => changes++, ["HEAD", "refs/remotes"], async (root, ignore, listener, native) => {
    assert.equal(root, folder); assert.deepEqual(ignore, [])
    assert.deepEqual(native, { kind: "git-markers", markers: ["HEAD", "refs/remotes"] })
    heard = listener
    return new Promise(resolve => { opened = resolve })
  })
  heard!.events([]); heard!.dropped("restarted"); heard!.muted(false)
  assert.equal(changes, 3)
  const closing = owner.close()
  opened!({ unsubscribe: async () => { releases++ } })
  await closing; assert.equal(owner.close(), closing)
  heard!.events([]); heard!.dropped(); heard!.gone(); heard!.muted(false)
  assert.equal(changes, 3); assert.equal(releases, 1)
})

void test("plugin and Git native watches share the child, recover and never invoke fs.watch on the host", { timeout: 60_000 }, async () => {
  const fs = await import("node:fs")
  const { default: nodeFs } = fs
  const { syncBuiltinESMExports } = await import("node:module")
  const { childBackend } = await import("@mako/host/workspaces/watch-backend")
  const { WatchReadings } = await import("@mako/host/workspaces/watch-readings")
  const { HostStopping } = await import("@mako/host/base/host-stopping")
  const { mkdir, writeFile, rename } = await import("node:fs/promises")
  const directory = join(folder, "shared-plugins"), git = join(folder, "git")
  await mkdir(directory); await mkdir(git); await writeFile(join(git, "HEAD"), "one")
  const scope = new HostStopping(), generations: number[] = []
  const readings = new WatchReadings((message, fields) => {
    if (message === "watcher child started") generations.push(StartedChild.parse(fields).pid)
  })
  const backend = scope.run(() => childBackend(undefined, readings))
  let notifications = 0, markers = 0
  const originalWatch = nodeFs.watch
  let hostNativeCalls = 0
  nodeFs.watch = (() => { hostNativeCalls++; throw new Error("native watches must not be opened on the host") })
  syncBuiltinESMExports()
  const until = async (what: string, condition: () => boolean) => {
    for (const deadline = performance.now() + 15_000; !condition(); await new Promise(resolve => setTimeout(resolve, 10)))
      assert.ok(performance.now() < deadline, what)
  }
  const plugins = scope.run(() => watchPlugins(directory, () => notifications++, (root, changed) =>
    backend(root, [], { events: changed, dropped: changed, gone: changed, muted: muted => { if (!muted) changed() } }, { kind: "directory" })))
  const marked = scope.run(() => watchGitMarkers(git, () => markers++, ["HEAD"], backend))
  try {
    assert.equal(hostNativeCalls, 0, "native watch construction never enters the host thread")
    await Promise.all([plugins.ready, marked.ready])
    assert.equal(generations.length, 1, "both native subscriptions use the same existing child")
    await writeFile(join(directory, "fixture.ts"), "export {}")
    await until("a plugin creation arrives over IPC", () => notifications > 0)
    let prior = notifications
    await writeFile(join(directory, "fixture.ts"), "export const next = 1")
    await until("a plugin update arrives over IPC", () => notifications > prior)
    prior = notifications
    await rm(join(directory, "fixture.ts"))
    await until("a plugin deletion arrives over IPC", () => notifications > prior)
    await writeFile(join(git, "HEAD.next"), "two"); await rename(join(git, "HEAD.next"), join(git, "HEAD"))
    await until("a renamed Git marker arrives over IPC", () => markers > 0)
    const beforeRecovery = notifications
    scope.run(() => backend.recover())
    await until("native watches are resubscribed and drops published", () => generations.length === 2 && notifications > beforeRecovery)
    const recovered = notifications
    await writeFile(join(directory, "after.ts"), "export {}")
    await until("a plugin after recovery still arrives", () => notifications > recovered)
    await Promise.all([plugins.close(), marked.close()])
    const afterClose = notifications
    await writeFile(join(directory, "closed.ts"), "export {}")
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.equal(notifications, afterClose, "closed watches never publish")
  } finally {
    nodeFs.watch = originalWatch; syncBuiltinESMExports()
    await Promise.allSettled([plugins?.close(), marked.close()])
    await scope.stop()
  }
})
