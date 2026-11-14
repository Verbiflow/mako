import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { BIDI_READS } from "./patch-cursor-sdk.mjs"

// Run with --expose-gc. The SDK's bidi transport, taken from its
// version-pinned module, must let go of each message once it has been read,
// on both the backend's side and the client's appending side, while the
// stream stays open; and an append failure or abort must still reach a read.
const require = createRequire(import.meta.url)
const sdk = join(dirname(require.resolve("@cursor/sdk")), "../..")
const { version } = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8"))
const collect = globalThis.gc
assert.ok(collect, "run with node --expose-gc")

const MESSAGES = 64
const CLASS_START = "class f{constructor(t,r,e,n,s={}){this.mapper=t,this.bidiClient=r"

class Aborted extends Error {}

function transportClass(source) {
  const start = source.indexOf(CLASS_START)
  assert.ok(start >= 0, `@cursor/sdk ${version} moved its bidi transport; find it and name it here`)
  const end = source.indexOf("}var h=", start) + 1
  return runInNewContext(`(${source.slice(start, end)})`, {
    Promise, Symbol, Headers, Array, AbortController, Buffer, Math, BigInt, Error, Uint8Array, ArrayBuffer,
    c: { MethodKind: { BiDiStreaming: "bidi" }, isMessage: () => true },
    u: { $r: class { constructor(fields) { Object.assign(this, fields) } } },
    m: { T$: (inputs) => inputs },
    p: Aborted,
    d: (cause) => cause,
    l: { ConnectError: class extends Error {}, Code: { DeadlineExceeded: 4 } },
    i: {},
  })
}

const never = new Promise(() => {})
const message = (seq) => ({ seq, payload: new Uint8Array(256 * 1024), toBinary: () => new Uint8Array(8) })

async function alive(refs) {
  for (let round = 0; round < 4; round++) {
    await nextTurn()
    collect()
  }
  return refs.filter((ref) => ref.deref() !== undefined).length
}

/** A stream that stays open after `MESSAGES` each way, as a run's does between its reads. */
async function openStream(Transport, { append = () => Promise.resolve(), signal } = {}) {
  const sent = [], appended = []
  let appends = 0
  const inner = {
    stream: async () => ({
      message: (async function* () {
        for (let seq = 0; seq < MESSAGES; seq++) {
          const next = message(seq)
          sent.push(new WeakRef(next))
          yield next
        }
        await never
      })(),
    }),
  }
  const inputs = (async function* () {
    for (let seq = 0; seq < MESSAGES; seq++) {
      const next = message(seq)
      appended.push(new WeakRef(next))
      yield next
    }
    await never
  })()
  const bidi = { bidiAppend: (request) => (appends++, append(request)) }
  const transport = new Transport({ map: (method) => method }, bidi, inner, () => {})
  const response = await transport.stream({}, { kind: "bidi" }, signal, undefined, { "x-request-id": "r" }, inputs, undefined)
  const reader = response.message[Symbol.asyncIterator]()
  return { reader, sent, appended, appends: () => appends }
}

async function retention(Transport) {
  const stream = await openStream(Transport)
  for (let seq = 0; seq < MESSAGES; seq++) assert.equal((await stream.reader.next()).value.seq, seq)
  while (stream.appends() < MESSAGES) await nextTurn()
  return { sent: await alive(stream.sent), appended: await alive(stream.appended), reader: stream.reader }
}

/** Two reads outstanding while the backend is quiet: an append failure rejects both, as the unpatched race does. */
async function concurrent(Transport) {
  let rejectAppend
  const appending = new Promise((_, reject) => { rejectAppend = reject })
  const inputs = (async function* () {
    yield { toBinary: () => new Uint8Array(1) }
    await never
  })()
  const transport = new Transport(
    { map: (method) => method },
    { bidiAppend: () => appending },
    { stream: async () => ({ message: (async function* () { await never; yield undefined })() }) },
    () => {},
  )
  const response = await transport.stream({}, { kind: "bidi" }, undefined, undefined, { "x-request-id": "r" }, inputs, undefined)
  const reader = response.message[Symbol.asyncIterator]()
  const states = ["pending", "pending"]
  reader.next().then(() => { states[0] = "resolved" }, () => { states[0] = "rejected" })
  reader.next().then(() => { states[1] = "resolved" }, () => { states[1] = "rejected" })
  await nextTurn()
  rejectAppend(new Error("append failed"))
  await nextTurn()
  await nextTurn()
  return states
}

async function failures(Transport) {
  // An append that fails rejects the read waiting on the backend, and every read after it.
  const failure = new Error("append failed")
  let fail
  const appending = new Promise((_, reject) => { fail = reject })
  const failing = await openStream(Transport, { append: () => appending })
  for (let seq = 0; seq < MESSAGES; seq++) await failing.reader.next()
  const waiting = failing.reader.next()
  fail(failure)
  await assert.rejects(waiting, (cause) => cause === failure)
  await assert.rejects(failing.reader.next(), (cause) => cause === failure)
  // An abort ends the appending side while it waits on an input that never comes.
  const abort = new AbortController()
  const aborted = await openStream(Transport, { signal: abort.signal })
  while (aborted.appends() < MESSAGES) await nextTurn()
  abort.abort()
  await nextTurn()
  assert.equal(aborted.appends(), MESSAGES)
}

function unpatch(source) {
  for (const [original, patched] of BIDI_READS) source = source.replace(patched, () => original)
  return source
}

for (const target of ["dist/esm/index.js", "dist/cjs/index.js"]) {
  const source = readFileSync(join(sdk, target), "utf8")
  for (const [, patched] of BIDI_READS) assert.ok(source.includes(patched), `${target} lacks the bidi reads patch; run scripts/patch-cursor-sdk.mjs`)
  const before = await retention(transportClass(unpatch(source)))
  assert.ok(before.sent >= MESSAGES - 1 && before.appended >= MESSAGES - 1, `${target} unpatched kept ${before.sent} read and ${before.appended} appended messages: this test no longer sees the leak`)
  const after = await retention(transportClass(source))
  assert.ok(after.sent <= 1, `${target} keeps ${after.sent} of ${MESSAGES} messages it read from the backend`)
  assert.ok(after.appended <= 1, `${target} keeps ${after.appended} of ${MESSAGES} messages it appended`)
  await failures(transportClass(source))
  const Transport = transportClass(source)
  const original = transportClass(unpatch(source))
  assert.deepEqual(await concurrent(original), ["rejected", "rejected"], `${target} unpatched no longer rejects both outstanding reads; this test no longer sees the race`)
  assert.deepEqual(await concurrent(Transport), ["rejected", "rejected"], `${target} leaves an earlier outstanding read pending when an append fails`)
}
console.log(`Cursor bidi reads (@cursor/sdk ${version}): ESM/CJS let go of each message once read on both sides of an open stream (the unpatched reads kept all ${MESSAGES}); an append failure rejects every outstanding read, and an abort still reaches a read`)
