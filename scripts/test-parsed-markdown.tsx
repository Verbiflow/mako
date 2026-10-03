import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import { visit } from "unist-util-visit"
import type { Root } from "hast"
import { markdownAnchorLine } from "../src/lib/markdown-headings"
import { inlineFileLinks } from "../src/lib/inline-file-links"
import {
  parseProse,
  prosePlugins,
  reuseParsedProse,
  skipMarkdownParse,
} from "../src/lib/parsed-markdown"

const cases = [
  "Heading\n=======\n\nParagraph **bold** and _emphasis_.",
  "- first\n\n  second paragraph\n\n  - nested\n\n- second\n\nAfter list.",
  "| A | B |\n|---|---|\n| one | two |\n\n- [x] done\n- [ ] pending",
  "A [reference][target] and note[^1].\n\n[target]: https://example.test\n\n[^1]: Endnote with **formatting**.",
  "```typescript\nconst text = '[example](javascript:alert(1))'\n```\n\n`src/app.ts:42`\n\n```12:14:src/app.ts\nconst x = 1\n```",
  "<script>alert(1)</script>\n\n[bad](javascript:alert(1)) ![bad](data:text/html,hello)",
  "A hanging **marker and [unfinished](https://example.test",
  "\u{1D49C} 中文 café\n\n> Quoted text\n>\n> second paragraph",
  "# Heading\n\n## Heading\n\n### Heading-1\n\n## Heading\n\n> # **Nested** `code`\n\n- ### List heading\n\n```md\n# Not a heading\n```",
  "Setext\n------\n\n## 中文 café\n\n# 中文 café",
]
for (const text of cases) {
  const tree = parseProse(text)
  const original = structuredClone(tree)
  const expected = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: prosePlugins() }, text)
  )
  for (let count = 0; count < 2; count++) {
    const actual = renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: [skipMarkdownParse], rehypePlugins: [[reuseParsedProse, tree]] }, text)
    )
    assert.equal(actual, expected)
    assert.deepEqual(
      tree,
      original,
      "React Markdown postprocessing must not mutate the cached worker tree"
    )
  }
}
// Keep independent expectations: sharing the production plugin roster must
// not allow both rendering paths to silently lose heading navigation metadata.
const headings = cases[8]!
const headingMarkup = renderToStaticMarkup(createElement(Markdown, {
  remarkPlugins: [skipMarkdownParse],
  rehypePlugins: [[reuseParsedProse, parseProse(headings)]],
}, headings))
for (const [level, id, line] of [
  [1, "heading", 1],
  [2, "heading-1", 3],
  [3, "heading-1-1", 5],
  [2, "heading-2", 7],
  [1, "nested-code", 9],
  [3, "list-heading", 11],
] as const) {
  assert.ok(headingMarkup.includes(`<h${level} id="${id}" data-source-line="${line}">`))
  assert.equal(markdownAnchorLine(headings, id), line)
}
assert.equal(markdownAnchorLine(headings, "not-a-heading"), undefined)
assert.equal(markdownAnchorLine(cases[9]!, "setext"), 1)
assert.equal(markdownAnchorLine(cases[9]!, "中文-café-1"), 6)
// Explicit output-directory context must reach filenames; globs are not files.
const outputProse = "Files are in `~/.mako/thread-data/run/tool-row-options/`:\n\n- `0-today-codex-claude.jpg`, `0-today-cursor-grok.jpg`\n- `1-option-a-ledger-*.jpg`\n- `tool-rows-interactions.mp4`\n- `src/app.ts`\n\n## Another section\n\n`elsewhere.png`"
const paths: string[] = []
const outputTree = parseProse(outputProse)
const collectLinks = (tree: Root): void => {
  visit(tree, "element", (node) => {
    if (node.tagName === "a") paths.push(String(node.properties.href))
  })
}
collectLinks(outputTree)
assert.deepEqual(paths, [
  "~/.mako/thread-data/run/tool-row-options/0-today-codex-claude.jpg",
  "~/.mako/thread-data/run/tool-row-options/0-today-cursor-grok.jpg",
  "~/.mako/thread-data/run/tool-row-options/tool-rows-interactions.mp4",
  "src/app.ts", "elsewhere.png",
])
const unrelated: string[] = []
const unrelatedTree = parseProse("Use `~/examples/` as an example.\n\n`report.xlsx`\n\n```txt\nshot.png\n```")
paths.length = 0
collectLinks(unrelatedTree)
unrelated.push(...paths)
assert.deepEqual(unrelated, ["report.xlsx"], "ordinary prose and code samples never invent an asset directory")
assert.notDeepEqual(parseProse("**bold**"), parseProse("__ital__"))
const lists = parseProse("- Parent `guide.md`\n  - Child `requests.har`")
const listPaths: string[][] = []
visit(lists, "element", node => {
  if (node.tagName === "li") listPaths.push(inlineFileLinks(node))
})
assert.deepEqual(listPaths, [["guide.md"], ["requests.har"]], "Each list item discovers only its own previews")
console.log(
  "Worker Markdown pipeline preserves heading IDs/source lines, lists, setext, GFM, references, code, citations, escaping, Unicode, incomplete syntax and immutable reuse"
)
