import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Entry, RecordRef } from "@mako/sessions/entries"
import { streamDifferences } from "@mako/sessions/harnesses"
import { reduceLiveUpdates } from "@mako/sessions/live-content"
import { MAX_STREAM_DIFFERENCES, mergeStream, mergeStreamSteps, recordSpan, recordSpanSteps, type StreamMismatch } from "@mako/sessions/stream-merge"
import { entriesToMessages, locateShown, type ShownEntry } from "@/lib/entry-messages"
import { foldTools } from "@/lib/tools"
import { drawing, liveUpdates, PairSchema, storeReader } from "./decode-compare.ts"
import { FIXTURE_ROOT, readRecording } from "./native-decoding.ts"

/**
 * The merge of stream and record (`stream-merge.ts`), proven on every
 * decode pair of every harness: each capture replayed through the live
 * path as the host replays it, each entry naming its frames, merged with
 * what the harness's own store holds. The merged history draws as the
 * store does, with only the declared stream-only entries added; every
 * difference it reports is one the pair already knows of; every entry the
 * stream also streamed names whole lines of the capture; and merging
 * again changes nothing.
 */

const draw = (harness: string, entries: readonly Entry[]) =>
  drawing(foldTools(entriesToMessages([...entries], { kind: "saved", provider: harness }).messages)).map(numberless)
/** A drawing's tool line numbers its calls by position; one entry drawn alone is call #1. */
const numberless = (line: string) => line.replace(/^tool #\d+ /, "tool # ")

let pairs = 0
let entries = 0
let named = 0
let supplied = 0
let filled = 0
const reported = new Map<string, number>()
const harnesses = new Set<string>()
for (const harness of (await readdir(FIXTURE_ROOT)).sort()) {
  const folder = join(FIXTURE_ROOT, harness, "pairs")
  for (const name of (await readdir(folder).catch(() => [])).sort()) {
    const where = `${harness}/${name}`
    const pair = PairSchema.parse(JSON.parse(await readFile(join(folder, name, "pair.json"), "utf8")))
    const capture = join(folder, name, "capture.jsonl")
    const recording = await readRecording(capture)
    const bytes = await readFile(capture)
    const key = `mako-streams:${pair.harness}/capture.jsonl`
    const stream = reduceLiveUpdates([], liveUpdates(pair.harness, recording, undefined, key))
    const own = pair.stores.find((store) => store.reader === pair.harness)!
    const thread = await storeReader(own.reader, join(folder, name, "home")).read(join(folder, name, "home", own.path))
    const record = thread?.entries ?? []
    const differences = streamDifferences(pair.harness)
    const merge = mergeStream(record, stream, differences)
    pairs++
    harnesses.add(pair.harness)
    assert.ok(!merge.unaligned, `${where}: the two sides align`)

    // Every entry the replay drew from a frame names whole lines of the capture.
    for (const entry of stream) {
      if (entry.type === "user") continue
      assert.ok(entry.stream?.ranges?.length, `${where}: a live ${entry.type} names the frames it came from`)
      assert.equal(entry.stream.file, key)
      for (const [from, to] of entry.stream.ranges) {
        assert.ok(from === 0 || bytes[from - 1] === 0x0a, `${where}: ${from} starts a line`)
        assert.equal(bytes[to - 1], 0x0a, `${where}: ${to} ends one`)
        for (const line of bytes.subarray(from, to - 1).toString("utf8").split("\n")) JSON.parse(line)
      }
    }

    // What differs is what the pair knows differs; nothing else.
    const known = (side: "-" | "+") => new Set((own.known ?? []).filter((item) => item.side === side).map((item) => numberless(item.line)))
    const onlyStream = known("-")
    const onlyRecord = known("+")
    const explain = (mismatch: StreamMismatch) => {
      for (const line of draw(pair.harness, mismatch.stream)) assert.ok(onlyStream.has(line), `${where}: ${mismatch.kind} the pair doesn't know of: - ${line}`)
      for (const line of draw(pair.harness, mismatch.record)) assert.ok(onlyRecord.has(line), `${where}: ${mismatch.kind} the pair doesn't know of: + ${line}`)
      reported.set(`${pair.harness} ${mismatch.kind}`, (reported.get(`${pair.harness} ${mismatch.kind}`) ?? 0) + 1)
    }
    merge.mismatches.forEach(explain)

    // The merged history draws as the record does, with what the stream supplied where it streamed.
    const streamed = new Set<Entry>(stream)
    const added = merge.entries.filter((entry) => streamed.has(entry))
    assert.equal(added.length, merge.supplied)
    for (const line of draw(pair.harness, added)) assert.ok(onlyStream.has(line), `${where}: the stream supplied what the pair knows only it holds: ${line}`)
    // A line differs only where the record left a field empty that streamed, which the pair knows of from both sides.
    const mergedLines = draw(pair.harness, merge.entries.filter((entry) => !streamed.has(entry)))
    const recordLines = draw(pair.harness, record)
    assert.equal(mergedLines.length, recordLines.length, `${where}: the record's entries draw as the record does`)
    mergedLines.forEach((line, index) => {
      if (line === recordLines[index]) return
      const kept = recordLines[index]!
      // The call itself: what it ran, without its output or the flags (`pending`, `canceled`) that follow from one.
      const call = (drawn: string) => {
        const arrow = drawn.lastIndexOf(" -> ")
        return (arrow < 0 ? drawn : drawn.slice(0, arrow)).replace(/(?: (?:pending|error|canceled|cut-off))+$/, "")
      }
      assert.ok(onlyRecord.has(kept) && line.startsWith("tool ") && call(line) === call(kept), `${where}: the merge drew ${line} where the record draws ${kept}`)
      filled++
    })
    supplied += merge.supplied

    // Each record entry the stream streamed too names its frames.
    const replies = merge.entries.filter((entry) => entry.type !== "user")
    entries += replies.length
    named += replies.filter((entry) => entry.stream).length
    if (process.env.UNNAMED) for (const entry of replies) if (!entry.stream) console.log(where, entry.type, entry.id, entry.type === "event" ? entry.label : "")

    // Merging the merged history again changes nothing.
    const again = mergeStream(merge.entries, stream, differences)
    assert.deepEqual(again.entries, merge.entries, `${where}: merging is idempotent`)
    assert.equal(again.supplied, 0)
    assert.deepEqual(again.mismatches.map((item) => item.kind), merge.mismatches.map((item) => item.kind))
  }
}
assert.deepEqual([...harnesses].sort(), ["claude", "codex", "cursor", "devin", "grok", "opencode"], "every harness has pairs")
assert.ok(named / entries > 0.97, `the merged entries name their frames (${named} of ${entries})`)
console.log(`PASS: ${pairs} decode pairs on ${harnesses.size} harnesses merge into what their records draw plus ${supplied} declared stream-only entries and ${filled} calls the record left empty; ${named} of ${entries} replies and markers name their frames; the only differences reported are the pairs' known ones (${[...reported].map(([key, count]) => `${key} ${count}`).join(", ") || "none"}); merging again changes nothing`)

const user = (text: string, extra: Partial<Entry & { type: "user" }> = {}): Entry => ({ type: "user", text, ...extra })
const text = (words: string, id?: string): Entry => ({ type: "text", text: words, ...id && { id } })
const tool = (id: string, extra: Partial<Entry & { type: "tool" }> = {}): Entry => ({ type: "tool", id, ...extra })
function frames(from: number, to: number): RecordRef {
  return { file: "mako-streams:claude/a.jsonl", ranges: [[from, to]] }
}

{
  // A prompt shows Mako's words and facts at the record's place; a call keeps the record's fields and takes what it left out.
  const record: Entry[] = [
    user("Review the uncommitted changes: staged, unstaged and untracked files.", { id: "u1", at: 5, record: { ranges: [[0, 90]] } }),
    text("Looking.", "m1"),
    tool("call_1", { name: "Bash", input: "{\"command\":\"git status\"}", record: { ranges: [[90, 200]] } }),
    text("No problems found.", "m2"),
  ]
  const stream: Entry[] = [
    user("/review uncommitted changes", { requestId: "r1", provider: "claude", contextFiles: ["notes.md"] }),
    { type: "text", text: "Look", stream: frames(0, 10) }, { type: "text", text: "ing.", stream: frames(10, 20) },
    tool("ses_1:call_1", { name: "Bash", status: "completed", output: "clean", stream: frames(20, 40) }),
    { type: "text", text: "No problems\nfound.", stream: frames(40, 60) },
  ]
  const merge = mergeStream(record, stream)
  assert.deepEqual(merge.mismatches, [])
  const [prompt, reply, call, end] = merge.entries
  assert.deepEqual(prompt, { ...record[0], text: "/review uncommitted changes", requestId: "r1", provider: "claude", contextFiles: ["notes.md"] }, "Mako's words and request, the record's id, time and bytes")
  assert.deepEqual(reply, { ...record[1], stream: frames(0, 20) }, "one reply streamed in two chunks names both frames, joined")
  assert.deepEqual(call, { ...record[2], status: "completed", output: "clean", stream: frames(20, 40) }, "the record's call, a scoped id the same call, with what the record left out")
  assert.deepEqual(end, { ...record[3], stream: frames(40, 60) }, "text agrees whatever its whitespace")
  console.log("PASS: a prompt shows Mako's words at the record's place, a reply names its frames, a call takes what its record left out")
}

{
  // A declared stream-only entry stays where it streamed; an undeclared one is reported and left out; a moved call is the record's.
  const warning: Entry = { type: "event", label: "Warning", detail: "Falling back to HTTPS", stream: frames(5, 9) }
  const stray = text("Something the record lost.")
  const record: Entry[] = [user("Go", { id: "u1" }), tool("a"), tool("b"), text("Done.")]
  const stream: Entry[] = [user("Go", { requestId: "r1" }), warning, tool("b"), tool("a"), stray, text("Done.")]
  const merge = mergeStream(record, stream, streamDifferences("codex"))
  assert.deepEqual(merge.entries.map((entry) => entry.type === "tool" ? entry.id : entry.type), ["user", "event", "a", "b", "text"], "the warning where it streamed, the calls in the record's order")
  assert.equal(merge.entries[1], warning)
  assert.equal(merge.supplied, 1)
  assert.deepEqual(merge.mismatches.map((item) => [item.kind, item.type]), [["order", "tool"], ["changed", "text"]], "a moved call and a reply worded otherwise are reported")
  assert.deepEqual(merge.mismatches[1]!.stream, [stray, stream[5]], "a reply is its adjacent texts, both sides whole")
  assert.deepEqual(merge.mismatches[1]!.record, [record[3]])
  assert.equal(merge.entries[4], record[3], "the record's words stand")
  const devin = mergeStream(record, stream, streamDifferences("devin"))
  assert.deepEqual(devin.mismatches.map((item) => item.kind), ["stream-only", "changed"], "Devin declares its call order, not Codex's warning")
  assert.ok(!devin.entries.includes(warning), "an undeclared stream-only entry stays out")
  console.log("PASS: a declared stream-only entry stays where it streamed, a moved call keeps the record's order, and anything undeclared is reported with both sides")
}

{
  // Text or thinking with no words draws nothing: it neither splits a reply nor differs, the record's stays and the stream's goes.
  const record: Entry[] = [user("Go", { id: "u1" }), text("Look"), { type: "text", text: " " }, text("ing."), tool("a"), text("Done.")]
  const stream: Entry[] = [
    { type: "thinking", text: "", stream: frames(0, 5) },
    user("Go", { requestId: "r1" }),
    { type: "text", text: "Look", stream: frames(5, 10) }, { type: "thinking", text: "", stream: frames(10, 15) }, { type: "text", text: "ing.", stream: frames(15, 20) },
    tool("a", { stream: frames(20, 30) }), { type: "thinking", text: "  ", stream: frames(30, 35) },
    text("Done.", undefined),
  ]
  const merge = mergeStream(record, stream, streamDifferences("claude"))
  assert.deepEqual(merge.mismatches, [], "nothing differs")
  assert.deepEqual(merge.entries.map((entry) => entry.type), ["user", "text", "text", "text", "tool", "text"], "the record's entries, its blank one too, and none of the stream's")
  assert.deepEqual(merge.entries[1]!.stream, { file: "mako-streams:claude/a.jsonl", ranges: [[5, 10], [15, 20]] }, "one reply across an empty thinking names its own frames")
  assert.deepEqual(merge.entries[4]!.stream, frames(20, 30), "a call names its frames, not the empty thinking after it")
  console.log("PASS: text or thinking with no words neither splits a reply nor differs, and lends no frames")
}

{
  // A live entry is found again in a newer view: where it was drawn, or where a withdrawn block moved it.
  const said = { type: "text" as const, text: "Said.", stream: frames(10, 20) }
  const shown: ShownEntry = { at: { kind: "live", index: 12 }, type: "text", stream: said.stream }
  const called = tool("a", { stream: frames(0, 10) })
  assert.equal(locateShown([called, said], 11, 12, shown), 12, "where it was drawn")
  assert.equal(locateShown([said], 11, 12, shown), 11, "a block before it withdrawn")
  assert.equal(locateShown([called, { ...said, text: "Said, and more.", stream: frames(10, 40) }], 11, 12, shown), 12, "grown since: its first line still names it")
  assert.throws(() => locateShown([called, { ...said, stream: frames(20, 30) }], 11, 12, shown), /no longer in the conversation/, "another block at its place")
  assert.throws(() => locateShown([called], 11, 12, { at: shown.at, type: "text" }), /no longer in the conversation/, "one that names no stream is found only where it was drawn")
  console.log("PASS: a live entry is found again in a newer view by its place or its first stream line")
}

{
  // A fork's record holds its parent's turns, then its own; the copy of the parent's history it went on from holds more.
  const notice: Entry = { type: "event", label: "MCP server failed", detail: "docs", setup: true }
  const parent: Entry[] = [user("Go", { id: "u1" }), text("Gone."), { type: "event", label: "Interrupted" }]
  const copy: Entry[] = [notice, user("Go", { requestId: "r1" }), { type: "text", text: "Go" }, { type: "text", text: "ne." }]
  const own: Entry[] = [notice, user("Again?", { requestId: "r2" }), text("Yes.")]
  assert.equal(recordSpan([...parent, user("Again?"), text("Yes.")], copy, own), 2,
    "past the parent's last shared item; the stop only its record keeps opens the fork's part, as its declared marker")
  assert.equal(recordSpan([user("Go"), text("Gone."), user("Go"), text("Gone.")], [user("Go"), notice, text("Gone.")], [user("Go"), text("Gone.")]), 2,
    "a fork that repeats its parent's last turn pairs with its own blocks")
  assert.equal(recordSpan([user("Go"), text("Gone.")], [], [user("Go"), text("Gone.")]), 0, "nothing inherited")
  assert.equal(recordSpan(Array.from({ length: MAX_STREAM_DIFFERENCES }, (_, index) => tool(`r-${index}`)), Array.from({ length: MAX_STREAM_DIFFERENCES }, (_, index) => tool(`s-${index}`)), []), undefined,
    "two that differ past the cap say nothing of where")
  console.log("PASS: a fork's record is aligned with the history it went on from: its own turn begins past the last item they share")
}

{
  // A turn cut off under it: its record never kept the call it was running or the words before it. They stay where they
  // streamed when the harness declares so for a cut-off turn, whether a call never returned (Mako closed it) or Mako's log
  // says the turn was stopped; the same words in a turn that ended are still a difference.
  const record: Entry[] = [user("Go", { id: "u1" }), user("Next", { id: "u2" }), text("Done.", "t2")]
  const lost = text("Reading the logs first.")
  const call = tool("call_9", { name: "Bash", input: "{\"command\":\"sleep 30\"}", unfinished: true })
  const stream: Entry[] = [user("Go", { requestId: "r1" }), lost, call, user("Next", { requestId: "r2" }), text("Done.")]
  const claude = streamDifferences("claude")
  const unfinished = mergeStream(record, stream, claude)
  assert.deepEqual(unfinished.entries.map((entry) => entry.type === "tool" ? entry.id : entry.type === "text" ? entry.text : entry.type),
    ["user", "Reading the logs first.", "call_9", "user", "Done."], "a call that never returned keeps its turn's lost work")
  assert.equal(unfinished.mismatches.length, 0)
  const stopped = [...stream.slice(0, 2), ...stream.slice(3)]
  assert.deepEqual(mergeStream(record, stopped, claude).mismatches.map((item) => [item.kind, item.type]), [["stream-only", "text"]],
    "with no call left running, nothing says the turn was cut off")
  const logged = mergeStream(record, stopped, claude, new Set(["r1"]))
  assert.ok(logged.entries.includes(lost) && !logged.mismatches.length, "Mako's log says it was: the words it streamed stay")
  assert.deepEqual(mergeStream(record, stopped, claude, new Set(["r2"])).mismatches.length, 1, "another turn's stop says nothing of this one")
  assert.ok(!mergeStream(record, stopped, streamDifferences("opencode"), new Set(["r1"])).entries.includes(lost), "only where the harness declares it")
  console.log("PASS: a turn cut off keeps what its record never kept, where its harness declares so: a call that never returned, or a stop in Mako's log")
}

{
  // Cursor's SDK keeps a stopped or killed run whole in its own record (index.db's run and run_events, store.db's prompt
  // record), so its reader replays the turn and nothing of it is the stream's alone. A killed run's failure is the one
  // wording that differs: the record knows the run expired, Mako saw how its process exited (flows 82f23d46, 2543fd18).
  const cursor = streamDifferences("cursor")
  const failure = (detail: string): Entry => ({ type: "event", label: "Turn failed", detail, tone: "error" })
  const call = tool("call_9", { name: "shell", status: "failed", unfinished: true })
  const record: Entry[] = [user("Go", { id: "u1" }), text("Running it."), call, failure("Cursor's SDK process ended before the turn did"), user("Next", { id: "u2" }), text("OK")]
  const stream: Entry[] = [user("Go", { requestId: "r1" }), text("Running it."), call, failure("Cursor's SDK process exited (signal SIGKILL)"), user("Next", { requestId: "r2" }), text("OK")]
  const killed = mergeStream(record, stream, cursor, new Set(["r1"]))
  assert.deepEqual(killed.mismatches, [], "a lost run's record wording stands, declared")
  assert.deepEqual(killed.entries.map((entry) => entry.type === "event" ? entry.detail : entry.type), ["user", "text", "tool", "Cursor's SDK process ended before the turn did", "user", "text"])
  const errored = mergeStream(record.with(3, failure("Provider returned error: overloaded")), stream, cursor, new Set(["r1"]))
  assert.deepEqual(errored.mismatches.map((item) => [item.kind, item.type]), [["changed", "event"]], "a failure the record words otherwise is still a difference")
  const lost = mergeStream(record, stream.toSpliced(1, 0, { type: "thinking", text: "Checking first." }), cursor, new Set(["r1"]))
  assert.deepEqual(lost.mismatches.map((item) => [item.kind, item.type]), [["stream-only", "thinking"]], "what a cut-off Cursor turn streamed and its record lacks is a difference, not supplied")
  console.log("PASS: Cursor's record keeps a cut-off run, so the stream supplies none of it; only a lost run's failure is worded otherwise")
}

{
  // Past the cap the record stands alone, reported once.
  const record = Array.from({ length: MAX_STREAM_DIFFERENCES }, (_, index) => tool(`record-${index}`))
  const stream = Array.from({ length: MAX_STREAM_DIFFERENCES }, (_, index) => tool(`stream-${index}`))
  const merge = mergeStream(record, stream)
  assert.equal(merge.unaligned, true)
  assert.deepEqual(merge.entries, record)
  assert.equal(merge.mismatches.length, 1)
  console.log("PASS: two sides that differ past the cap leave the record alone, reported once")
}

{
  // A long history merges a slice at a time (`mergeStreamSteps`): the host runs it between other work, as a history of
  // 150MB merged in one stretch held its loop for a third of a second. It stops along the way, every few hundred items,
  // and ends with exactly what the merge at once gives.
  const turns = 2_000
  const record: Entry[] = []
  const stream: Entry[] = []
  for (let turn = 0; turn < turns; turn++) {
    record.push(user(`Ask ${turn}`, { id: `u${turn}` }), text(`Looking at ${turn}.`), tool(`call-${turn}`, { name: "Bash", status: "completed", output: `out ${turn}` }), text(`Done ${turn}.`))
    stream.push(user(`Ask ${turn}`, { requestId: `r${turn}` }), text(`Looking at ${turn}.`), tool(`call-${turn}`, { name: "Bash", status: "completed" }), text(`Done ${turn}.`))
    // Here and there the stream says what the record never kept, or words a reply otherwise.
    if (turn % 97 === 0) stream.push({ type: "event", label: "Retrying", retries: { count: 1, outcome: "recovered" } })
    if (turn % 89 === 0) stream[stream.length - 1] = text(`Finished ${turn}.`)
  }
  const differences = streamDifferences("claude")
  const steps = mergeStreamSteps(record, stream, differences)
  let stops = 0
  let next = steps.next()
  for (; !next.done; next = steps.next()) stops++
  assert.ok(stops >= (record.length + stream.length) / 256, `the merge stops along the way (${stops} stops)`)
  assert.deepEqual(next.value, mergeStream(record, stream, differences), "merged a slice at a time, it is the same merge")
  const span = recordSpanSteps(record, stream.slice(0, stream.length / 2), stream.slice(stream.length / 2))
  let spanStops = 0
  let spanNext = span.next()
  for (; !spanNext.done; spanNext = span.next()) spanStops++
  assert.ok(spanStops > 0)
  assert.equal(spanNext.value, recordSpan(record, stream.slice(0, stream.length / 2), stream.slice(stream.length / 2)))
  console.log(`PASS: a long history merges a slice at a time, stopping ${stops} times, into the merge it is at once`)
}
