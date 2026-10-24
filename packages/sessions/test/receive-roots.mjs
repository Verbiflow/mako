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
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"

/**
 * A receive writes each session where the harness here keeps it (`SessionProvider.recordRoots`), not at the place
 * under this home its root had under the sender's. A Mac whose Cursor SDK root was moved inside its home
 * (`MAKO_CURSOR_SDK_ROOT`, as the moves proof's packaged app sets it) once restored onto a machine under
 * `.mako/thread-data/…/cursor`, which the machine's reader never looks at, and the move was refused with "the harness
 * doesn't list it".
 */
const stores = new NativeStores(false)
const fixture = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/native-decoding/cursor/pairs/stopped-shell/home/.mako/cursor-sdk")
const root = await mkdtemp(join(tmpdir(), "mako-receive-roots-"))
const macHome = join(root, "mac-home")
const macSdk = join(macHome, ".mako", "thread-data", "proof", "cursor")
await cp(fixture, macSdk, { recursive: true })
const source = new CursorProvider(stores, macHome, { MAKO_CURSOR_SDK_ROOT: macSdk })
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
const machine = new SessionCatalog([new CursorProvider(stores, machineHome, {})], { recordsPath: join(root, "machine-records"), recordsHome: machineHome, readBack: { readers: [], stores } })
try {
  const [received] = await machine.receiveRecords({ id: base, base, authorization: "Bearer test" }, [{ harness: "cursor", nativeId: ref.nativeId }], {})
  assert.equal(received.restored.kind, "restored", JSON.stringify(received.restored))
  assert.ok(received.restored.path.startsWith(join(machineHome, ".mako", "cursor-sdk", "agents")), received.restored.path)
  assert.equal(existsSync(join(machineHome, ".mako", "thread-data")), false, "nothing written where the Mac kept its root")
  const listed = new CursorProvider(stores, machineHome, {})
  const [here] = await listed.discover()
  assert.equal((await listed.peek(here)).nativeId, ref.nativeId)
  console.log("PASS: a receive writes a Cursor SDK agent into the SDK root the machine's reader keeps, wherever the sender kept its own")
} finally {
  await machine.stop()
  await mac.close()
  server.close()
  await rm(root, { recursive: true, force: true })
}
