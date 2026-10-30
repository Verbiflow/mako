import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import { runInNewContext } from "node:vm"

// A cached streaming tool's source failure must reach every active and later
// replay reader, never close them as a success or reject a promise nobody
// observes (the child exits on one). Mako patched this into SDK 1.0.31; 1.0.40
// does it itself, and this holds each later SDK to it.
const require = createRequire(import.meta.url)
const sdk = join(dirname(require.resolve("@cursor/sdk")), "../..")
const { version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
const unhandled = []
const observeUnhandled = cause => unhandled.push(cause)
process.on("unhandledRejection", observeUnhandled)

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

function cacheClass(source, bundle, queue) {
  const start = source.indexOf(`class ${bundle.name}{constructor(e){this.pastElements=[],this.closed=!1,this.forks=new Set,this.consume(e)}`)
  assert.ok(start >= 0, `@cursor/sdk ${version} moved its streaming-tool cache out of ${bundle.target}; find it and name it here`)
  const end = source.indexOf(`function ${bundle.next}(`, start)
  // The SDK's actual cache and queue, taken from its version-pinned module,
  // not an imitation of their behavior.
  return runInNewContext(`${source.slice(start, end)};${bundle.name}`, {
    Promise, Symbol, Set, Error, String, [bundle.queue]: { Jt: queue },
  })
}

/** An Error arrives as itself; anything else thrown arrives as an Error saying it. */
function said(reason, failure, message) {
  if (failure instanceof Error) assert.equal(reason, failure, message)
  else assert.equal(reason.message, String(failure), message)
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
    said(outcome.reason, failure, "every active reader gets the failure")
  }
  const replay = cache.fork()
  if (partial) assert.deepEqual({ ...await replay.next() }, { value: "first", done: false })
  const [late] = await Promise.allSettled([replay.next()])
  assert.equal(late.status, "rejected")
  said(late.reason, failure, "a later cached replay keeps the failure")
  assert.equal(cache.closed, true)
  assert.equal(cache.forks.size, 0)
}

try {
  for (const bundle of [
    { target: "dist/esm/336.js", name: "rI", queue: "P", next: "nI" },
    { target: "dist/cjs/336.js", name: "sI", queue: "R", next: "iI" },
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
    assert.equal(unhandled.length, 0, "every tool-stream failure has an owner")
  }
  console.log(`Cursor tool streams (@cursor/sdk ${version}): ESM/CJS active and replay readers get network/auth/programming/frozen/non-Error failures, keep partial output, cancellation and normal completion, with no orphaned promises`)
} finally {
  process.off("unhandledRejection", observeUnhandled)
}
