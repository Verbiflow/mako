import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RecordBundleSchema } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { FACT, conversation, harnessFixtures, sessionIn } from "./harness-fixtures.mjs"

/**
 * Every harness's session crosses between stores as it would from a machine to the cloud and on to a laptop, and
 * the laptop's restore is a session that harness's own reader reads as the conversation the machine had: the same
 * entries, in a home and folders that aren't the machine's.
 */

const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-record-crossing-harnesses-"))
/** What one store hands another, as the wire would carry it. */
async function cross(from, to, harness, nativeId) {
  const started = performance.now()
  const bundle = RecordBundleSchema.parse(JSON.parse(JSON.stringify(from.exportSession(harness, nativeId, to.holdings(harness, nativeId)))))
  const report = await to.importSession(bundle, async function* (hashes) {
    for (const hash of hashes) yield { hash, chunk: await from.readChunk(hash) }
  })
  return { ...report, totalMs: performance.now() - started }
}

const rows = []
try {
  for (const harness of harnessFixtures(stores)) {
    const base = join(root, harness.name)
    const machineHome = join(base, "machine-home")
    const laptopHome = join(base, "laptop-home")
    const cwd = join(machineHome, "project")
    await mkdir(cwd, { recursive: true })
    await harness.emit(machineHome, cwd)
    const machineProvider = harness.provider(machineHome)
    const source = await sessionIn(machineProvider)
    assert.ok(source, `${harness.name}: the machine's session is found`)
    const nativeId = source.ref.nativeId
    const original = conversation(await machineProvider.read(source.file.path))
    assert.ok(original.length >= 2 && JSON.stringify(original).includes(FACT), `${harness.name}: the machine's session reads as the conversation`)

    const machine = new RecordStore(join(base, "machine-records"), stores)
    const cloud = new RecordStore(join(base, "cloud-records"), stores)
    const laptop = new RecordStore(join(base, "laptop-records"), stores)
    try {
      await machine.capture({ harness: harness.name, nativeId, home: machineHome, records: await machineProvider.records(source.file.path) })
      const up = await cross(machine, cloud, harness.name, nativeId)
      const down = await cross(cloud, laptop, harness.name, nativeId)
      assert.deepEqual(laptop.holdings(harness.name, nativeId), machine.holdings(harness.name, nativeId), `${harness.name}: the laptop holds what the machine holds`)
      const again = await cross(machine, cloud, harness.name, nativeId)
      assert.equal(again.versions + again.chunks, 0, `${harness.name}: nothing crosses twice`)

      const started = performance.now()
      const restored = await laptop.restore({ harness: harness.name, nativeId, home: laptopHome, installed: null })
      const restoreMs = performance.now() - started
      assert.equal(restored.written, true, `${harness.name}: restored ${JSON.stringify(restored)}`)
      const laptopProvider = harness.provider(laptopHome)
      const arrived = await sessionIn(laptopProvider, nativeId)
      assert.ok(arrived, `${harness.name}: its own reader finds the session on the laptop`)
      assert.deepEqual(conversation(await laptopProvider.read(arrived.file.path)), original, `${harness.name}: the laptop's session is the machine's conversation`)
      rows.push({ harness: harness.name, versions: up.versions, chunks: up.chunks, bytes: up.bytes, stored: up.storedBytes, up: up.totalMs, down: down.totalMs, restore: restoreMs })
    } finally {
      await Promise.all([machine.close(), cloud.close(), laptop.close()])
    }
  }
} finally {
  await rm(root, { recursive: true, force: true })
}

const ms = (value) => `${value.toFixed(1)} ms`.padStart(9)
for (const row of rows)
  console.log(`  ${row.harness.padEnd(8)} ${String(row.versions).padStart(2)} versions ${String(row.chunks).padStart(3)} chunks ${String(row.bytes).padStart(7)} B (${String(row.stored).padStart(6)} B stored)  up ${ms(row.up)}  down ${ms(row.down)}  restore ${ms(row.restore)}`)
console.log("PASS: every harness's session crosses machine → cloud → laptop and its own reader reads the restored conversation as the machine's")
