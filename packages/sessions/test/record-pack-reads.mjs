import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Packs } from "../dist/record-chunks.js"

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
