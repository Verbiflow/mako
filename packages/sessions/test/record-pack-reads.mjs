import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { constants, zstdCompressSync } from "node:zlib"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { Chunker, Packs } from "../dist/record-chunks.js"
import { RecordStore } from "../dist/record-store.js"
import { frameLength } from "../dist/zstd-frames.js"

/**
 * Reads of a pack never meet a handle closed under them: the pack being written is read by a handle of its own,
 * which survives its writer letting go (another process started a newer pack, as Mako's hosts sharing one store do),
 * and a reader dropped or closed while reads are in flight closes once they end. A move's records send once failed
 * with "file closed" this way.
 */
const folder = await mkdtemp(join(tmpdir(), "mako-pack-reads-"))
try {
  const packs = new Packs(folder)
  const chunks = []
  for (let index = 0; index < 64; index++) {
    const bytes = Buffer.from(`chunk ${index} `.repeat(500 + index))
    chunks.push({ bytes, place: await packs.write(createHash("sha256").update(bytes).digest(), bytes) })
  }
  await packs.sync()
  for (let round = 0; round < 20; round++) {
    // Reads in flight, then the writer lets go: another process wrote a newer pack.
    const reads = chunks.map(({ place }) => packs.read(place))
    await writeFile(join(folder, `${String(1000 + round).padStart(8, "0")}.pack`), "")
    await packs.begin()
    const read = await Promise.all(reads)
    read.forEach((bytes, index) => assert.ok(bytes.equals(chunks[index].bytes), `chunk ${index} read whole`))
    // And a drop while reads are in flight: they finish on the handle they started on.
    const again = chunks.map(({ place }) => packs.read(place))
    await packs.drop(chunks[0].place.pack)
    ;(await Promise.all(again)).forEach((bytes, index) => assert.ok(bytes.equals(chunks[index].bytes)))
  }
  await packs.close()
  console.log("PASS: a pack's reads never meet a handle closed under them: its writer letting go, a drop or a close waits for them")
} finally {
  await rm(folder, { recursive: true, force: true })
}

/**
 * A chunk whose zstd frame ends exactly where zlib's output buffer does (16 KiB) is stored as that one frame, and its
 * session reads back. zlib asks the encoder again at a full buffer, and zstd answers a frame already ended with an
 * empty one, 9 bytes: such a chunk was stored as its frame and an empty frame after it, by every build (the one-shot
 * `zstdCompressSync` does it too), and since frames were read strictly reading its session threw (`A zstd frame of
 * 10850 bytes, with 9 more after it`, in a CI run of record-orphans.mjs, whose random transcripts met it by chance).
 * Those chunks are in stores on disk; they read whole.
 */
const sha = (bytes) => createHash("sha256").update(bytes).digest()
const LEVEL = { params: { [constants.ZSTD_c_compressionLevel]: 3 } }
/** Transcript-like bytes that chunk as one chunk, whose frame is exactly zlib's output buffer long. */
function filling() {
  for (let seed = 0; ; seed++) {
    let text = ""
    for (let line = 0; text.length < 32_000; line++) text += `${JSON.stringify({ type: "assistant", text: [0, 1, 2].map((n) => sha(`${seed}:${line}:${n}`).toString("base64")).join(" ") })}\n`
    const frame = (length) => frameLength(zstdCompressSync(Buffer.from(text.slice(0, length)), LEVEL))
    // The shortest prefix whose frame reaches the buffer's length, then whether it is exactly that long.
    let [low, high] = [4096, text.length]
    while (low < high) {
      const middle = (low + high) >> 1
      if (frame(middle) < constants.Z_DEFAULT_CHUNK) low = middle + 1
      else high = middle
    }
    if (frame(low) !== constants.Z_DEFAULT_CHUNK) continue
    const bytes = Buffer.from(text.slice(0, low))
    const chunker = new Chunker()
    if ([...chunker.push(bytes), ...chunker.end()].length === 1) return bytes
  }
}
const root = await mkdtemp(join(tmpdir(), "mako-pack-frames-"))
try {
  const bytes = filling()
  // A capture into a new store: the chunk is the first frame its context makes, so it ends at the buffer's end.
  const home = join(root, "home")
  await mkdir(home)
  await writeFile(join(home, "filling.jsonl"), bytes)
  const store = new RecordStore(join(root, "store"), new NativeStores(true))
  const records = { roots: [{ name: "fixture", path: home }], files: [join(home, "filling.jsonl")], databases: [] }
  const report = await store.capture({ harness: "fixture", nativeId: "filling", home, records })
  assert.equal(report.newChunks, 1, "the session is one chunk")
  assert.equal(report.storedBytes, constants.Z_DEFAULT_CHUNK, "stored as its one frame, nothing after it")
  const parts = []
  for (const unit of store.units("fixture", "filling")) for await (const part of store.content("fixture", unit.key)) parts.push(part)
  assert.ok(Buffer.concat(parts).equals(bytes), "its session reads back whole")
  assert.deepEqual(await store.verify(), [])
  await store.close()

  // As stores on disk hold it: the frame, then the empty frame zlib asked for.
  const packs = new Packs(join(root, "written-before"))
  const body = zstdCompressSync(bytes, LEVEL)
  assert.equal(body.length, constants.Z_DEFAULT_CHUNK + 9, "the one-shot encoder writes the empty frame too")
  const place = await packs.writeStored(sha(bytes), { codec: 1, size: bytes.length, body })
  await packs.sync()
  assert.ok((await packs.read(place)).equals(bytes), "a chunk stored with an empty frame after its frame reads whole")
  await packs.close()
  console.log("PASS: a chunk whose frame fills zlib's output buffer is stored as one frame; one stored with an empty frame after it reads")
} finally {
  await rm(root, { recursive: true, force: true })
}
