import assert from "node:assert/strict"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CodexSessionActivity } from "@mako/host/harnesses/codex/session-activity"

const root = await mkdtemp(join(tmpdir(), "mako-activity-"))
const id = "01a07995-2e08-7360-8599-291f436c18d8"
const path = join(
  root,
  `rollout-2026-09-07T14-04-53-${id}_01a07db0-30b5-7773-98d6-5ab7500df5e8.jsonl`
)
const signal = new AbortController().signal
const reader = new CodexSessionActivity()
const event = (type: string) =>
  JSON.stringify({ type: "event_msg", payload: { type } }) + "\n"
try {
  await writeFile(path, event("task_started") + event("task_complete"))
  assert.equal(
    (await reader.read(path, signal)).status,
    "open",
    "An idle process holding a completed rollout is not running"
  )
  await appendFile(path, event("task_started"))
  assert.deepEqual(await reader.read(path, signal), {
    path,
    nativeId: id,
    status: "active",
  })
  assert.equal(
    (await reader.read(path, signal)).status,
    "active",
    "A long-running tool stays active without a recency guess"
  )
  const completion = event("task_complete")
  await appendFile(path, completion.slice(0, 20))
  assert.equal((await reader.read(path, signal)).status, "active")
  await appendFile(path, completion.slice(20))
  assert.equal(
    (await reader.read(path, signal)).status,
    "open",
    "An incrementally written completion is read once complete"
  )
  await appendFile(path, event("task_started") + event("turn_aborted"))
  assert.equal((await reader.read(path, signal)).status, "open")
  await writeFile(path, event("task_started"))
  assert.equal(
    (await reader.read(path, signal)).status,
    "active",
    "Truncation resets the checkpoint"
  )
  await appendFile(
    path,
    JSON.stringify({
      type: "response_item",
      payload: "x".repeat(2 * 1024 * 1024),
    }) +
      "\n" +
      event("task_complete")
  )
  assert.equal(
    (await reader.read(path, signal)).status,
    "open",
    "Oversize tool records cannot hide the next lifecycle marker"
  )
  await rm(path)
  await writeFile(path, event("task_complete"))
  assert.equal(
    (await reader.read(path, signal)).status,
    "open",
    "Replacing a file invalidates its prior running state"
  )
  await assert.rejects(reader.read(path, AbortSignal.abort()))
  console.log(
    "Codex activity: completed open files, resumed identity, long tools, partial writes, truncation, oversize records, replacement and cancellation verified"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
