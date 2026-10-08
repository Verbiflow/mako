import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CodexProvider } from "../dist/providers/codex.js"

// A real three-turn rollout Codex 0.159 wrote, from the `resumed` decode pair.
const pair = join(dirname(fileURLToPath(import.meta.url)), "../../../scripts/fixtures/native-decoding/codex/pairs/resumed/home/.codex/sessions/2026/10/07")
const recorded = join(pair, "rollout-2026-10-07T19-47-34-01a11968-b19f-7c73-8e6f-edac2e2edc84.jsonl")
const lines = (await readFile(recorded, "utf8")).split("\n").filter(Boolean)
const starts = lines.flatMap((line, index) => JSON.parse(line).payload?.type === "task_started" ? [index] : [])
assert.equal(starts.length, 3, "the recording holds three turns")

const home = await mkdtemp(join(tmpdir(), "mako-codex-records-"))
const sessions = join(home, ".codex", "sessions")
await mkdir(sessions, { recursive: true })
const provider = new CodexProvider(home)
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
  assert.equal(await entries(await rollout([...lines.slice(0, starts[2]), ...lines.slice(starts[2]), rolledBack(1), ...lines.slice(starts[2])])), whole,
    "the turn run again after a rollback draws as it did the first time")
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
  assert.equal(JSON.stringify(thread.entries), await entries(await rollout(lines)), "records history can't draw leave what it draws alone")
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

await rm(home, { recursive: true, force: true })
