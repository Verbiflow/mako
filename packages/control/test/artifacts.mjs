import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { INLINE_TEXT_BUDGET, INLINE_TOTAL_BUDGET, artifactFileName, outlineOf, spillJson } from "../dist/program/index.js"

// About 10 K tokens inline, never a whole window state by accident.
assert.equal(INLINE_TEXT_BUDGET, 40_000)
assert.equal(INLINE_TOTAL_BUDGET, 60_000)
assert.match(artifactFileName("../../etc/passwd", "json"), /^passwd-[0-9a-f]{8}\.json$/)
assert.match(artifactFileName("", "png"), /^artifact-[0-9a-f]{8}\.png$/)
const outline = outlineOf({ elements: [{ role: "AXButton" }, { role: "AXLink" }], title: "x".repeat(300), n: 3, ok: true, none: null })
assert.equal(outline.type, "object")
assert.deepEqual(outline.keys.map((k) => [k.name, k.type]), [["elements", "array"], ["title", "string"], ["n", "number"], ["ok", "boolean"], ["none", "null"]])
const directory = await mkdtemp(join(tmpdir(), "mako-control-artifacts-"))
try {
  const receipt = await spillJson(directory, "computer-result", { big: "y".repeat(50_000) })
  assert.equal(receipt.artifact, true)
  assert.equal(receipt.kind, "json")
  assert.equal(receipt.outline.keys[0].name, "big")
  assert.equal(JSON.parse(await readFile(receipt.path, "utf8")).big.length, 50_000)
  assert.match(receipt.sha256, /^[0-9a-f]{64}$/)
} finally {
  await rm(directory, { recursive: true, force: true })
}
console.log("artifacts ok")
