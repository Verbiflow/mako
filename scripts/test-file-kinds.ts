import assert from "node:assert/strict"
import { fileGlyph } from "../src/lib/file-kinds.ts"

/*
 * Which mark a file wears (`FileIcon`), by its name and the type it came with: a language's letters or a kind's
 * shape by name, a type that names what the file holds when the name doesn't, and the name again when the type says
 * nothing (`application/octet-stream`), as the preview formats read it.
 */

const mark = (path: string, mimeType?: string) => {
  const glyph = fileGlyph(path, mimeType)
  return glyph.kind === "letters" ? `letters:${glyph.text}` : glyph.name
}

assert.equal(mark("src/view.tsx"), "letters:TSX", "a language by its name")
assert.equal(mark("README.md"), "readme", "a kind by its name")
assert.equal(mark("pasted", "image/png"), "image", "a file its name doesn't place, by its type")
assert.equal(mark("upload", "application/pdf"), "document")
assert.equal(mark("network.har"), "profile", "a diagnostic recording")

// A type that says nothing leaves the name to say what the file holds.
for (const [path, expected] of [["photo.tif", "image"], ["voice.opus", "audio"], ["movie.m4v", "video"]] as const) {
  assert.equal(mark(path, "application/octet-stream"), expected, `${path} sent as application/octet-stream`)
  assert.equal(mark(path), expected, `${path} with no type`)
}
assert.equal(mark("blob.bin", "application/octet-stream"), "binary", "and a name that says nothing more is what it is")

console.log("file kinds: ok")
