import assert from "node:assert/strict"
import { toHtml } from "hast-util-to-html"
import { fenceSegments, streamingMarkdown } from "../src/lib/streaming-markdown"
import { parseProse } from "../src/lib/parsed-markdown"
import { LIVE_FRAME_MS } from "@mako/host/contracts/live-conversations"
import { STREAM_FRAME_MAX_MS, STREAM_FRAME_MS, StreamFrames, streamFrameMs, type StreamClock } from "../src/lib/stream-frames"

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

// How a streaming answer repaints: the first token of a burst at once, then at most once a frame, the latest text each
// time; a pending paint survives later tokens; and a stop (StrictMode's simulated remount) leaves nothing that looks
// pending, so the next token paints.
{
  let now = 0
  const timers: Array<{ at: number; run: () => void; cleared: boolean }> = []
  const clock: StreamClock = {
    now: () => now,
    schedule: (run, ms) => {
      const timer = { at: now + ms, run, cleared: false }
      timers.push(timer)
      return () => void (timer.cleared = true)
    },
  }
  /** Moves the clock to `to`, running each timer due by then, in order. */
  const advance = (to: number) => {
    for (;;) {
      const due = timers.filter((timer) => !timer.cleared && timer.at <= to).sort((left, right) => left.at - right.at)[0]
      if (!due) break
      now = due.at
      due.cleared = true
      due.run()
    }
    now = to
  }
  const painted: Array<[number, string]> = []
  const frames = new StreamFrames((text) => painted.push([now, text]), clock)
  frames.next("I")
  advance(0)
  assert.deepEqual(painted, [[0, "I"]], "the first token paints at once, not a frame later")
  // A steady stream, a token every 20 ms: a paint every frame, each the latest text.
  let text = "I"
  for (let at = 20; at <= 200; at += 20) {
    advance(at)
    text += ` t${at}`
    frames.next(text)
  }
  advance(400)
  assert.deepEqual(painted.map(([at]) => at), [0, 50, 100, 150, 200, 250], "at most once a frame under a steady stream")
  assert.equal(painted.at(-1)?.[1], text, "and the last paint is the latest text")
  // A pause, then the next burst: its first token paints at once again.
  frames.next(`${text} after a tool call`)
  advance(400)
  assert.deepEqual(painted.at(-1), [400, `${text} after a tool call`])
  // StrictMode's remount: the cleanup stops a pending paint, the effect runs again, and that paint comes.
  frames.next(`${text} more`)
  frames.stop()
  frames.next(`${text} more`)
  advance(500)
  assert.deepEqual(painted.at(-1), [450, `${text} more`], "a stop leaves nothing that looks pending")
  frames.next("settled")
  frames.stop()
  advance(1_000)
  assert.notEqual(painted.at(-1)?.[1], "settled", "a stopped paint never comes")
  // A long piece is parsed again on every paint: it paints less often, never less than every STREAM_FRAME_MAX_MS.
  assert.equal(streamFrameMs(500), STREAM_FRAME_MS)
  assert.equal(streamFrameMs(9_000), STREAM_FRAME_MS)
  assert.ok(streamFrameMs(16_000) > 80 && streamFrameMs(16_000) <= STREAM_FRAME_MAX_MS)
  assert.equal(streamFrameMs(1_000_000), STREAM_FRAME_MAX_MS)
  // The host sends a stream's batches on this frame (`LIVE_FRAME_MS`): each one paints as it lands, none waits on a paint.
  assert.equal(STREAM_FRAME_MS, LIVE_FRAME_MS)
  const paintedAt: number[] = []
  const batches = new StreamFrames(() => paintedAt.push(now), clock)
  const start = now
  for (let at = start + 1; at <= start + 501; at += LIVE_FRAME_MS) {
    advance(at)
    batches.next(`batch ${at}`)
    advance(at)
    assert.equal(paintedAt.at(-1), at, "a batch on the host's frame paints the moment it lands")
  }
}

console.log("PASS: streaming markdown draws whole structure and cuts its parse only at closed fences, and repaints the first token of a burst at once, then once a frame")
