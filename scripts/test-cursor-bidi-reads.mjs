import assert from "node:assert/strict"
import { setImmediate as nextTurn } from "node:timers/promises"
import { runInNewContext } from "node:vm"
import { locate } from "./lib/anchored-patch.mjs"
import { bundleContext, installedPatch, readSdk, sdkFiles, sdkVersion as version, throughBlock, unpatched } from "./lib/cursor-sdk-sites.mjs"

// Run with --expose-gc. The SDK's bidi transport, taken from its module by
// shape, whatever this release names it, must let go of each message once it has been read,
// on both the backend's side and the client's appending side, while the
// stream stays open; and an append failure or abort must still reach a read.
const collect = globalThis.gc
assert.ok(collect, "run with node --expose-gc")

const MESSAGES = 64
/** The transport's head, in 1.4.0's names. */
const CLASS_START = "class p{constructor(t,r,e,n,s={}){this.mapper=t,this.bidiClient=r"

class Aborted extends Error {}

/**
 * What the transport reaches out to in its module (the protocol's method kinds, its request message, the abort
 * error, Connect's errors), as one stand-in under whatever names this release gives them: called, it hands back its
 * argument; constructed, it is the abort.
 */
function moduleStub(value) {
  return new.target ? new Aborted() : value
}
Object.assign(moduleStub, {
  MethodKind: { BiDiStreaming: "bidi" },
  isMessage: () => true,
  $r: class { constructor(fields) { Object.assign(this, fields) } },
  T$: (inputs) => inputs,
  ConnectError: class extends Error {},
  Code: { DeadlineExceeded: 4 },
})

function transportClass(source) {
  const start = locate(source, CLASS_START)
  assert.equal(start.count, 1, `@cursor/sdk ${version} changed its bidi transport's head; find it and anchor it here`)
  return runInNewContext(`(${throughBlock(source, start.index)})`, bundleContext({}, moduleStub))
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

for (const build of ["esm", "cjs"]) {
  // Throws when the installed SDK lacks the patch.
  const { file: target } = installedPatch(readSdk, sdkFiles, "bidi-reads", build)
  const source = readSdk(target)
  const original = unpatched(build, "bidi-reads")
  const before = await retention(transportClass(original))
  assert.ok(before.sent >= MESSAGES - 1 && before.appended >= MESSAGES - 1, `${target} unpatched kept ${before.sent} read and ${before.appended} appended messages: this test no longer sees the leak`)
  const after = await retention(transportClass(source))
  assert.ok(after.sent <= 1, `${target} keeps ${after.sent} of ${MESSAGES} messages it read from the backend`)
  assert.ok(after.appended <= 1, `${target} keeps ${after.appended} of ${MESSAGES} messages it appended`)
  await failures(transportClass(source))
  assert.deepEqual(await concurrent(transportClass(original)), ["rejected", "rejected"], `${target} unpatched no longer rejects both outstanding reads; this test no longer sees the race`)
  assert.deepEqual(await concurrent(transportClass(source)), ["rejected", "rejected"], `${target} leaves an earlier outstanding read pending when an append fails`)
}
console.log(`Cursor bidi reads (@cursor/sdk ${version}): ESM/CJS let go of each message once read on both sides of an open stream (the unpatched reads kept all ${MESSAGES}); an append failure rejects every outstanding read, and an abort still reaches a read`)
