import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import { visit } from "unist-util-visit"
import type { Root } from "hast"
import { markdownAnchorLine } from "../src/lib/markdown-headings"
import { inlineFileLinks } from "../src/lib/inline-file-links"
import { filePreviewIdentity } from "../src/lib/inline-file-links"
import { responseSections } from "../src/lib/exchanges"
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
  "src/app.ts",
])
const unrelated: string[] = []
const unrelatedTree = parseProse("Use `~/examples/` as an example.\n\n`report.xlsx`\n\n```txt\nshot.png\n```")
paths.length = 0
collectLinks(unrelatedTree)
unrelated.push(...paths)
assert.deepEqual(unrelated, [], "ordinary filenames and code samples never invent an asset directory")
assert.notDeepEqual(parseProse("**bold**"), parseProse("__ital__"))
const lists = parseProse("- Parent `docs/guide.md`\n  - Child `traces/requests.har`")
const listPaths: string[][] = []
visit(lists, "element", node => {
  if (node.tagName === "li") listPaths.push(inlineFileLinks(node))
})
assert.deepEqual(listPaths, [["docs/guide.md"], ["traces/requests.har"]], "Each list item discovers only its own previews")

// The reported T3 discussion names other repositories' files, not workspace paths.
const filenameDiscussion = "Their model list (`CursorProvider.ts`) renames the context option. `TraitsPicker.tsx`, `ContextWindowMeter.tsx`, `AcpAdapterV2.ts`, `sample.yas`, `README.md`, `guide.md#setup`, and `app.ts:42` are names.\n\n[Explicit file](app.ts:42) and [guide](guide.md#setup).\n\n`src/app.ts`\n\n```12:14:app.ts\nconst x = 1\n```"
paths.length = 0
collectLinks(parseProse(filenameDiscussion))
assert.deepEqual(paths, ["app.ts:42", "guide.md#setup", "src/app.ts", "app.ts#L12-L14"], "Only authored links, paths and native code citations carry file intent")
console.log(
  "Worker Markdown pipeline preserves heading IDs/source lines, lists, setext, GFM, references, code, citations, escaping, Unicode, incomplete syntax and immutable reuse"
)

// Group only adjacent asset-only paragraphs. The cached worker tree stays intact.
const { rehypeAssetGroups } = await import("../src/lib/markdown-asset-groups")
const { unified } = await import("unified")
const groupedSource = "Before.\n\n![first](one.png)\n\n[two.mp4](two.mp4)\n\nMiddle explanation.\n\n[report.xlsx](report.xlsx)\n\n[review.pptx](review.pptx)\n\nAfter."
const cachedAssets = parseProse(groupedSource)
const assetOriginal = structuredClone(cachedAssets)
const groupedAssets = unified().use(rehypeAssetGroups).runSync(structuredClone(cachedAssets))
const groups = groupedAssets.children.filter(node => node.type === "element" && node.properties.dataAssetGroup)
assert.equal(groups.length, 2)
assert.deepEqual(groups.map(node => node.type === "element" ? node.children.filter(child => child.type === "element").length : 0), [2, 2])
assert.deepEqual(cachedAssets, assetOriginal)
assert.equal(groupedAssets.children.filter(node => node.type === "element" && node.tagName === "p" && !node.properties.dataAssetGroup).length, 3)
const loneAssets = unified().use(rehypeAssetGroups).runSync(parseProse("[guide.md](guide.md#setup)\n\n[site](https://example.test)\n\nText with [image](one.png).\n\n[two.mp4](two.mp4)"))
assert.equal(loneAssets.children.some(node => node.type === "element" && node.properties.dataAssetGroup), false)
console.log("Asset groups stay beside their prose and preserve anchors, external links and cached trees")

// An explicit visual and its path citation must not mount the same file twice.
const screenshot = "/thread-data/selected-state/selected-state-after.png"
const duplicatedVisual = `Here's the rail.\n\n![Selected Cursor thread row, idle and hovered](${screenshot})\n\nThe file is at \`${screenshot}\`.\n\n- Keep [another image](/other/selected-state-after.png).\n- Keep [source](${screenshot}#L12).`
const visualTree = parseProse(duplicatedVisual)
const visualOriginal = structuredClone(visualTree)
const planned = unified().use(rehypeAssetGroups).runSync(structuredClone(visualTree))
const automatic: string[] = []
const visuals: string[] = []
visit(planned, "element", node => {
  if (node.tagName === "p" || node.tagName === "li") automatic.push(...inlineFileLinks(node))
  if (node.tagName === "img") visuals.push(String(node.properties.src))
})
assert.deepEqual(visuals, [screenshot])
assert.deepEqual(automatic, ["/other/selected-state-after.png"], "Distinct directories stay distinct; the repeated path becomes link-only")
const visualMarkup = renderToStaticMarkup(createElement(Markdown, {
  remarkPlugins: [skipMarkdownParse],
  rehypePlugins: [[reuseParsedProse, visualTree], rehypeAssetGroups],
}, duplicatedVisual))
assert.ok(visualMarkup.includes(`href="${screenshot}"`), "The readable path remains a link")
assert.ok(visualMarkup.includes(`href="${screenshot}#L12"`), "Line navigation survives")
assert.deepEqual(visualTree, visualOriginal, "Preview planning never mutates worker/cache inputs")
const nativeSource = "![Authored caption](./images/screen%20one.png)\n\nThe file is at `images/screen one.png`.\n\n[image](images/screen%20one.png)"
const nativeTree = parseProse(nativeSource)
const nativePlan = unified().use(rehypeAssetGroups, { previewedFiles: ["images/screen one.png"] }).runSync(structuredClone(nativeTree))
const nativePaths: string[] = []
visit(nativePlan, "element", node => {
  assert.notEqual(node.tagName, "img", "A file-backed native attachment owns its visual")
  if (node.tagName === "p") nativePaths.push(...inlineFileLinks(node))
})
assert.deepEqual(nativePaths, [])
assert.ok(renderToStaticMarkup(createElement(Markdown, {
  remarkPlugins: [skipMarkdownParse], rehypePlugins: [[reuseParsedProse, nativeTree], [rehypeAssetGroups, { previewedFiles: ["images/screen one.png"] }]],
}, nativeSource)).includes("Authored caption"), "Native deduplication keeps the authored caption as a link")
const independent = unified().use(rehypeAssetGroups).runSync(structuredClone(nativeTree))
assert.ok(independent.children.some(node => node.type === "element" && node.children.some(child => child.type === "element" && child.tagName === "img")), "Another reply with no native visual still renders the image")
const onlyPaths = unified().use(rehypeAssetGroups).runSync(parseProse("Here is `images/screen.png`."))
assert.deepEqual(onlyPaths.children.flatMap(node => node.type === "element" ? inlineFileLinks(node) : []), ["images/screen.png"], "A path without an explicit visual retains its preview")
assert.notEqual(filePreviewIdentity("images/link/../screen.png"), filePreviewIdentity("images/screen.png"), "Do not collapse parent traversal through a possible symlink")
const splitReply = responseSections([{ id: "native-reply", role: "assistant", blocks: [
  { type: "attachment", name: "screen.png", mimeType: "image/png", source: { kind: "file", path: screenshot } },
  { type: "text", text: duplicatedVisual },
] }, { id: "independent-reply", role: "assistant", blocks: [{ type: "text", text: duplicatedVisual }] }])
assert.deepEqual(splitReply.map(section => section.kind === "prose" ? section.previewedFiles : undefined), [[screenshot], [screenshot], undefined], "Native provenance survives section splitting without leaking to another message")
for (const path of ["video.mp4", "voice.wav", "report.xlsx", "report.pdf", "trace.har", "guide.md"]) {
  const plan = unified().use(rehypeAssetGroups, { previewedFiles: [path] }).runSync(parseProse(`The file is at \`${path}\`.`))
  assert.deepEqual(plan.children.flatMap(node => node.type === "element" ? inlineFileLinks(node) : []), [], `Native ${path} does not gain a second automatic preview`)
}
console.log("Explicit Markdown/native visuals keep one preview; path citations, distinct files, captions and isolated cache reuse survive")
