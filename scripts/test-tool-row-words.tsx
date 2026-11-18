// A tool row's words are one line: whatever a view puts in them (its summary)
// is inline content, which the row truncates as one. A box among them (a
// flex or block element) breaks the line in two, and in a row of fixed
// height the second line draws over the row below. Static render through
// the production row and the desk's own views, for every harness's sample
// calls, settled and running; `scripts/test-tool-rows-ui.mjs` holds the
// drawn rows apart in a window.
import assert from "node:assert/strict"
import { renderToStaticMarkup } from "react-dom/server"
import type { Entry } from "@mako/sessions/entries"
import { installBuiltins } from "../src/desk/builtins"
import { ToolRow } from "../src/components/transcript/tool-row"
import { TranscriptSourceContext, TurnRunningContext } from "../src/components/transcript/source-context"
import { entriesToMessages } from "../src/lib/entry-messages"
import { pairTools } from "../src/lib/tools"
import { HARNESS_TOOL_SAMPLES } from "../src/dev/harness-tool-samples"

// The desk preloads its lazy panels when idle; a static render has no idle time.
Reflect.set(globalThis, "window", { requestIdleCallback: () => 0, cancelIdleCallback: () => undefined })
installBuiltins()

/** Tags and classes that lay out as a box rather than flowing in a line of text. */
const BOX_TAG = /<(div|p|ul|ol|li|pre|table|section|h[1-6])[\s>]/
const BOX_CLASS = new Set(["flex", "inline-flex", "grid", "inline-grid", "block", "inline-block", "table", "flow-root"])

/** The elements directly inside the first `<button>` of `markup`, each as its markup. */
function buttonChildren(markup: string): string[] {
  const tags = /<(\/?)([a-z][a-z0-9-]*)[^>]*?(\/?)>/g
  const children: string[] = []
  let depth = 0
  let start = -1
  tags.lastIndex = markup.indexOf("<button")
  for (let tag = tags.exec(markup); tag; tag = tags.exec(markup)) {
    const [whole, closing, name, selfClosing] = tag
    if (!closing && !selfClosing) {
      if (depth === 1) start = tag.index
      depth += 1
    } else if (closing) {
      depth -= 1
      if (depth === 0 && name === "button") break
      if (depth === 1) children.push(markup.slice(start, tag.index + whole.length))
    } else if (depth === 1) children.push(whole)
  }
  return children
}

/** What the row's words hold: the inside of the element after the glyph's slot, which is the row's one line. */
function words(markup: string): string {
  const line = buttonChildren(markup)[1]
  assert.ok(line?.includes("truncate"), `the row's words are its truncating line: ${line}`)
  return line.slice(line.indexOf(">") + 1, line.lastIndexOf("</"))
}

let checked = 0
for (const [index, sample] of HARNESS_TOOL_SAMPLES.entries()) {
  if (!sample.source.name) continue
  const entry: Entry = { type: "tool", id: `call-${index}`, name: sample.source.name, input: sample.source.input, output: "ok" }
  for (const running of [false, true]) {
    const messages = entriesToMessages([running ? { ...entry, status: "running", output: undefined } : entry], { kind: "live", running, provider: sample.source.harness })
    const call = pairTools(messages.messages[0]!.blocks)[0]!
    const markup = renderToStaticMarkup(
      <TranscriptSourceContext value={{ threadPath: "/fixture/thread" }}>
        <TurnRunningContext value={running}>
          <ToolRow call={call} />
        </TurnRunningContext>
      </TranscriptSourceContext>
    )
    const said = words(markup)
    const label: string = `${sample.source.harness} ${sample.source.name} ${running ? "running" : "settled"}`
    assert.doesNotMatch(said, BOX_TAG, `${label}: a box among the row's words: ${said}`)
    for (const [, classes] of said.matchAll(/class="([^"]*)"/g))
      assert.deepEqual(classes!.split(/\s+/).filter((name) => BOX_CLASS.has(name)), [], `${label}: a box among the row's words: ${said}`)
    checked += 1
  }
}
assert.ok(checked > 100, `only ${checked} rows were checked`)
console.log(`Tool row words: ${checked} rows, settled and running, each one line of inline words`)
