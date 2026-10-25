import assert from "node:assert/strict"
import { toHtml } from "hast-util-to-html"
import { fenceSegments, streamingMarkdown } from "../src/lib/streaming-markdown"
import { parseProse } from "../src/lib/parsed-markdown"

// What a streaming answer draws: whole structure, never half of one.
{
  const intro = "Here is the comparison:\n\n"
  // A table waits for its header and delimiter rows, then arrives a row at a time.
  assert.equal(streamingMarkdown(`${intro}| File | Lines |`), intro)
  assert.equal(streamingMarkdown(`${intro}| File | Lines |\n`), intro)
  assert.equal(streamingMarkdown(`${intro}| File | Lines |\n| --- | -`), intro)
  assert.equal(streamingMarkdown(`${intro}| File | Lines |\n| --- | --- |`), intro)
  const head = `${intro}| File | Lines |\n| --- | --- |\n`
  assert.equal(streamingMarkdown(head), head)
  assert.equal(streamingMarkdown(`${head}| app.ts | 4`), head)
  assert.equal(streamingMarkdown(`${head}| app.ts | 42 |\n`), `${head}| app.ts | 42 |\n`)
  // A header without pipes at its edge stays a paragraph until its delimiter would make it a heading.
  assert.equal(streamingMarkdown(`${intro}File | Lines\n--- |`), `${intro}File | Lines\n`)
  assert.equal(streamingMarkdown(`${intro}File | Lines\n--- | ---\nap`), `${intro}File | Lines\n--- | ---\n`)
  // A pipe in a sentence is not a table.
  const sentence = `${intro}Pipe it with \`a | b\` and go on`
  assert.equal(streamingMarkdown(sentence), sentence)
  assert.equal(streamingMarkdown(`${intro}| quoted pipe\nthen a word`), `${intro}| quoted pipe\nthen a word`)

  // A fence waits for its opening line; after that the code streams as code.
  assert.equal(streamingMarkdown(`${intro}\`\`\`type`), intro)
  assert.equal(streamingMarkdown(`${intro}\`\``), intro)
  assert.equal(streamingMarkdown(`${intro}~~~~py`), intro)
  const open = `${intro}\`\`\`typescript\nconst answer = 4`
  assert.equal(streamingMarkdown(open), open)
  // A closing fence shorter than the opener, or of the other character, closes nothing.
  const still = `${intro}\`\`\`\`md\n\`\`\`\n~~~\n| a | b |`
  assert.equal(streamingMarkdown(still), still)
  // After the fence closes, its lines are not mistaken for a table.
  const closed = `${intro}\`\`\`\n| a | b |\n\`\`\`\n\nDone`
  assert.equal(streamingMarkdown(closed), closed)

  // Paragraphs, lists and headings stream word by word.
  for (const text of ["I", "I'll look at what favicon the web UI", `${intro}- first\n- sec`, `${intro}## Head`, `${intro}1. one\n\n2. tw`, `${intro}**bold so f`])
    assert.equal(streamingMarkdown(text), text)
  // A last line that is only marks waits for the character that says what it is.
  assert.equal(streamingMarkdown("A paragraph\n-"), "A paragraph\n")
  assert.equal(streamingMarkdown("A paragraph\n==="), "A paragraph\n")
  assert.equal(streamingMarkdown(`${intro}- `), intro)
  assert.equal(streamingMarkdown(`${intro}- a`), `${intro}- a`)
  assert.equal(streamingMarkdown(""), "")
}

// Where a streaming answer's parse can be cut: only after a closed fence at the left edge and a blank line.
{
  const doc = "Intro\n\n```ts\nconst a = 1\n```\n\n- one\n\n- two\n\n```\nb\n```\n\nEnd"
  const pieces = fenceSegments(doc)
  assert.deepEqual(pieces, ["Intro\n\n```ts\nconst a = 1\n```\n\n", "- one\n\n- two\n\n```\nb\n```\n\n", "End"])
  // A loose list across blank lines is never cut.
  const loose = "1. one\n\n2. two\n\n   more of two\n\n3. three"
  assert.deepEqual(fenceSegments(loose), [loose])
  // A fence inside a list item is not at the left edge: the list goes on after it.
  const nested = "- item\n\n  ```\n  code\n  ```\n\n  still the item\n- next"
  assert.deepEqual(fenceSegments(nested), [nested])
  // A fence still open, or closed without a blank line after it yet, is no cut.
  assert.deepEqual(fenceSegments("```\na\n\nb"), ["```\na\n\nb"])
  assert.deepEqual(fenceSegments("```\na\n```\nb"), ["```\na\n```\nb"])
  assert.deepEqual(fenceSegments("```\na\n```\n\n"), ["```\na\n```\n\n"])
  // Context that reaches across the document keeps it whole.
  for (const whole of [
    "See [docs][d].\n\n```\na\n```\n\n[d]: https://example.test",
    "Note[^1]\n\n```\na\n```\n\n[^1]: Footnote",
    "<details>\n\n```\na\n```\n\n</details>",
    "Text\r\n\r\n```\r\na\r\n```\r\n\r\nMore",
    "\uFEFFText\n\n```\na\n```\n\nMore",
  ])
    assert.deepEqual(fenceSegments(whole), [whole])
  // Markup inside code is code: a fence of JSX still cuts.
  assert.equal(fenceSegments("```tsx\n<div>\n[x]: y\n```\n\nAfter").length, 2)
  // Every piece rejoins to the answer exactly, at every length it streams through.
  for (let end = 0; end <= doc.length; end++) assert.equal(fenceSegments(doc.slice(0, end)).join(""), doc.slice(0, end))
}

// Pieces parsed alone draw what the whole parse draws.
{
  const docs = [
    "Intro\n\n```ts\nconst a = 1\n```\n\n- one\n\n- two\n\n```\nb\n```\n\nEnd **bold**",
    "> quote\n```\ncode\n```\n\nSetext\n------\n\n| a | b |\n| - | - |\n| 1 | 2 |",
    "1. one\n```\ncode\n```\n\n2. two\n\n```\nx\n```\n\n---\n\n# Heading",
  ]
  const html = (text: string) => toHtml(parseProse(text)).replace(/ data-source-line="\d+"/g, "").replace(/\n/g, "")
  for (const doc of docs) {
    const pieces = fenceSegments(doc)
    assert.ok(pieces.length > 1, `expected cuts in ${JSON.stringify(doc)}`)
    assert.equal(pieces.map(html).join(""), html(doc))
  }
}

console.log("PASS: streaming markdown draws whole structure and cuts its parse only at closed fences")
