import { fileMedia } from "../electron/file-media.js"
import assert from "node:assert/strict"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileResponse } from "../electron/file-response.js"
const root = await mkdtemp(join(tmpdir(), "mako-range-"))
const path = join(root, "media.bin")
await writeFile(path, "0123456789")
const read = (range: string) =>
  fileResponse(
    new Response(null, {
      headers: { "content-type": "application/octet-stream" },
    }),
    path,
    new Request("http://local/media", { headers: { range } })
  )
try {
  const partial = await read("bytes=2-5")
  assert.equal(partial.status, 206)
  assert.equal(partial.headers.get("content-range"), "bytes 2-5/10")
  assert.equal(partial.headers.get("content-length"), "4")
  assert.equal(await partial.text(), "2345")
  assert.equal(await (await read("bytes=-3")).text(), "789")
  assert.equal(await (await read("bytes=7-")).text(), "789")
  assert.equal(await (await read("bytes=7-99")).text(), "789")
  for (const range of [
    "bytes=10-",
    "bytes=6-2",
    "bytes=-0",
    "bytes=-",
    "bytes=1-2,4-5",
    "bytes=99999999999999999999-",
  ])
    assert.equal((await read(range)).status, 416)
  const image = join(root, "extensionless-asset")
  await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXZkAAAAASUVORK5CYII=", "base64"))
  for (const range of [undefined, "bytes=0-7"]) {
    const response = await fileResponse(new Response(null, {headers:{"content-type":"application/octet-stream"}}), image, new Request("http://local/image", range ? {headers:{range}} : undefined))
    assert.equal(response.headers.get("content-type"), "image/png", "extensionless assets serve their actual MIME even for ranges")
    await response.body?.cancel()
  }
  console.log(
    "File media: exact byte ranges, suffixes, open ends and invalid ranges verified against an actual file"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}

assert.equal((await fileMedia("photo.heic", Buffer.from([0,0,0,20,102,116,121,112,104,101,105,99])))?.mimeType, "image/heic")
assert.equal((await fileMedia("audio.m4a", Buffer.from([0,0,0,20,102,116,121,112,105,115,111,109])))?.media, "audio")
