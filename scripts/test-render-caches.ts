import assert from "node:assert/strict"
import { mock } from "node:test"
import { KeptResults } from "../src/lib/kept-results"
import { HighlightCache, type CodeLines } from "../src/lib/highlight-client"
import { diffLines, keptLines, writtenLines } from "../src/lib/tool-diff"
import { keptEntries } from "../src/lib/kept-entries"
import { drawnProse, replyProse, responseSections } from "../src/lib/exchanges"
import { writtenSoFar } from "../src/components/transcript/use-live-answer"
import type { ChatMessage } from "../src/lib/types"
import { createStore, keyedSubscriptions } from "../src/state/store"
import { requestOf } from "../src/state/acp-state"
import { rowChecker } from "../src/components/transcript/row-check"

/**
 * What the transcript computes once and keeps: highlighted code, an opened edit's lines, the values its rows are
 * handed, and which rows hear a conversation change. Each is held here to "once": asked twice, the work runs once.
 */

// Results made once however many ask, read back at once afterwards, and let go oldest first.
{
  let made = 0
  const kept = new KeptResults<string>(async (key) => { made += 1; return key === "fails" ? null : key.toUpperCase() }, { entries: 2, weight: 100 })
  const [first, second] = await Promise.all([kept.want("a"), kept.want("a")])
  assert.equal(first, "A")
  assert.equal(second, "A")
  assert.equal(made, 1, "Two asks for the same key make it once")
  assert.equal(kept.get("a"), "A", "A result is read back at once after it's made")
  assert.equal(await kept.want("fails"), null)
  assert.equal(kept.get("fails"), undefined, "What couldn't be made isn't kept")
  await kept.want("fails")
  assert.equal(made, 3, "and is tried again by the next to ask")
  await kept.want("b")
  await kept.want("a")
  await kept.want("c")
  assert.equal(kept.get("b"), undefined, "Past its count, the least recently asked for goes")
  assert.equal(kept.get("a"), "A")
  assert.equal(kept.get("c"), "C")
  const heavy = new KeptResults<number>(async (key) => key.length, { entries: 10, weight: 10 })
  await heavy.want("123456")
  await heavy.want("abcdef")
  assert.equal(heavy.get("123456"), undefined, "Past its weight too")
  assert.equal(heavy.get("abcdef"), 6)
}

// A code block's tokens: the worker is asked once, a second mount reads them in its first render, and a dozen
// blocks' results land a frame apart.
{
  const asked: string[] = []
  const frames: (() => void)[] = []
  const lines = (source: string): CodeLines => source.split("\n").map((content) => [{ content, color: "var(--syntax-text)" }])
  const cache = new HighlightCache(async (source, language) => { asked.push(`${language}:${source}`); return lines(source) }, (run) => void frames.push(run))
  assert.equal(cache.get("const a = 1", "ts"), undefined, "Nothing is kept before it's asked for")
  const mounts = [cache.want("const a = 1", "ts"), cache.want("const a = 1", "ts")]
  let landed = 0
  for (const mount of mounts) void mount.then(() => { landed += 1 })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(asked, ["ts:const a = 1"], "Two blocks with the same source ask the worker once")
  assert.deepEqual(cache.get("const a = 1", "ts"), lines("const a = 1"), "Once tokenized, a block mounting reads its lines synchronously")
  assert.equal(landed, 0, "A result waits for a frame")
  frames.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(landed, 1, "One block's result lands per frame")
  frames.shift()!()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(landed, 2)
  assert.deepEqual(await cache.want("const a = 1", "ts"), lines("const a = 1"))
  assert.equal(asked.length, 1, "A block mounting again doesn't ask the worker")
  assert.equal(frames.length, 0, "nor wait for a frame")
  assert.equal(cache.get("const a = 1", "js"), undefined, "The same source in another language is another block")
}

// An opened Edit or Write reads its lines once per content, however often its row draws.
{
  let reads = 0
  const lines = keptLines((before, after) => { reads += 1; return diffLines(before, after) })
  const before = Array.from({ length: 2000 }, (_, index) => `line ${index}`).join("\n")
  const after = before.replace("line 1000", "line one thousand")
  const first = lines(before, after)
  for (let draw = 0; draw < 50; draw++) assert.equal(lines(before, `${after}`), first, "The same texts give the same lines")
  assert.equal(reads, 1, "diffLines runs once per content")
  assert.deepEqual(first.filter((line) => line.kind !== "context"), [
    { kind: "remove", text: "line 1000", oldLine: 1001 },
    { kind: "add", text: "line one thousand", newLine: 1001 },
  ])
  lines(before, before)
  assert.equal(reads, 2, "Other texts are read")
  assert.equal(writtenLines("a\nb").length, 2)
}

// A map made again keeps the values that say the same, and is itself the same when they all do.
{
  const before = new Map([["a", { reason: "stopped", automatic: false }], ["b", { reason: "limit", automatic: true }]])
  const same = new Map([["a", { reason: "stopped", automatic: false }], ["b", { reason: "limit", automatic: true }]])
  assert.equal(keptEntries(before, same), before, "Nothing changed: the map it was")
  const moved = new Map([["a", { reason: "stopped", automatic: false }], ["b", { reason: "limit", automatic: false }], ["c", { reason: "new", automatic: false }]])
  const kept = keptEntries(before, moved)
  assert.notEqual(kept, before)
  assert.equal(kept.get("a"), before.get("a"), "A value that says the same is the object it was")
  assert.equal(kept.get("b"), moved.get("b"), "A changed value is the new one")
  assert.equal(kept.get("c"), moved.get("c"))
  assert.equal(keptEntries(before, new Map([["a", before.get("a")!]])).size, 1, "A key gone is gone")
}

// A conversation's rows hear that conversation: another's change runs none of their listeners.
{
  const store = createStore<{ conversations: Record<string, { text: string }>; activeKey: string | null }>({ conversations: { a: { text: "" }, b: { text: "" } }, activeKey: null })
  const keyed = keyedSubscriptions(store, (state) => state.conversations)
  const heard = { a: 0, b: 0 }
  const stops = [...Array.from({ length: 200 }, () => keyed.subscribe("a", () => { heard.a += 1 })), keyed.subscribe("b", () => { heard.b += 1 })]
  for (let batch = 0; batch < 100; batch++) store.set((state) => ({ conversations: { ...state.conversations, b: { text: `${state.conversations.b!.text}.` } } }))
  assert.equal(heard.a, 0, "A hundred batches of another conversation wake none of this one's 200 rows")
  assert.equal(heard.b, 100)
  store.set({ activeKey: "a" })
  assert.equal(heard.a + heard.b, 100, "A change that moves no conversation wakes no row")
  store.set((state) => ({ conversations: { ...state.conversations, a: { text: "moved" } } }))
  assert.equal(heard.a, 200, "Its own change wakes each of them once")
  assert.equal(keyed.get("a")?.text, "moved")
  for (const stop of stops) stop()
  store.set((state) => ({ conversations: { ...state.conversations, a: { text: "again" } } }))
  assert.equal(heard.a, 200, "A row gone hears nothing")
}

// A turn's request is found in a map made once for the requests as they stand.
{
  let walked = 0
  class Walked<Item> extends Array<Item> {
    override [Symbol.iterator](): ArrayIterator<Item> {
      walked += 1
      return super[Symbol.iterator]()
    }
  }
  const requests = Walked.from(Array.from({ length: 500 }, (_, index) => ({ id: `request-${index}`, text: "", attachments: [], status: "completed" as const })))
  const conversation = { requests }
  for (let turn = 0; turn < 500; turn++) assert.equal(requestOf(conversation, `request-${turn}`), requests[turn])
  assert.equal(walked, 1, "The requests are walked once, not once per row")
  assert.equal(requestOf(conversation, "none"), undefined)
  assert.equal(requestOf(conversation, undefined), undefined)
  assert.equal(requestOf(undefined, "request-1"), undefined)
}

// The row check, told which rows changed, reads those rows and no others; told nothing, it reads them all.
{
  Object.assign(globalThis, { document: { visibilityState: "visible" } })
  const reads = new Map<number, number>()
  const heights = Array.from({ length: 12 }, () => 100)
  const sizes = new Map<number | string | bigint, number>(heights.map((height, index) => [index, height]))
  const starts = () => heights.map((_, index) => heights.slice(0, index).reduce((sum, height) => sum + height, 0))
  const row = (index: number) => ({
    style: { transform: "" },
    getAttribute: (name: string) => (name === "data-index" ? String(index) : null),
    getBoundingClientRect: () => {
      reads.set(index, (reads.get(index) ?? 0) + 1)
      return { height: heights[index]!, top: starts()[index]! }
    },
  })
  type Row = ReturnType<typeof row>
  const children = heights.map((_, index) => row(index))
  const resized: [number, number][] = []
  const mounted = {
    rows: {
      options: { count: heights.length, estimateSize: () => 360, scrollMargin: 0 },
      isScrolling: false,
      itemSizeCache: sizes,
      elementsCache: new Map<number | string | bigint, Row>(children.map((element, index) => [index, element])),
      measureElement: () => {},
      resizeItem: (index: number, size: number) => { resized.push([index, size]); sizes.set(index, size) },
      getVirtualItems: () => starts().map((start, index) => ({ index, start })),
    },
    list: { clientWidth: 600, children, getBoundingClientRect: () => ({ top: 0 }) },
    keyOf: (index: number) => index,
    partsOf: () => 1,
    streaming: (index: number) => index === 11,
    following: true,
  }
  const warned = mock.method(console, "warn", () => {})
  try {
    const check = rowChecker<Row>()
    assert.equal(check.check(mounted), false, "Rows at their sizes need nothing")
    assert.equal(reads.size, 12, "With no rows named, every row is read")
    reads.clear()
    const only = new Set([children[11]!])
    assert.equal(check.check(mounted, only), false)
    assert.deepEqual([...reads], [[11, 1]], "A stream's frame reads its own row, once, when its size stands")
    reads.clear()
    heights[11] = 180
    assert.equal(check.check(mounted, only), true, "A row grown is corrected, and waits to hear whether its observer said so")
    assert.deepEqual(resized, [[11, 180]])
    assert.deepEqual([...reads.keys()], [11], "and only it and the rows after it are read for their places")
    reads.clear()
    heights[3] = 140
    check.check(mounted)
    assert.deepEqual(resized.at(-1), [3, 140], "The steady check still finds a row no change named")
    assert.equal(reads.size, 12)
    assert.ok(warned.mock.calls.some((call) => String(call.arguments[0]).startsWith("Transcript row corrected")), "A correction its observer never reported is logged")
  } finally {
    warned.mock.restore()
  }
}

// A reply is drawn a text block to a part. What is parsed ahead for a turn is asked for by those same texts, so each
// part of a reply with calls between its paragraphs finds its tree when it mounts; the reply's text joined finds none.
{
  const reply: ChatMessage = {
    id: "acp-assistant-4", role: "assistant",
    blocks: [
      { type: "text", text: "First I read the file.\n\nIt has two exports." },
      { type: "toolCall", id: "1:t1", name: "Read", arguments: { path: "src/a.ts" } },
      { type: "toolResult", id: "1:t1", name: "Read", text: "export const a = 1" },
      { type: "text", text: "Then I changed the second." },
      { type: "text", text: "" },
      { type: "text", text: "## Done\n\nBoth pass." },
    ],
  }
  const prompt: ChatMessage = { id: "acp-user-3", role: "user", blocks: [{ type: "text", text: "Change the second export" }] }
  const streaming: ChatMessage = { id: "acp-assistant-9", role: "assistant", streaming: true, blocks: [{ type: "text", text: "Still being written" }] }
  const ahead = drawnProse([prompt, reply, streaming])
  const mounted = responseSections([reply]).flatMap((section) => (section.kind === "prose" ? [replyProse(section.message.blocks)] : [])).filter(Boolean)
  assert.deepEqual(ahead, mounted, "What is parsed ahead is what each part asks for, in order")
  assert.equal(mounted.length, 3, "one prose for each text block that says something")
  assert.ok(!ahead.includes(replyProse(reply.blocks)), "never the reply's text joined")
  let parses = 0
  const trees = new KeptResults<string>(async (text) => { parses += 1; return `tree of ${text.length}` }, { entries: 8, weight: 10_000 })
  await Promise.all(ahead.map((text) => trees.want(text)))
  assert.deepEqual(mounted.map((text) => trees.get(text)), mounted.map((text) => `tree of ${text.length}`), "every part of a multi-block reply finds its tree on mount")
  assert.equal(trees.get(replyProse(reply.blocks)), undefined)
  assert.equal(parses, 3)
  assert.deepEqual(drawnProse([streaming]), [], "a reply still being written is parsed by its own prose as it grows")
}

// A reply being written hands its growing words to the one part that draws its last block, told by the part's id: an
// earlier paragraph that reads like the start of the last one never takes them, and nothing does once a call follows.
{
  const prompt: ChatMessage = { id: "acp-request-r1", role: "user", requestId: "r1", blocks: [{ type: "text", text: "Go on" }] }
  const reply = (blocks: ChatMessage["blocks"]): ChatMessage => ({ id: "acp-assistant-7", role: "assistant", streaming: true, blocks })
  const call = { type: "toolCall" as const, id: "1:t1", name: "Read", arguments: { path: "src/a.ts" } }
  const result = { type: "toolResult" as const, id: "1:t1", name: "Read", text: "export const a = 1" }
  const holding = (message: ChatMessage) => {
    const exchange = { id: "acp-request-r1", prompt, response: [message], system: [] }
    // Only what the reading looks at: the conversation's key and the turns it draws.
    return { key: "live-1", projection: { exchanges: [exchange], messages: [prompt, message], plan: [], files: [] } }
  }
  const writing = reply([{ type: "text", text: "Done." }, call, result, { type: "text", text: "Done. Next, the second" }])
  const parts = responseSections(writing.blocks.length ? [writing] : []).flatMap((section) => (section.kind === "prose" ? [section.id] : []))
  assert.equal(parts.length, 2)
  const [first, last] = parts
  assert.equal(writtenSoFar(holding(writing), last!), "Done. Next, the second", "The part that draws the last block reads it as it grows")
  assert.equal(writtenSoFar(holding(writing), first!), undefined, "An earlier part never takes the last block's words, though they begin with its own")
  const more = reply([...writing.blocks.slice(0, -1), { type: "text", text: "Done. Next, the second export" }])
  assert.equal(writtenSoFar(holding(more), last!), "Done. Next, the second export", "and goes on reading it")
  const called = reply([...more.blocks, { ...call, id: "1:t2" }])
  assert.equal(writtenSoFar(holding(called), last!), undefined, "A call after it: nothing is being written")
  assert.equal(writtenSoFar(holding(more), "acp-assistant-8-part-1"), undefined, "Another reply's part reads nothing of this one")
  assert.equal(writtenSoFar(undefined, last!), undefined)
}

console.log("PASS: results kept and made once, code tokens read synchronously on a second mount, edit lines read once per content, kept map values, per-conversation listeners, requests by id, and the row check's named rows")
