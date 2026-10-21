/**
 * A session of each harness kept in step with a gateway's records routes, end to end over HTTP: captured into a
 * machine's record store, pushed, pulled into a laptop's, restored there natively, and read back by the harness's
 * own reader as the conversation the machine had. Then a turn's worth at a time, as a session grows, timed; and with
 * `--real <n>`, this Mac's `n` largest sessions of each harness, read without writing anything of theirs, through the
 * same path into scratch stores, timed.
 *
 *   MAKO_RECORDS_BASE=<records base URL> MAKO_RECORDS_AUTH="Bearer <token>" tsx scripts/prove-record-sync.ts [--real 3 [--harnesses cursor,devin]]
 *
 * MAKO_RECORDS_AUTH_FILE instead names a file holding the header, read each call, for a token that renews.
 *
 * Everything it writes is under one scratch folder it removes; the gateway keeps what it was sent.
 */
import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { recordsOverHttp } from "@mako/protocol/records-http"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { RecordStore } from "@mako/sessions/record-store"
import { RecordSync, type SyncReport } from "@mako/sessions/record-sync"
import { FACT, conversation, harnessFixtures, sessionIn } from "../packages/sessions/test/harness-fixtures.mjs"

const base = process.env.MAKO_RECORDS_BASE
const authorizationFile = process.env.MAKO_RECORDS_AUTH_FILE
const fixedAuthorization = process.env.MAKO_RECORDS_AUTH
if (!base || !(fixedAuthorization || authorizationFile)) throw new Error("Set MAKO_RECORDS_BASE and MAKO_RECORDS_AUTH (or MAKO_RECORDS_AUTH_FILE, read each call)")
const authorization = async () => fixedAuthorization ?? (await readFile(authorizationFile!, "utf8")).trim()
const realIndex = process.argv.indexOf("--real")
const real = realIndex > 0 ? Number(process.argv[realIndex + 1] ?? 3) : 0
const harnessesIndex = process.argv.indexOf("--harnesses")
/** The harnesses whose real sessions are measured; all six without it. */
const only = harnessesIndex > 0 ? new Set((process.argv[harnessesIndex + 1] ?? "").split(",")) : undefined

const remote = recordsOverHttp({ id: base, base, authorization })
const root = await mkdtemp(join(tmpdir(), "mako-prove-record-sync-"))
const writable = new NativeStores(false)
const ms = (value: number) => `${value.toFixed(0)} ms`.padStart(8)
const kib = (bytes: number) => `${(bytes / 1024).toFixed(1)} KiB`.padStart(11)
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
const p90 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * 0.9))] ?? 0
const line = (report: SyncReport) => `${String(report.versions).padStart(4)} versions ${String(report.chunks).padStart(5)} chunks ${kib(report.bytes)} ${String(report.requests).padStart(3)} requests ${ms(report.ms)}`

try {
  console.log("Six harnesses, machine → gateway → laptop, restored and read back:")
  for (const harness of harnessFixtures(writable)) {
    const folder = join(root, harness.name)
    const machineHome = join(folder, "machine-home")
    const laptopHome = join(folder, "laptop-home")
    const cwd = join(machineHome, "project")
    await mkdir(cwd, { recursive: true })
    await harness.emit(machineHome, cwd)
    const machineReader = harness.provider(machineHome)
    const source = await sessionIn(machineReader)
    assert.ok(source, `${harness.name}: a session to send`)
    const nativeId: string = source.ref.nativeId
    const original = conversation(await machineReader.read(source.file.path))
    assert.ok(JSON.stringify(original).includes(FACT))
    const machine = new RecordStore(join(folder, "machine-records"), writable)
    const laptop = new RecordStore(join(folder, "laptop-records"), writable)
    try {
      const records = await machineReader.records(source.file.path)
      assert.ok(records)
      await machine.capture({ harness: harness.name, nativeId, home: machineHome, records })
      const up = await new RecordSync(machine, remote).push(harness.name, nativeId)
      const down = await new RecordSync(laptop, remote).pull(harness.name, nativeId)
      assert.deepEqual(laptop.holdings(harness.name, nativeId), machine.holdings(harness.name, nativeId), `${harness.name}: the laptop holds what the machine holds`)
      const restoring = performance.now()
      const restored = await laptop.restore({ harness: harness.name, nativeId, home: laptopHome, installed: null })
      const restoreMs = performance.now() - restoring
      assert.equal(restored.written, true, `${harness.name}: ${JSON.stringify(restored)}`)
      const arrived = await sessionIn(harness.provider(laptopHome), nativeId)
      assert.ok(arrived, `${harness.name}: its reader finds it on the laptop`)
      assert.deepEqual(conversation(await harness.provider(laptopHome).read(arrived.file.path)), original, `${harness.name}: the same conversation`)
      console.log(`  ${harness.name.padEnd(8)} up ${line(up)}   down ${line(down)}   restore ${ms(restoreMs)}`)
    } finally {
      machine.close()
      laptop.close()
    }
  }

  // A session growing a turn at a time, each pushed as it lands: what a machine pays per turn to keep the gateway current.
  {
    const folder = join(root, "turns")
    const home = join(folder, "home")
    const cwd = join(home, "project")
    await mkdir(cwd, { recursive: true })
    const codex = harnessFixtures(writable).find((harness) => harness.name === "codex")
    assert.ok(codex)
    await codex.emit(home, cwd)
    const reader = codex.provider(home)
    const source = await sessionIn(reader)
    assert.ok(source)
    const store = new RecordStore(join(folder, "records"), writable)
    const sync = new RecordSync(store, remote)
    const capture = async () => {
      const records = await reader.records(source.file.path)
      assert.ok(records)
      return store.capture({ harness: "codex", nativeId: source.ref.nativeId, home, records })
    }
    await capture()
    await sync.push("codex", source.ref.nativeId)
    const turns: SyncReport[] = []
    for (let turn = 0; turn < 30; turn++) {
      const text = `${"turn ".repeat(40)}${turn} ${crypto.randomUUID()} `.repeat(30)
      await appendFile(source.file.path, `${JSON.stringify({ timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })}\n`)
      await capture()
      turns.push(await sync.push("codex", source.ref.nativeId))
    }
    store.close()
    const times = turns.map((report) => report.ms)
    console.log(`A turn's push (30 turns, ${kib(median(turns.map((report) => report.bytes)))} each): median ${ms(median(times))}, p90 ${ms(p90(times))}, ${median(turns.map((report) => report.requests))} requests`)
  }

  if (real > 0) {
    console.log(`\nThis Mac's ${real} largest sessions of each harness, read only, through the gateway into scratch stores:`)
    const strict = new NativeStores(true)
    for (const harness of harnessFixtures(strict)) {
      if (only && !only.has(harness.name)) continue
      const reader = harness.provider(homedir())
      let files: Awaited<ReturnType<typeof reader.discover>> = []
      try {
        files = await reader.discover()
      } catch (error) {
        console.log(`  ${harness.name.padEnd(8)} not read: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      // By how far each reaches: a file's length, or a database record's revision, which grows with it.
      files.sort((a, b) => b.bytes - a.bytes)
      for (const file of files.slice(0, real)) {
        const folder = join(root, "real", harness.name, String(files.indexOf(file)))
        const machine = new RecordStore(join(folder, "machine"), strict)
        const laptop = new RecordStore(join(folder, "laptop"), writable)
        try {
          const ref = await reader.peek(file)
          const records = ref && (await reader.records(file.path))
          if (!ref || !records) continue
          const capturing = performance.now()
          const captured = await machine.capture({ harness: harness.name, nativeId: ref.nativeId, home: homedir(), records })
          const captureMs = performance.now() - capturing
          const up = await new RecordSync(machine, remote).push(harness.name, ref.nativeId)
          const down = await new RecordSync(laptop, remote).pull(harness.name, ref.nativeId)
          assert.deepEqual(laptop.holdings(harness.name, ref.nativeId), machine.holdings(harness.name, ref.nativeId), `${harness.name} ${ref.nativeId}: whole on the other side`)
          const mbps = (report: SyncReport) => `${((report.bytes / 1024 / 1024) / Math.max(report.ms / 1000, 0.001)).toFixed(1)} MiB/s`.padStart(11)
          console.log(`  ${harness.name.padEnd(8)} ${(captured.newBytes / 1024 / 1024).toFixed(1).padStart(7)} MiB captured ${ms(captureMs)}   up ${line(up)} ${mbps(up)}   down ${line(down)} ${mbps(down)}`)
        } finally {
          machine.close()
          laptop.close()
        }
      }
    }
  }
  console.log("\nPASS: every harness's session kept in step with the gateway, restored on another home and read back as it was")
} finally {
  await rm(root, { recursive: true, force: true })
}
