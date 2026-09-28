import assert from "node:assert/strict"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import parcel from "@parcel/watcher"

const subscriptions = []
const original = parcel.subscribe
parcel.subscribe = async (path, callback, options) => {
  const watcher = { path, options, closed: 0, change: (file) => callback(null, [{ type: "update", path: join(path, file) }]),
    drop: () => callback(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."), []) }
  subscriptions.push(watcher)
  return { unsubscribe: async () => { watcher.closed += 1 } }
}
const settled = () => new Promise((resolve) => setImmediate(resolve))
const { watchWorkspace, stopWatching, saveAutomations, setEnabled, bindAutomations, fireAutomation } =
  await import("../electron/automations.ts")
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-automation-watch-")))
const fired = []
bindAutomations(() => {}, async (_cwd, prompt) => { fired.push(prompt) })
const rule = (id, kind = "files") => ({ id, name: id, prompt: id, enabled: false,
  trigger: kind === "files" ? { kind, paths: ["src/**/*.ts"] } : { kind } })
mock.timers.enable({ apis: ["setTimeout"] })
try {
  await watchWorkspace(root)
  assert.equal(subscriptions.length, 0, "empty workspaces must not register an automation watcher")
  const rules = [rule("first"), rule("second"), rule("manual", "manual"), rule("commit", "commit")]
  await saveAutomations(root, rules)
  setEnabled("manual", true)
  setEnabled("commit", true)
  assert.equal(subscriptions.length, 0, "disabled file rules and other trigger types require no subscription")

  setEnabled("first", true)
  await settled()
  const first = subscriptions[0]
  assert.ok(first)
  assert.equal(first.path, root)
  assert.ok(first.options.ignore.some((pattern) => pattern.includes("node_modules")), "dependency folders are excluded at the source")
  setEnabled("second", true)
  await settled()
  assert.equal(subscriptions.length, 1, "all enabled file rules share the subscription")
  first.change("node_modules/pkg/index.ts")
  first.change("src/proof.ts")
  setEnabled("first", false)
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.deepEqual(fired, ["second"], "disabling a rule cancels its pending launch while other rules remain active; dependency writes launch nothing")
  setEnabled("second", false)
  await settled()
  assert.equal(first.closed, 1, "last disabled file rule releases the watcher")

  setEnabled("first", true)
  await settled()
  const replacement = subscriptions[1]
  assert.ok(replacement)
  first.change("src/stale.ts")
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.deepEqual(fired, ["second"], "late callbacks from a replaced watcher cannot launch new work")
  replacement.change("src/current.ts")
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.deepEqual(fired, ["second", "first"], "re-enabling restores file-change execution")
  replacement.drop()
  assert.equal(replacement.closed, 0, "dropped events leave the watch running")

  await saveAutomations(root, [rule("manual", "manual"), rule("commit", "commit")])
  await settled()
  assert.equal(replacement.closed, 1, "removing the final file rule releases its subscription")
  await fireAutomation("manual", "manual")
  assert.equal(fired.at(-1), "manual", "manual execution works without a filesystem watcher")
  await fireAutomation("commit", "commit")
  assert.equal(fired.at(-1), "manual", "disabled automatic triggers cannot run from an old callback")
  await saveAutomations(root, [{ ...rule("switch"), enabled: true }])
  await settled()
  const previous = subscriptions[2]
  assert.ok(previous)
  await watchWorkspace(root)
  await settled()
  assert.equal(previous.closed, 1, "workspace replacement closes the old subscription")
  assert.equal(subscriptions.length, 3, "reloaded repository rules stay disabled")
  previous.change("src/old-workspace.ts")
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.equal(fired.length, 3)
  console.log("Automation watcher ownership: no idle subscription, one active subscription, dependency folders excluded, disable/remove cleanup, dropped events survived, stale callback fences and manual execution passed")
} finally {
  stopWatching()
  mock.timers.reset()
  parcel.subscribe = original
  await rm(root, { recursive: true, force: true })
}
