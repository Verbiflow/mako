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
/** Images as the transcript draws them: one the sanitizer emptied (a `data:` URL) is its words, never `<img src="">`. */
const components = {
  img: ({ src, alt }: { src?: string; alt?: string }) => (src ? createElement("img", { src, alt }) : createElement("span", null, alt)),
}
for (const text of cases) {
  const tree = parseProse(text)
  const original = structuredClone(tree)
  const expected = renderToStaticMarkup(
    createElement(Markdown, { remarkPlugins: prosePlugins(), components }, text)
  )
  for (let count = 0; count < 2; count++) {
    const actual = renderToStaticMarkup(
      createElement(Markdown, { remarkPlugins: [skipMarkdownParse], rehypePlugins: [[reuseParsedProse, tree]], components }, text)
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
// A bare name links only when the host finds a file this Thread touched by it.
const bare: string[] = []
const outputTree = parseProse(outputProse)
const collectLinks = (tree: Root): void => {
  visit(tree, "element", (node) => {
    if (node.tagName !== "a") return
    if (node.properties.dataBareFile) bare.push(String(node.properties.href))
    else paths.push(String(node.properties.href))
  })
}
collectLinks(outputTree)
assert.deepEqual(paths, [
  "~/.mako/thread-data/run/tool-row-options/0-today-codex-claude.jpg",
  "~/.mako/thread-data/run/tool-row-options/0-today-cursor-grok.jpg",
  "~/.mako/thread-data/run/tool-row-options/tool-rows-interactions.mp4",
  "src/app.ts",
])
assert.deepEqual(bare, ["elsewhere.png"], "a filename outside the output folder is left for the host to resolve")
const unrelated: string[] = []
const unrelatedTree = parseProse("Use `~/examples/` as an example.\n\n`report.xlsx`\n\n```txt\nshot.png\n```")
paths.length = 0
bare.length = 0
collectLinks(unrelatedTree)
unrelated.push(...paths)
assert.deepEqual(unrelated, [], "ordinary filenames and code samples never invent an asset directory")
assert.deepEqual(bare, ["report.xlsx"], "an inline filename is left for the host; a code block's never is")
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

// A settled answer that streamed is drawn from its whole tree, cut where its text was cut while it streamed
// (`treePieces`): the parts, drawn one after another, are the answer drawn at once. Where a piece alone reads
// otherwise (a heading named as one before it, an output folder said a block earlier, a picture of a file cited
// elsewhere), the part is what the whole answer says.
{
  const { parseSettledProse, treePieces } = await import("../src/lib/parsed-markdown")
  const { streamPieces } = await import("../src/lib/streaming-markdown")
  const { Fragment } = await import("react")
  const whole = (text: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: prosePlugins(), rehypePlugins: [rehypeAssetGroups], components }, text))
  const drawn = (part: Root) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: [skipMarkdownParse], rehypePlugins: [[reuseParsedProse, part]], components }, ""))
  const alone = (piece: string) => renderToStaticMarkup(createElement(Markdown, { remarkPlugins: prosePlugins(), rehypePlugins: [rehypeAssetGroups], components }, piece))
  const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32)
  const words = "the host keeps a copy of each turn so a reload draws the same answer while the runtime streams events".split(" ")
  const reply = (seed: number) => {
    const r = rng(seed)
    const say = () => Array.from({ length: 6 + Math.floor(r() * 10) }, (_, i) => (i === 2 ? "`src/lib/streaming-markdown.ts`" : i === 5 ? "**" + words[Math.floor(r() * words.length)] + "**" : words[Math.floor(r() * words.length)])).join(" ") + "."
    const blocks = ["# Plan", say()]
    for (let i = 0; i < 40; i++) {
      const kind = r()
      if (i % 6 === 0) blocks.push(`## ${["Plan", "Changes", "Plan", "Risks"][i % 4]}`)
      else if (kind < 0.3) blocks.push(`${say()} ${say()}`)
      else if (kind < 0.45) blocks.push(`- ${say()}\n  - ${say()}\n- ${say()}`)
      else if (kind < 0.55) blocks.push(`1. ${say()}\n\n2. ${say()}`)
      else if (kind < 0.65) blocks.push("| Path | Lines |\n| --- | ---: |\n| `src/app.ts` | 4 |\n| `src/b.ts` | 9 |")
      else if (kind < 0.72) blocks.push(`> ${say()}`)
      else if (kind < 0.8) blocks.push(`Screenshots are saved in \`/tmp/run-${i}/\`\n\n\`shot-${i}.png\` and ${say()}`)
      else if (kind < 0.88) blocks.push(`![shot](/tmp/run/shot-${i % 3}.png)\n\n![next](/tmp/run/next.png)\n\nThe file is at \`/tmp/run/shot-${(i + 1) % 3}.png\`.`)
      else blocks.push("```ts\nconst a = 1\n\nconst b = 2\n```")
    }
    return blocks.join("\n\n")
  }
  const texts = [...cases, outputProse, groupedSource, duplicatedVisual, nativeSource, "# Plan\n\nOne.\n\n## Plan\n\nTwo.\n\n## Plan\n\nThree.", ...Array.from({ length: 12 }, (_, seed) => reply(seed + 1))]
  let differAlone = 0
  for (const text of texts) {
    const pieces = streamPieces(text)
    const tree = parseSettledProse(text)
    const original = structuredClone(tree)
    const parts = treePieces(tree, pieces)
    assert.equal(parts.length, pieces.length)
    assert.equal(parts.reduce((count, part) => count + part.children.length, 0), tree.children.length, "every block is in exactly one part")
    const joined = renderToStaticMarkup(createElement(Fragment, null, ...parts.map((part, index) => createElement(Markdown, { key: index, remarkPlugins: [skipMarkdownParse], rehypePlugins: [[reuseParsedProse, part]], components }, ""))))
    assert.equal(joined, whole(text), "a settled answer's parts draw what the answer drawn at once draws")
    assert.deepEqual(tree, original, "drawing the parts leaves the whole tree as the worker sent it")
    if (pieces.some((piece, index) => drawn(parts[index]!).trim() !== alone(piece).trim())) differAlone += 1
  }
  assert.ok(differAlone >= 3, "the fixtures include answers whose pieces alone read otherwise than the whole")
  // A gallery after prose and a list of files stay one block each, in the part their source starts in.
  const gallery = "Before.\n\n- /tmp/a.png\n- /tmp/b.png\n\nAfter."
  assert.equal(treePieces(parseSettledProse(gallery), streamPieces(gallery)).map(drawn).join(""), whole(gallery))
  // Native visuals the reply already shows are left out of the whole tree as they are from the answer drawn at once.
  const native = parseSettledProse(nativeSource, ["images/screen one.png"])
  assert.equal(drawn(native), renderToStaticMarkup(createElement(Markdown, { remarkPlugins: prosePlugins(), rehypePlugins: [[rehypeAssetGroups, { previewedFiles: ["images/screen one.png"] }]], components }, nativeSource)))
  console.log(`A streamed answer's settled parts draw what the whole answer draws (${texts.length} answers, ${differAlone} whose pieces alone differ)`)
}
