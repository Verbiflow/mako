import assert from "node:assert/strict"
import fs from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"

const subscriptions = []
const original = fs.watch
fs.watch = (path, options, callback) => {
  const watcher = { path, options, callback, closed: 0, close() { this.closed += 1 } }
  subscriptions.push(watcher)
  return watcher
}
syncBuiltinESMExports()
const { watchWorkspace, stopWatching, saveAutomations, setEnabled, bindAutomations, fireAutomation } =
  await import("../electron/automations.ts")
const root = await mkdtemp(join(tmpdir(), "mako-automation-watch-"))
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
  const first = subscriptions[0]
  assert.ok(first)
  assert.equal(first.options.recursive, true)
  setEnabled("second", true)
  assert.equal(subscriptions.length, 1, "all enabled file rules share the subscription")
  first.callback("change", "src/proof.ts")
  setEnabled("first", false)
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.deepEqual(fired, ["second"], "disabling a rule cancels its pending launch while other rules remain active")
  setEnabled("second", false)
  assert.equal(first.closed, 1, "last disabled file rule releases the watcher")

  setEnabled("first", true)
  const replacement = subscriptions[1]
  assert.ok(replacement)
  first.callback("change", "src/stale.ts")
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.deepEqual(fired, ["second"], "late callbacks from a replaced watcher cannot launch new work")
  replacement.callback("change", "src/current.ts")
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.deepEqual(fired, ["second", "first"], "re-enabling restores file-change execution")

  await saveAutomations(root, [rule("manual", "manual"), rule("commit", "commit")])
  assert.equal(replacement.closed, 1, "removing the final file rule releases its subscription")
  await fireAutomation("manual", "manual")
  assert.equal(fired.at(-1), "manual", "manual execution works without a filesystem watcher")
  await fireAutomation("commit", "commit")
  assert.equal(fired.at(-1), "manual", "disabled automatic triggers cannot run from an old callback")
  await saveAutomations(root, [{ ...rule("switch"), enabled: true }])
  const previous = subscriptions[2]
  assert.ok(previous)
  await watchWorkspace(root)
  assert.equal(previous.closed, 1, "workspace replacement closes the old subscription")
  assert.equal(subscriptions.length, 3, "reloaded repository rules stay disabled")
  previous.callback("change", "src/old-workspace.ts")
  mock.timers.tick(1201)
  await Promise.resolve()
  assert.equal(fired.length, 3)
  console.log("Automation watcher ownership: no idle subscription, one active subscription, disable/remove cleanup, stale callback fences and manual execution passed")
} finally {
  stopWatching()
  mock.timers.reset()
  fs.watch = original
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
