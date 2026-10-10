import assert from "node:assert/strict"
import { test } from "node:test"
import { lazyPackage, onPackageLoad, packageLoads } from "../dist/index.js"

const loadOf = (name) => packageLoads().find((load) => load.name === name)

test("a package loads once, at its first use, for the first reason given", async () => {
  let loads = 0
  const module = { value: 1 }
  const fixture = lazyPackage("fixture-once", async () => { loads += 1; return module })
  assert.equal(loads, 0)
  assert.deepEqual(loadOf("fixture-once"), { name: "fixture-once", state: "unloaded" })
  const [first, second] = await Promise.all([fixture.load("first caller"), fixture.load("second caller")])
  assert.equal(first, module)
  assert.equal(second, module)
  assert.equal(loads, 1)
  const ready = loadOf("fixture-once")
  assert.equal(ready.state, "ready")
  assert.equal(ready.reason, "first caller")
  assert.ok(Number.isInteger(ready.ms) && ready.ms >= 0)
})

test("a failed load stays failed and names what needed it", async () => {
  let loads = 0
  const fixture = lazyPackage("fixture-failing", async () => { loads += 1; throw new Error("Cannot find package") })
  await assert.rejects(fixture.load("a feature"), /fixture-failing could not be loaded for a feature: Cannot find package/)
  await assert.rejects(fixture.load("another feature"), /for a feature/)
  assert.equal(loads, 1)
  const failed = loadOf("fixture-failing")
  assert.equal(failed.state, "failed")
  assert.equal(failed.error, "Cannot find package")
})

test("each change of state reaches the listeners, in order", async () => {
  const seen = []
  const stop = onPackageLoad((load) => { if (load.name === "fixture-listened") seen.push(load.state) })
  const fixture = lazyPackage("fixture-listened", async () => ({}))
  await fixture.load("listener")
  stop()
  assert.deepEqual(seen, ["loading", "ready"])
})

test("a second copy of this module, and a second declaration, record into the process's one record", async () => {
  const copy = await import("../dist/index.js?second-copy")
  assert.notEqual(copy.lazyPackage, lazyPackage)
  const seen = []
  const stop = onPackageLoad((load) => { if (load.name === "fixture-twice") seen.push(load.state) })
  const first = lazyPackage("fixture-twice", async () => "module")
  const second = copy.lazyPackage("fixture-twice", async () => "module")
  assert.equal(await first.load("source"), "module")
  assert.equal(await second.load("build"), "module")
  stop()
  assert.deepEqual(seen, ["loading", "ready"])
  assert.equal(copy.packageLoads().find((load) => load.name === "fixture-twice").reason, "source")
})
