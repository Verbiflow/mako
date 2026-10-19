import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CODEX_VOCABULARY } from "../dist/harnesses/codex.js"
import { CodexProvider } from "../dist/providers/codex.js"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { mergeStream } from "../dist/stream-merge.js"

const nativeStores = new NativeStores(false)

// A real three-turn rollout Codex 0.159 wrote, from the `resumed` decode pair, wherever its last recording put it.
const pair = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/native-decoding/codex/pairs/resumed")
const recorded = join(pair, "home", JSON.parse(await readFile(join(pair, "pair.json"), "utf8")).stores[0].path)
const lines = (await readFile(recorded, "utf8")).split("\n").filter(Boolean)
const starts = lines.flatMap((line, index) => JSON.parse(line).payload?.type === "task_started" ? [index] : [])
assert.equal(starts.length, 3, "the recording holds three turns")

const home = await mkdtemp(join(tmpdir(), "mako-codex-records-"))
const sessions = join(home, ".codex", "sessions")
await mkdir(sessions, { recursive: true })
const provider = new CodexProvider(nativeStores, home)
let files = 0
const rollout = async (body) => {
  const path = join(sessions, `rollout-2026-10-07T19-47-34-01a11968-b19f-7c73-8e6f-edac2e2edc8${files++}.jsonl`)
  await writeFile(path, body.map((line) => `${line}\n`).join(""))
  return path
}
const entries = async (path) => JSON.stringify((await provider.read(path)).entries)
const event = (payload) => JSON.stringify({ timestamp: "2026-10-07T19:49:00.000Z", type: "event_msg", payload })
const rolledBack = (turns) => event({ type: "thread_rolled_back", num_turns: turns })

{
  const whole = await entries(await rollout(lines))
  const twoTurns = await entries(await rollout(lines.slice(0, starts[2])))
  const oneTurn = await entries(await rollout(lines.slice(0, starts[1])))
  assert.notEqual(whole, twoTurns)
  assert.equal(await entries(await rollout([...lines, rolledBack(1)])), twoTurns, "a rollback drops the latest turn whole, as Codex's history does")
  assert.equal(await entries(await rollout([...lines, rolledBack(2)])), oneTurn)
  assert.equal(await entries(await rollout([...lines, rolledBack(0)])), whole, "rolling back no turns changes nothing")
  assert.equal(JSON.parse(await entries(await rollout([...lines, rolledBack(9)]))).length, 0, "rolling back more turns than there are clears them all")
  // What it draws, without the bytes it came from: the turn run again is other lines.
  const drawn = (json) => JSON.stringify(JSON.parse(json).map(({ record: _record, id, ...entry }) => id === undefined || id.startsWith("@") ? entry : { id, ...entry }))
  const rerun = await entries(await rollout([...lines.slice(0, starts[2]), ...lines.slice(starts[2]), rolledBack(1), ...lines.slice(starts[2])]))
  assert.equal(drawn(rerun), drawn(whole), "the turn run again after a rollback draws as it did the first time")
  const rerunLast = JSON.parse(rerun).at(-1).record.ranges[0][0]
  assert.ok(rerunLast > JSON.parse(whole).at(-1).record.ranges[0][0], "and names the lines it was run again from")
  console.log("PASS: a Codex rollback drops the turns Codex drops")

  // A follower already past the turns it would drop reads the thread again.
  const followed = await rollout(lines)
  const follower = provider.createFollower(followed, (await stat(followed)).size)
  await appendFile(followed, `${rolledBack(1)}\n`)
  const update = await follower.next()
  assert.equal(update.reset, true, "a rollback reaching turns the follower never saw rereads the thread")
  assert.equal(JSON.stringify(update.entries), twoTurns)
  await appendFile(followed, `${rolledBack(1)}\n`)
  const again = await follower.next()
  assert.equal(again.replace, true)
  assert.equal(JSON.stringify(again.entries), JSON.stringify(JSON.parse(oneTurn).slice(again.replaceFrom)), "once it has read them, it drops them in place")
  console.log("PASS: a follower applies a rollback")
}

{
  const record = (type, payload) => JSON.stringify({ timestamp: "2026-10-07T19:49:00.000Z", type, payload })
  const future = [
    record("future_record", { note: "a kind no Codex wrote" }),
    record("future_record", { note: "counted, not kept again" }),
    record("response_item", { type: "future_item" }),
    record("response_item", { type: "message", role: "critic", content: [] }),
    event({ type: "future_event" }),
    event({ type: "item_completed", turn_id: "t", item: { type: "FutureItem", id: "f" } }),
    event({ type: "item_completed", turn_id: "t", item: { type: "CommandExecution", id: "c" } }),
    event({ type: "thread_rolled_back" }),
    record("response_item", { type: "image_generation_call", id: "ig", status: "completed" }),
    record("event_msg", {}),
    // Kinds Codex writes that history reads or skips report nothing.
    record("world_state", {}),
    record("response_item", { type: "ghost_snapshot" }),
    event({ type: "agent_reasoning", text: "copy" }),
    event({ type: "item_completed", turn_id: "t", item: { type: "UserMessage", id: "u", content: [] } }),
    event({ type: "item_completed", turn_id: "t", item: { type: "Extension", kind: "clock.sleep", id: "s", durationMs: 1000 } }),
    event({ type: "item_completed", turn_id: "t", item: { type: "Extension", kind: "future.kind", id: "x" } }),
    event({ type: "item_completed", turn_id: "t", item: { type: "Extension", kind: "web.search", id: 7 } }),
  ]
  const thread = await provider.read(await rollout([...lines, ...future]))
  assert.equal(JSON.stringify(thread.entries.filter((entry) => entry.type !== "unread")), await entries(await rollout(lines)), "records history can't draw leave what it draws alone")
  const futureAt = Buffer.byteLength(lines.map((line) => `${line}\n`).join(""))
  const futureRanges = future.map((line, index) => [futureAt + Buffer.byteLength(future.slice(0, index).map((before) => `${before}\n`).join("")), line])
  assert.deepEqual(thread.entries.filter((entry) => entry.type === "unread").map((entry) => [entry.id, entry.record, entry.raw]),
    futureRanges.filter(([, line]) => !/world_state|ghost_snapshot|agent_reasoning|UserMessage|clock\.sleep/.test(line))
      .map(([start, line]) => [`@${start}`, { ranges: [[start, start + Buffer.byteLength(line) + 1]] }, JSON.parse(line)]),
    "each one stands as an entry where it was, named by its place and its bytes, the record whole")
  assert.deepEqual(thread.unread.map(({ kind, reason, count }) => [kind, reason, count]), [
    ["future_record", "unknown", 2],
    ["response_item future_item", "unknown", 1],
    ["response_item message critic", "unknown", 1],
    ["event_msg future_event", "unknown", 1],
    ["event_msg item_completed FutureItem", "unknown", 1],
    ["event_msg item_completed CommandExecution", "unreadable", 1],
    ["event_msg thread_rolled_back", "unreadable", 1],
    ["response_item image_generation_call", "undrawn", 1],
    ["event_msg (no type)", "unreadable", 1],
    ["event_msg item_completed Extension future.kind", "unknown", 1],
    ["event_msg item_completed Extension web.search", "unreadable", 1],
  ])
  assert.deepEqual(thread.unread[0].sample, JSON.parse(future[0]), "the first record of a kind is kept as Codex wrote it")
  assert.equal((await provider.read(await rollout(lines))).unread, undefined, "a rollout Codex 0.159 wrote reads whole")
  console.log("PASS: a saved Codex thread names the records it couldn't draw")
}

{
  // A command a code cell started in the background has no call of its own, and Codex 0.159.3 writes its item when it
  // ends: after the cell's output, and after the turn when it outlives it (the session flows of 2026-10-16). Once its
  // turn has ended no call can claim it, so it is the cell's. A turn with no cell leaves such an item to its call.
  const record = (type, payload) => JSON.stringify({ timestamp: "2026-10-17T04:07:38.000Z", type, payload })
  const turn = "01a1480b-29c5-7c90-a5f1-dff1c83f25c4"
  const command = (id, sleep) => event({ type: "item_completed", turn_id: turn, item: {
    type: "CommandExecution", id, command: ["/bin/zsh", "-lc", `sleep ${sleep}`], status: "failed", aggregated_output: "", exit_code: -1,
  } })
  const opened = [
    event({ type: "task_started", turn_id: turn }),
    record("response_item", { type: "message", role: "user", content: [{ type: "input_text", text: "Start two background commands" }] }),
    record("response_item", { type: "custom_tool_call", status: "completed", call_id: "call_cell", name: "exec", input: "text(await tools.exec_command({cmd: 'sleep 300'}))" }),
    record("response_item", { type: "custom_tool_call_output", call_id: "call_cell", output: [{ type: "input_text", text: "Script completed" }] }),
  ]
  const answered = [
    record("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text: "STARTED" }] }),
    event({ type: "task_complete", turn_id: turn, last_agent_message: "STARTED" }),
  ]
  // The rollout opens as Codex opens one, with its session header.
  const calls = async (body) => (await provider.read(await rollout([lines[0], ...body]))).entries.filter((entry) => entry.type === "tool" && entry.name === "exec_command")
    .map((entry) => [entry.id, entry.status, entry.input])
  const both = [["exec-a", "failed", JSON.stringify({ command: "sleep 300" })], ["exec-b", "failed", JSON.stringify({ command: "sleep 301" })]]
  assert.deepEqual(await calls([...opened, ...answered, command("exec-a", 300), command("exec-b", 301)]), both,
    "commands written after the turn that ran their cell are its cell's")
  assert.deepEqual(await calls([...opened, command("exec-a", 300), ...answered, command("exec-b", 301)]), both,
    "and one written after the cell closed but within the turn, once the turn ends")
  const noCell = [opened[0], opened[1], ...answered, command("exec-a", 300)]
  assert.deepEqual(await calls(noCell), [], "a turn with no cell leaves an item to the call it waits for")
  console.log("PASS: a code cell's background commands Codex writes when they end, after the cell or the turn, are the cell's")
}

{
  // The session flows of 2026-10-16 (01a1480b-28d2): three cells, the second starting `sleep 300` and the third
  // `sleep 301` in the background. Codex writes each command's item when it ends, after the turn's answer; the
  // app-server's `item/started` drew each as it started, inside its cell. The record draws them there too: after the
  // cell that ran when it started (`started_at_ms`), among that cell's in the order they started.
  const turn = "01a1480b-29c5-7c90-a5f1-dff1c83f25c4"
  const second = "01a1480b-5597-7ca1-a379-87a673cfa581"
  const record = (at, type, payload) => JSON.stringify({ timestamp: `2026-10-17T04:07:${at}Z`, type, payload })
  const task = (at, type, id) => record(at, "event_msg", { type, turn_id: id })
  const prompt = (at, text) => record(at, "response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] })
  const answer = (at, id, text) => record(at, "response_item", { type: "message", id, role: "assistant", content: [{ type: "output_text", text }] })
  const reasoning = (at, id, text) => record(at, "response_item", { type: "reasoning", id, summary: [{ type: "summary_text", text }] })
  const cell = (at, id, input) => record(at, "response_item", { type: "custom_tool_call", status: "completed", call_id: id, name: "exec", input })
  const cellOutput = (at, id, text) => record(at, "response_item", { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: `Script completed\n${text}` }] })
  const command = (at, id, sleep, startedAt, turnId = turn) => record(at, "event_msg", {
    type: "item_completed", turn_id: turnId, started_at_ms: startedAt,
    item: { type: "CommandExecution", id, command: ["/bin/zsh", "-lc", `sleep ${sleep}`], status: "failed", aggregated_output: "", exit_code: -1 },
  })
  const mcp = (at, id) => record(at, "event_msg", {
    type: "item_completed", turn_id: turn,
    item: { type: "McpToolCall", id, server: "docs", tool: "search", arguments: { q: "sleep" }, status: "completed", result: { content: [{ type: "text", text: "found" }] } },
  })
  const opened = [task("33.582", "task_started", turn), prompt("34.830", "Start two background commands")]
  const cells = [
    cell("38.128", "call_list", "text(ALL_TOOLS)"), cellOutput("38.210", "call_list", "[]"),
    cell("39.921", "call_300", "text(await tools.exec_command({cmd:'sleep 300',yield_time_ms:1}))"),
    cellOutput("40.354", "call_300", '{"session_id":4943}'),
    cell("41.689", "call_301", "text(await tools.exec_command({cmd:'sleep 301',yield_time_ms:1}))"),
    cellOutput("42.113", "call_301", '{"session_id":57445}'),
  ]
  const answered = [answer("43.838", "msg_started", "STARTED"), task("43.884", "task_complete", turn)]
  const sleep300 = command("43.977", "exec-300", 300, Date.parse("2026-10-17T04:07:40.100Z"))
  const sleep301 = command("44.081", "exec-301", 301, Date.parse("2026-10-17T04:07:41.860Z"))
  const body = (...records) => [lines[0], ...records]
  const read = async (records) => (await provider.read(await rollout(body(...records)))).entries
  const order = (entries) => entries.filter((entry) => entry.type !== "unread").map((entry) => entry.type === "tool" ? entry.id : entry.type === "user" ? "prompt" : entry.text)
  const asStarted = ["prompt", "exec-300", "exec-301", "STARTED"]

  const whole = await read([...opened, ...cells, ...answered, sleep300, sleep301])
  assert.deepEqual(order(whole), asStarted, "each command is drawn after the cell it started in, before the answer")
  assert.deepEqual(order(await read([...opened, ...cells, ...answered, sleep301, sleep300])), asStarted, "whichever ends first")
  assert.deepEqual(order(await read([...opened, ...cells, sleep300, ...answered, sleep301])), asStarted, "and one written within the turn")
  assert.deepEqual(order(await read([...opened, ...cells.slice(0, 5), sleep300, ...cells.slice(5), ...answered, sleep301])), asStarted,
    "and one written while a later cell runs")
  const twice = command("44.090", "exec-300b", 302, Date.parse("2026-10-17T04:07:40.200Z"))
  assert.deepEqual(order(await read([...opened, ...cells, ...answered, twice, sleep301, sleep300])), ["prompt", "exec-300", "exec-300b", "exec-301", "STARTED"],
    "two from one cell, in the order they started")

  // Each keeps the bytes of the record it came from, and every other entry its own.
  const text = (records) => records.map((line) => `${line}\n`).join("")
  const at = (records, line) => Buffer.byteLength(text(body(...records.slice(0, records.indexOf(line)))))
  const all = [...opened, ...cells, ...answered, sleep300, sleep301]
  const ranges = (entries) => Object.fromEntries(entries.map((entry) => [entry.id, entry.record?.ranges]))
  assert.deepEqual(ranges(whole)["exec-300"], [[at(all, sleep300), at(all, sleep300) + Buffer.byteLength(sleep300) + 1]])
  const unfinished = ranges(await read([...opened, ...cells, ...answered]))
  for (const [id, range] of Object.entries(unfinished)) assert.deepEqual(ranges(whole)[id], range, `${id} names its own record`)

  // A reply being written when the cells ran: the commands go into it, after the cell's own calls, before what followed.
  const thought = [reasoning("35.000", "rs_1", "Listing the tools"), ...cells.slice(0, 3), mcp("40.300", "mcp_docs"), ...cells.slice(3),
    reasoning("42.500", "rs_2", "Both started")]
  const replied = [...opened, ...thought, ...answered, sleep301, sleep300]
  const inReply = await read(replied)
  assert.deepEqual(order(inReply), ["prompt", "Listing the tools", "mcp_docs", "exec-300", "exec-301", "Both started", "STARTED"])
  const before = ranges(await read([...opened, ...thought, ...answered]))
  for (const [id, range] of Object.entries(before)) assert.deepEqual(ranges(inReply)[id], range, `${id} keeps its record`)

  // The merge of the stream, which drew each where it started, and the record: no difference.
  const streamed = asStarted.map((key) => {
    const { record: _record, ...entry } = whole.find((candidate) => order([candidate])[0] === key)
    return entry.type === "tool" ? { ...entry, status: "pending" } : entry
  })
  assert.deepEqual(mergeStream(whole, streamed, CODEX_VOCABULARY.storage.stream).mismatches, [], "record and stream draw them in one order")

  // A decode continued from the turn equals a whole one; a command of a turn begun before the decode asks for a whole one.
  const continued = async (prefix, rest) => {
    const path = await rollout(body(...prefix))
    const first = await provider.read(path)
    await appendFile(path, text(rest))
    const tail = await provider.readFrom(path, first.resume, first.entries[first.resume.entry - 1]?.id)
    return tail && [...first.entries.slice(0, first.resume.entry), ...tail.entries]
  }
  assert.deepEqual(await continued([...opened, ...cells, ...answered], [sleep300, sleep301]), whole, "continued past the answer")
  const later = [task("45.000", "task_started", second), prompt("45.100", "Again"), answer("46.000", "msg_again", "AGAIN"), task("46.100", "task_complete", second)]
  const lateWhole = await read([...opened, ...cells, ...answered, ...later, sleep300, sleep301])
  assert.deepEqual(order(lateWhole), [...asStarted, "prompt", "AGAIN"], "a command that outlives the next turn is still drawn in its own")
  assert.equal(await continued([...opened, ...cells, ...answered, ...later], [sleep300, sleep301]), null, "a decode begun at the next turn can't place it")
  console.log("PASS: a code cell's background commands are drawn where they started, as the stream draws them")
}

await rm(home, { recursive: true, force: true })
