import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer, request } from "node:http"
import { randomUUID } from "node:crypto"
import { brotliCompressSync } from "node:zlib"
import { z } from "zod"
import { startWebHost } from "../electron/web-host.js"
import {
  invokeRuntime,
  runtimeRequest,
  RuntimeDisconnectedError,
} from "../electron/runtime-connection.js"
import type { RuntimeTransfer } from "../electron/runtime-response.js"

const root = await mkdtemp(join(tmpdir(), "mako-compressed-response-"))
const socket = join(root, "host.sock")
const payload = {
  image: "0123456789-東京-🐟 ".repeat(10_000),
  empty: "",
  no: false,
  zero: 0,
  absent: null,
}
const encoded = JSON.stringify({ ok: true, value: payload })
const host = await startWebHost(
  socket,
  async () => encoded,
  async () => new Response("")
)
async function raw(
  accept: string | undefined,
  channel = "mako:boot"
) {
  return new Promise<{ encoding?: string; bytes: Buffer }>(
    (resolve, reject) => {
      const req = request(
        {
          socketPath: socket,
          path: "/rpc",
          method: "POST",
          headers: accept ? { "accept-encoding": accept } : {},
        },
        (response) => {
          const chunks: Buffer[] = []
          response.on("data", (chunk) => chunks.push(chunk))
          response.on("error", reject)
          response.on("end", () =>
            resolve({
              encoding: response.headers["content-encoding"],
              bytes: Buffer.concat(chunks),
            })
          )
        }
      )
      req.on("error", reject)
      req.end(JSON.stringify({ channel, args: [] }))
    }
  )
}
try {
  const compressed = { bytes: brotliCompressSync(Buffer.from(encoded)) }
  for (const accept of [undefined, "identity", "br", "br;q=0"]) {
    const value = await raw(accept)
    assert.equal(value.encoding, undefined)
    assert.equal(value.bytes.toString(), encoded, "Ordinary RPC replies retain exact JSON values")
  }
  const transfers: RuntimeTransfer[] = []
  assert.deepEqual(
    await invokeRuntime(socket, randomUUID(), "mako:boot", [], 1, {
      onTransfer: (value) => transfers.push(value),
    }),
    payload
  )
  assert.equal(transfers[0]!.decodedBytes, Buffer.byteLength(encoded))
  assert.equal(transfers[0]!.wireBytes, Buffer.byteLength(encoded))
  assert.deepEqual(
    await invokeRuntime(socket, randomUUID(), "mako:boot", [], 1, {
      onTransfer: () => {
        throw new Error("observer failed")
      },
    }),
    payload,
    "Telemetry cannot alter a successful read"
  )

  const corruptSocket = join(root, "corrupt.sock")
  const bomb = brotliCompressSync(Buffer.alloc(33 * 1024 * 1024, 65))
  let replies = 0
  const bad = createServer((req, response) => {
    replies++
    const mode = req.headers["x-mako-window"]
    response.writeHead(200, {
      "content-encoding": mode === "unsupported" ? "gzip" : "br",
    })
    response.end(
      mode === "bomb"
        ? bomb
        : mode === "valid" ? compressed.bytes : mode === "truncated"
          ? compressed.bytes.subarray(0, -1)
          : Buffer.from("bad pixels")
    )
  })
  await new Promise<void>((resolve) => bad.listen(corruptSocket, resolve))
  try {
    assert.deepEqual(await runtimeRequest({ socket: corruptSocket, path: "/rpc", client: "valid", schema: z.json() }), JSON.parse(encoded), "Legacy compressed host reply remains readable")
    for (const mode of ["malformed", "truncated", "bomb", "unsupported"]) {
      await assert.rejects(
        runtimeRequest({
          socket: corruptSocket,
          path: "/rpc",
          client: mode,
          schema: z.json(),
        }),
        (error) =>
          error instanceof RuntimeDisconnectedError && error.unconfirmed
      )
    }
    assert.equal(replies, 5, "Invalid accepted responses are never retried")
  } finally {
    bad.close()
    bad.closeAllConnections()
  }
  console.log(
    "Runtime replies: exact ordinary JSON, bounded legacy decompression, byte diagnostics, malformed/truncated refusal and no replay passed"
  )
} finally {
  host.close()
  await rm(root, { recursive: true, force: true })
}
