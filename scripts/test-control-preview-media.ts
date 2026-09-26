import assert from "node:assert/strict"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { setTimeout as delay } from "node:timers/promises"
import {
  encodePreviewMedia,
  decodePreviewMedia,
  collectPreviewMedia,
  PREVIEW_MEDIA_TYPE,
  PREVIEW_PACKET_LIMIT,
  type ControlPreview,
} from "@mako/control-runtime/contracts"
import { startWebHost } from "../electron/web-host.js"
import {
  invokeRuntimePreview,
  invokeRuntime,
} from "../electron/runtime-connection.js"

const preview: ControlPreview = {
  activity: {
    conversationId: "fixture",
    kind: "browser",
    operation: "observe",
    target: "Owned tab",
    status: "running",
    updatedAt: 123,
  },
  frame: {
    id: randomUUID(),
    capturedAt: 120,
    publishedAt: 123,
    sequence: 42,
    image: { mimeType: "image/jpeg", bytes: randomBytes(700_000) },
  },
}
const encode = (value: ControlPreview | null) => {
  const { header, bytes } = encodePreviewMedia(value)
  return Buffer.concat([header, bytes])
}
const packet = encode(preview)
assert.ok(
  packet.length < preview.frame!.image.bytes.length + 1024,
  "Metadata stays small; image bytes do not expand"
)
const decoded = decodePreviewMedia(Uint8Array.from(packet))
assert.deepEqual(
  Buffer.from(decoded!.frame!.image.bytes),
  preview.frame!.image.bytes
)
assert.equal(decoded!.frame!.capturedAt, 120)
assert.equal(decoded!.frame!.publishedAt, 123)
assert.equal(decoded!.frame!.sequence, 42, "The source sequence reaches web viewers")
assert.equal(decodePreviewMedia(encode(null)), null)
assert.deepEqual(decodePreviewMedia(encode({ ...preview, frame: null })), {
  ...preview,
  frame: null,
})
const embedded = Uint8Array.from(
  Buffer.concat([Buffer.alloc(7), packet, Buffer.alloc(9)])
)
assert.deepEqual(
  decodePreviewMedia(embedded.subarray(7, -9)),
  decoded,
  "Nonzero byte offsets survive framing"
)
for (const bytes of [
  packet.subarray(0, 8),
  packet.subarray(0, -1),
  Buffer.concat([packet, Buffer.from([0])]),
])
  assert.throws(() => decodePreviewMedia(bytes))
for (const [offset, value] of [
  [0, 0],
  [4, 999999],
  [8, 9999999],
]) {
  const bad = Buffer.from(packet)
  bad.writeUInt32BE(value!, offset!)
  assert.throws(() => decodePreviewMedia(bad))
}
assert.throws(() =>
  encodePreviewMedia({
    ...preview,
    frame: {
      ...preview.frame!,
      image: { mimeType: "image/jpeg", bytes: new Uint8Array(3 * 1024 * 1024) },
    },
  })
)
assert.throws(() =>
  encodePreviewMedia({
    ...preview,
    activity: {
      ...preview.activity,
      target: "界".repeat(4096),
      conversationId: "界".repeat(1024),
      operation: "界".repeat(1024),
    },
  })
)
const chunks = async function* () {
  for (let i = 0; i < packet.length; i += 8191)
    yield packet.subarray(i, i + 8191)
}
assert.deepEqual((await collectPreviewMedia(chunks())).preview, decoded)
for (const width of [1, 7, 12, 13]) {
  const tiny = encode({ ...preview, frame: null })
  const parts = (async function* () {
    for (let at = 0; at < tiny.length; at += width)
      yield tiny.subarray(at, at + width)
  })()
  assert.deepEqual((await collectPreviewMedia(parts)).preview, { ...preview, frame: null })
}
for (const invalid of [packet.subarray(0, 8), packet.subarray(0, -1), Buffer.concat([packet, Buffer.from([1])])])
  await assert.rejects(collectPreviewMedia((async function* () { yield invalid })()))
let readPastHeader = false
await assert.rejects(collectPreviewMedia((async function* () {
  yield new Uint8Array(12)
  readPastHeader = true
  yield packet
})()), /framing/)
assert.equal(readPastHeader, false, "Invalid prefixes fail before reading image bytes")
let cancelled = false
await assert.rejects(
  collectPreviewMedia(
    (async function* () {
      try {
        yield new Uint8Array(PREVIEW_PACKET_LIMIT + 1)
        throw new Error("Must not read past limit")
      } finally {
        cancelled = true
      }
    })()
  ),
  /byte limit/
)
assert.ok(cancelled, "Oversized response cancels its source")

const root = await mkdtemp(join(tmpdir(), "mako-preview-media-"))
const socket = join(root, "host.sock"),
  client = randomUUID()
let allowed = true,
  reads = 0,
  held = 0
let release!: () => void
const gate = new Promise<void>((resolve) => {
  release = resolve
})
const host = await startWebHost(
  socket,
  async () => JSON.stringify({ ok: true, value: "ordinary RPC" }),
  async () => new Response(""),
  undefined,
  undefined,
  async (args, owner) => {
    assert.match(owner, /^web:/)
    if (!allowed) throw new Error("Target ownership revoked")
    reads++
    if (args[0] === "held") {
      held++
      await gate
    }
    return preview
  }
)
try {
  const transfers: {
    encoding: string
    wireBytes: number
    decodedBytes: number
  }[] = []
  const result = await invokeRuntimePreview(
    socket,
    client,
    ["fixture", true, "viewer"],
    (value) => transfers.push(value)
  )
  assert.deepEqual(result, decoded)
  assert.equal(transfers[0]!.encoding, "binary")
  assert.equal(transfers[0]!.wireBytes, packet.length)
  assert.equal(transfers[0]!.decodedBytes, packet.length)
  assert.equal(
    await invokeRuntime(socket, client, "mako:boot", []),
    "ordinary RPC",
    "Non-media RPC stays JSON"
  )
  allowed = false
  await assert.rejects(
    invokeRuntimePreview(socket, client, ["fixture"]),
    /ownership revoked/
  )
  assert.equal(reads, 1, "Refused target cannot supply pixels")
  allowed = true
  const waiting = [
    invokeRuntimePreview(socket, client, ["held"]),
    invokeRuntimePreview(socket, client, ["held"]),
  ]
  for (const promise of waiting) void promise.catch(() => {})
  const deadline = Date.now() + 2000
  while (held < 2 && Date.now() < deadline) await delay(5)
  assert.equal(held, 2)
  await assert.rejects(
    invokeRuntimePreview(socket, client, ["fixture"]),
    /busy/
  )
  assert.deepEqual(
    await invokeRuntimePreview(socket, randomUUID(), ["fixture"]),
    decoded,
    "A slow viewer cannot stall another client"
  )
  release()
  await Promise.all(waiting)
  assert.deepEqual(
    await invokeRuntimePreview(socket, client, ["fixture"]),
    decoded,
    "Reply slots release after completion"
  )
} finally {
  release()
  host.close()
}

// A host closing before a pending read finishes must send a typed restart reply.
const closingSocket = join(root, "closing.sock")
let entered = false,
  finish!: () => void
const pendingRead = new Promise<void>((resolve) => {
  finish = resolve
})
const closing = await startWebHost(
  closingSocket,
  async () => "",
  async () => new Response(""),
  undefined,
  undefined,
  async () => {
    entered = true
    await pendingRead
    return preview
  }
)
const interrupted = invokeRuntimePreview(closingSocket, client, [])
void interrupted.catch(() => {})
while (!entered) await delay(5)
closing.close()
await assert.rejects(interrupted, /reconnect|restart/i)
finish()

const oldSocket = join(root, "old.sock")
const old = await startWebHost(
  oldSocket,
  async () => JSON.stringify({ ok: true, value: preview }),
  async () => new Response("")
)
try {
  await assert.rejects(
    invokeRuntimePreview(oldSocket, client, []),
    /newer Mako host/
  )
} finally {
  old.close()
}

const badSocket = join(root, "bad.sock")
const bad = createServer((_request, response) => {
  response.writeHead(200, { "content-type": PREVIEW_MEDIA_TYPE })
  response.end(packet.subarray(0, -1))
})
await new Promise<void>((resolve) => bad.listen(badSocket, resolve))
try {
  await assert.rejects(invokeRuntimePreview(badSocket, client, []), /Truncated preview response/)
} finally {
  bad.close()
  bad.closeAllConnections()
}
await rm(root, { recursive: true, force: true })
console.log(
  "Binary preview: exact bytes, clocks, framing/size limits, cancellation, owner refusal, slow-client isolation, compatibility refusal and ordinary RPC passed"
)
