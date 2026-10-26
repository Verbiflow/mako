import assert from "node:assert/strict"
import { createServer } from "node:http"
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { encodeChunkPack } from "@mako/protocol/records"
import { SessionCatalog } from "../dist/catalog.js"
import { CursorProvider } from "../dist/providers/cursor.js"
import { cursorSdkStateRoot } from "../dist/providers/cursor-sdk-paths.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A receive writes each session where the harness here keeps it (`SessionProvider.recordRoots`), not at the place
 * under this home its root had under the sender's. A Mac host isolated in a data root inside its home (the moves
 * proof's, under `~/.mako/moves-e2e`) keeps its Cursor SDK agents in that root (`cursorSdkStateRoot`); a root kept so
 * once restored onto a machine under `.mako/thread-data/…/cursor`, which the machine's reader never looks at, and the
 * move was refused with "the harness doesn't list it". Coming back, an isolated host takes the agent into its own
 * root, never the person's `~/.mako/cursor-sdk`.
 */
const stores = new NativeStores(false)
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/native-decoding/cursor/pairs/stopped-shell/home/.mako/cursor-sdk")
const root = await mkdtemp(join(tmpdir(), "mako-receive-roots-"))
const macHome = join(root, "mac-home")
const macRoot = join(macHome, ".mako", "moves-e2e", "run-1", "host")
await cp(fixture, cursorSdkStateRoot(macRoot), { recursive: true })
const source = new CursorProvider(stores, macHome, macRoot)
const [file] = await source.discover()
const ref = await source.peek(file)
const mac = new RecordStore(join(root, "mac-records"), stores)
await mac.capture({ harness: "cursor", nativeId: ref.nativeId, home: macHome, records: await source.records(file.path) })

// The cloud's records routes a receive reads, served from the Mac's store.
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://cloud")
  if (url.pathname.endsWith("/sessions/pull")) {
    const bundle = Number(url.searchParams.get("after") ?? 0) > 0 ? null : mac.exportSession(url.searchParams.get("harness"), url.searchParams.get("nativeId"))
    if (!bundle) return void response.writeHead(404, { "content-type": "application/json" }).end("{}")
    return void response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ bundle, through: 1, more: false }))
  }
  if (url.pathname.endsWith("/chunks/read")) {
    let body = ""
    for await (const part of request) body += part
    const pack = []
    for (const hash of JSON.parse(body).hashes) {
      const chunk = await mac.readChunk(hash)
      if (chunk) pack.push({ hash, codec: chunk.codec, size: chunk.size, body: chunk.body })
    }
    return void response.writeHead(200, { "content-type": "application/octet-stream" }).end(Buffer.from(encodeChunkPack(pack)))
  }
  response.writeHead(404, { "content-type": "application/json" }).end("{}")
})
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
const base = `http://127.0.0.1:${server.address().port}/v1/threads/t-1/records`

// The machine's host names no SDK root: its reader keeps agents at <home>/.mako/cursor-sdk.
const machineHome = join(root, "machine-home")
await mkdir(machineHome, { recursive: true })
const machine = new SessionCatalog([new CursorProvider(stores, machineHome)], { recordsPath: join(root, "machine-records"), recordsHome: machineHome, readBack: { readers: [], stores } })
try {
  const [received] = await machine.receiveRecords({ id: base, base, authorization: "Bearer test" }, [{ harness: "cursor", nativeId: ref.nativeId }], {})
  assert.equal(received.restored.kind, "restored", JSON.stringify(received.restored))
  assert.ok(received.restored.path.startsWith(join(machineHome, ".mako", "cursor-sdk", "agents")), received.restored.path)
  assert.equal(existsSync(join(machineHome, ".mako", "moves-e2e")), false, "nothing written where the Mac kept its root")
  const listed = new CursorProvider(stores, machineHome)
  const [here] = await listed.discover()
  assert.equal((await listed.peek(here)).nativeId, ref.nativeId)

  // An isolated host receives into its own root: under its data root, outside its home, and nothing under the home's `.mako`.
  const isolatedHome = join(root, "isolated-home")
  const isolatedRoot = join(root, "isolated-data")
  await mkdir(isolatedHome, { recursive: true })
  const isolated = new SessionCatalog([new CursorProvider(stores, isolatedHome, isolatedRoot)], { recordsPath: join(isolatedRoot, "records"), recordsHome: isolatedHome, readBack: { readers: [], stores } })
  try {
    const [back] = await isolated.receiveRecords({ id: base, base, authorization: "Bearer test" }, [{ harness: "cursor", nativeId: ref.nativeId }], {})
    assert.equal(back.restored.kind, "restored", JSON.stringify(back.restored))
    assert.ok(back.restored.path.startsWith(join(cursorSdkStateRoot(isolatedRoot), "agents")), back.restored.path)
    assert.equal(existsSync(join(isolatedHome, ".mako")), false, "nothing written in the isolated host's home")
  } finally {
    await isolated.stop()
  }
  console.log("PASS: a receive writes a Cursor SDK agent into the SDK root the receiving host's reader keeps (a machine's ~/.mako, an isolated host's data root), wherever the sender kept its own")
} finally {
  await machine.stop()
  await mac.close()
  server.close()
  await rm(root, { recursive: true, force: true })
}
