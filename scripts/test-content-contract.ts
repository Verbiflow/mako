import assert from "node:assert/strict"
import type { Root } from "mdast"
import { remarkFileCitations } from "../src/lib/citation-markdown.ts"
import { markdownFileTarget } from "../src/lib/file-citations.ts"
const literal = "【F:src/example.ts†L12-L18】"
const code = { type: "code" as const, lang: "text", value: literal }
const inline = { type: "inlineCode" as const, value: literal }
const link = {
  type: "link" as const,
  url: "https://example.com",
  children: [{ type: "text" as const, value: literal }],
}
const snippet = {
  type: "link" as const,
  url: "file:///work/notes.md",
  children: [{ type: "text" as const, value: "notes.md:2-4" }],
}
const named = {
  type: "link" as const,
  url: "file:///work/notes.md",
  children: [{ type: "text" as const, value: "other.md:2" }],
}
const tree: Root = {
  type: "root",
  children: [
    {
      type: "paragraph",
      children: [{ type: "text", value: literal }, inline, link, snippet, named],
    },
    code,
    { type: "code", lang: "12:18:src/example.ts", value: "const value = 1" },
  ],
}
remarkFileCitations()(tree)
assert.equal(code.value, literal)
assert.equal(inline.value, literal)
assert.equal(link.children[0]?.value, literal)
assert.equal(
  tree.children[0]?.type === "paragraph" && tree.children[0].children[0]?.type,
  "link"
)
assert.ok(JSON.stringify(tree).includes("src/example.ts#L12-L18"))
assert.deepEqual(markdownFileTarget(snippet.url), { path: "/work/notes.md", line: 2, endLine: 4 }, "Devin's `<ref_snippet>` link takes its label's lines")
assert.equal(named.url, "file:///work/notes.md", "a label naming another file is not a line range")
for (const target of [
  "/work/src/example.ts:12",
  "src/example.ts#L12-L18",
  "file:///work/src/example.ts:12",
  "vscode://file/work/src/example.ts:12",
])
  assert.equal(markdownFileTarget(target)?.line, 12, target)
console.log(
  "Provider citations preserve literal code and resolve file URLs, editor links, line suffixes, Devin's labelled snippets, and Cursor code ranges"
)
