import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"
import { assertCursorSdkPatched, CURSOR_SDK_PATCHES } from "./patch-cursor-sdk.mjs"

const require = createRequire(import.meta.url)
const sdk = join(dirname(require.resolve("@cursor/sdk")), "../..")
assertCursorSdkPatched(file => readFileSync(join(sdk, file), "utf8"))
const unhandled = []
const observeUnhandled = cause => unhandled.push(cause)
process.on("unhandledRejection", observeUnhandled)

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function cacheClass(source, bundle, queue) {
  const start = source.indexOf(`class ${bundle.name}{constructor(e){this.source=e,this.pastElements=[]`)
  assert.ok(start >= 0)
  const end = source.indexOf(`function ${bundle.next}(`, start)
  const helpers = source.slice(source.lastIndexOf(`${bundle.values}=function`, start), start)
  // These are the SDK's actual cache, transpiled iterator helpers and queue,
  // taken from its version-pinned module, not an imitation of their behavior.
  return runInNewContext(`var ${helpers}${source.slice(start, end)};${bundle.name}`, {
    Promise, Symbol, Set, [bundle.queue]: { Jt: queue },
  })
}

async function failureCase(Cache, failure, partial) {
  const gate = deferred()
  const cache = new Cache((async function* () {
    if (partial) yield "first"
    await gate.promise
    throw failure
  })())
  const readers = [cache.fork(), cache.fork()]
  if (partial) for (const first of await Promise.all(readers.map(reader => reader.next())))
    assert.deepEqual({ ...first }, { value: "first", done: false })
  const outcomes = Promise.allSettled(readers.map(reader => reader.next()))
  gate.resolve()
  for (const outcome of await outcomes) {
    assert.equal(outcome.status, "rejected", "a source failure is never a successful end")
    assert.equal(outcome.reason, failure, "every active reader gets the original failure")
  }
  const replay = cache.fork()
  if (partial) assert.deepEqual({ ...await replay.next() }, { value: "first", done: false })
  const [late] = await Promise.allSettled([replay.next()])
  assert.equal(late.status, "rejected")
  assert.equal(late.reason, failure, "a later cached replay keeps the failure")
  assert.equal(cache.closed, true)
  assert.equal(cache.forks.size, 0)
}

try {
  for (const bundle of [
    { target: "dist/esm/357.js", name: "fs", values: "ds", queue: "us", next: "ms" },
    { target: "dist/cjs/222.js", name: "Pv", values: "xv", queue: "f", next: "Iv" },
  ]) {
    const module = bundle.target.includes("/esm/")
      ? await import(pathToFileURL(join(sdk, bundle.target)).href)
      : require(join(sdk, bundle.target))
    const factories = module.__webpack_esm_modules__ ?? module.modules
    const exports = {}
    factories["../utils/dist/writable-iterable.js"]({}, exports, {
      d(target, getters) { for (const [key, get] of Object.entries(getters)) Object.defineProperty(target, key, { get }) },
    })
    const source = readFileSync(join(sdk, bundle.target), "utf8")
    const Cache = cacheClass(source, bundle, exports.Jt)
    for (const failure of [
      Object.assign(new Error("network"), { name: "ConnectError", code: 14 }),
      Object.assign(new Error("auth"), { name: "ConnectError", code: 16 }),
      new TypeError("tool bug"), Object.freeze(new Error("frozen")), "thrown text", undefined,
    ]) for (const partial of [false, true]) await failureCase(Cache, failure, partial)

    // A cancelled subscriber cannot cancel its peers or corrupt later replay.
    const gate = deferred()
    const cache = new Cache((async function* () { yield 1; await gate.promise; yield 2 })())
    const cancelled = cache.fork(), remaining = cache.fork()
    await Promise.all([cancelled.next(), remaining.next()])
    await cancelled.return()
    const second = remaining.next()
    gate.resolve()
    assert.deepEqual({ ...await second }, { value: 2, done: false })
    assert.deepEqual({ ...await remaining.next() }, { value: undefined, done: true })
    assert.deepEqual(await Array.fromAsync(cache.fork()), [1, 2])
    await nextTurn()
    assert.equal(unhandled.length, 0, "all patched tool-stream failures have an owner")

    // Prove the old SDK loses the failure and emits an orphaned rejection.
    let original = source
    const patch = CURSOR_SDK_PATCHES.find(entry => entry.target === bundle.target)
    for (const [before, after] of patch.replacements) original = original.replace(after, () => before)
    const Original = cacheClass(original, bundle, exports.Jt)
    const failure = new Error("original SDK source failure")
    const old = new Original((async function* () { yield "partial"; throw failure })())
    assert.deepEqual(await Array.fromAsync(old.fork()), ["partial"], "the unpatched reader falsely reports success")
    await nextTurn()
    assert.deepEqual(unhandled.splice(0), [failure], "the unpatched consume promise rejects without an owner")
  }
  console.log("Cursor tool streams: original SDK failure reproduced; ESM/CJS active and replay readers preserve network/auth/programming/frozen/non-Error failures, partial output, cancellation and normal completion without orphaned promises")
} finally {
  process.off("unhandledRejection", observeUnhandled)
}
