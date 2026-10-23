import assert from "node:assert/strict"
import { createServer } from "node:http"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encodeChunkPack } from "@mako/protocol/records"
import { SessionCatalog } from "../dist/catalog.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { harnessFixtures, sessionIn } from "./harness-fixtures.mjs"

/**
 * A receive is all or nothing (`SessionCatalog.receiveRecords`): every session's restore is asked before any is
 * written, so one that can't be taken (its harness here older than the one that wrote it) leaves no other in its
 * harness's store, where it could run while its Thread runs elsewhere, and what was pulled of sessions this store
 * never held goes again, so nothing of them is listed here. Taken whole, every session is written.
 */
const stores = new NativeStores(false)
const root = await mkdtemp(join(tmpdir(), "mako-receive-all-or-nothing-"))
const fixtures = new Map(harnessFixtures(stores).map((fixture) => [fixture.name, fixture]))
const machineHome = join(root, "machine-home")
const cwd = join(machineHome, "project")
await mkdir(cwd, { recursive: true })
const machine = new RecordStore(join(root, "machine-records"), stores)
const sessions = []
for (const name of ["claude", "codex"]) {
  const fixture = fixtures.get(name)
  await fixture.emit(machineHome, cwd)
  const provider = fixture.provider(machineHome)
  const source = await sessionIn(provider)
  await machine.capture({ harness: name, nativeId: source.ref.nativeId, home: machineHome, records: await provider.records(source.file.path) })
  sessions.push({ harness: name, nativeId: source.ref.nativeId })
}

// The cloud's records routes a receive reads, served from the machine's store: a session's versions, then their chunks.
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://cloud")
  if (url.pathname.endsWith("/sessions/pull")) {
    const bundle = Number(url.searchParams.get("after") ?? 0) > 0 ? null : machine.exportSession(url.searchParams.get("harness"), url.searchParams.get("nativeId"))
    if (!bundle) return void response.writeHead(404, { "content-type": "application/json" }).end("{}")
    return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bundle, through: 1, more: false }))
  }
  if (url.pathname.endsWith("/chunks/read")) {
    let body = ""
    for await (const part of request) body += part
    const pack = []
    for (const hash of JSON.parse(body).hashes) {
      const chunk = await machine.readChunk(hash)
      if (chunk) pack.push({ hash, codec: chunk.codec, size: chunk.size, body: chunk.body })
    }
    return void response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(encodeChunkPack(pack)))
  }
  response.writeHead(404, { "content-type": "application/json" }).end("{}")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/v1/threads/t-1/records`
const link = { id: base, base, authorization: "Bearer test" }

const macHome = join(root, "mac-home")
const macRecords = join(root, "mac-records")
const mac = new SessionCatalog(["claude", "codex"].map((name) => fixtures.get(name).provider(macHome)), { recordsPath: macRecords, recordsHome: macHome, readBack: { readers: [], stores } })
const here = async (name, nativeId) => sessionIn(fixtures.get(name).provider(macHome), nativeId)
try {
  // Codex here is older than what wrote its session: refused, and Claude's, asked first, isn't written either.
  const refused = await mac.receiveRecords(link, sessions, { codex: { version: "0.0.1" } })
  assert.deepEqual(refused.map((each) => [each.harness, each.restored.kind]), [["codex", "outdated"], ["claude", "refused"]], JSON.stringify(refused))
  assert.match(refused[1].restored.reason, /Nothing was written here/)
  for (const { harness, nativeId } of sessions) {
    assert.equal(await here(harness, nativeId), undefined, `${harness}: nothing written into its store here`)
    const records = new RecordStore(macRecords, stores)
    assert.deepEqual(records.holdings(harness, nativeId), {}, `${harness}: nothing of it kept here, to be listed`)
    await records.close()
  }
  // Taken whole: each is written, where its harness here reads it.
  const taken = await mac.receiveRecords(link, sessions, {})
  assert.deepEqual(taken.map((each) => [each.harness, each.restored.kind]), [["claude", "restored"], ["codex", "restored"]], JSON.stringify(taken))
  for (const { harness, nativeId } of sessions) assert.ok(await here(harness, nativeId), `${harness}: its reader finds it here`)
  console.log("PASS: a receive writes every session or none: one its harness here can't take leaves no other written and nothing of them kept")
} finally {
  await mac.stop()
  await machine.close()
  server.close()
  await rm(root, { recursive: true, force: true })
}
