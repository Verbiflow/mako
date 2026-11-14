import assert from "node:assert/strict"
import { createPackage } from "@electron/asar"
import { readdirSync, statSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { finished } from "node:stream/promises"
import { readLocalAppMetadata } from "./local-app-metadata.mjs"
import { packArchive } from "./lib/pack-archive.mjs"

// An archive a test packs is whole the moment the pack resolves, and replaces what was at its path in one step:
// test-update-local read one before its writes had landed and parsed zeros (run 43578048397, gate 9).
// `PACK_WITH=createPackage` runs the same loop on @electron/asar's own createPackage, which fails it.
const raw = process.env.PACK_WITH === "createPackage"
const runs = Number(process.env.RUNS ?? 200)
const root = await mkdtemp(join(tmpdir(), "mako-pack-archive-"))
try {
  const app = join(root, "swapped.app")
  const resources = join(app, "Contents/Resources")
  await mkdir(resources, { recursive: true })
  const archive = join(resources, "app.asar")
  let unwritten = 0
  for (let index = 0; index < runs; index += 1) {
    const input = await mkdtemp(join(root, "payload-"))
    await writeFile(join(input, "a-padding.txt"), "x".repeat(1000))
    await writeFile(join(input, "package.json"), JSON.stringify({ makoDistribution: "local", makoBuild: { id: `build-${index}` } }))
    let pending = 0
    if (raw) {
      const stream = await createPackage(input, archive)
      if (!stream.writableFinished) pending = 1
      await finished(stream)
    } else await packArchive(input, archive)
    unwritten += pending
    // Read at once, as an updater verifying what it just installed does.
    assert.deepEqual(readLocalAppMetadata(app), { makoDistribution: "local", makoBuild: { id: `build-${index}` } })
    assert.ok(statSync(archive).size > 1000)
  }
  assert.deepEqual(readdirSync(resources), ["app.asar"], "no partial archive is left beside it")
  assert.equal(unwritten, 0, `the archive was still being written when the pack resolved in ${unwritten} of ${runs} runs`)
  console.log(`pack archive: whole when the pack resolved in ${runs} of ${runs} runs`)
} finally {
  await rm(root, { recursive: true, force: true })
}
