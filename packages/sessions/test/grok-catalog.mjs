import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"
import { GrokProvider } from "../dist/providers/grok.js"

const jsonl = (value) => `${JSON.stringify(value)}\n`

const hook = (sessionId) =>
  jsonl({
    timestamp: 1_767_225_600,
    method: "_x.ai/session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "hook_execution", event_name: "session_start" },
    },
  })

const userPrompt = (sessionId, text) =>
  jsonl({
    timestamp: 1_767_225_601,
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: { type: "text", text },
      },
    },
  })

async function writeSession(home, { id, cwd = "/work", summary, updates }) {
  const dir = join(home, ".grok", "sessions", encodeURIComponent(cwd), id)
  await mkdir(dir, { recursive: true })
  const path = join(dir, "updates.jsonl")
  await writeFile(path, updates)
  await writeFile(
    join(dir, "summary.json"),
    JSON.stringify({
      info: { id, cwd },
      session_summary: "",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:10:00.000Z",
      current_model_id: "grok-4.6",
      ...summary,
    })
  )
  return path
}

const home = await mkdtemp(join(tmpdir(), "mako-grok-catalog-"))
try {
  const placeholderId = "01a09251-b2ee-7943-b684-f500ff97d43c"
  const liveId = "01a093af-a287-7ed3-b0e5-7c2be6e233ea"
  const forkId = "01a093b0-dca7-7ee3-bad6-a92f91b7cece"
  const childId = "01a093b1-d656-7951-a4bc-1068f92c89f1"
  const kindId = "01a093b2-aaaa-7ee3-bad6-a92f91b7cece"

  const placeholderPath = await writeSession(home, {
    id: placeholderId,
    summary: { num_messages: 0 },
    updates: hook(placeholderId),
  })
  const livePath = await writeSession(home, {
    id: liveId,
    summary: { generated_title: "Investigate untitled Grok sessions" },
    updates: hook(liveId) + userPrompt(liveId, "Can we look at Grok sessions"),
  })
  const forkPath = await writeSession(home, {
    id: forkId,
    summary: {
      generated_title: "Forked investigation",
      parent_session_id: liveId,
    },
    updates: userPrompt(forkId, "Continue from the fork"),
  })
  const childPath = await writeSession(home, {
    id: childId,
    summary: {
      generated_title: "Search the catalog module",
      parent_session_id: liveId,
    },
    updates: userPrompt(childId, "Search the catalog module"),
  })
  await mkdir(
    join(home, ".grok", "sessions", encodeURIComponent("/work"), liveId, "subagents", childId),
    { recursive: true }
  )
  await writeFile(
    join(
      home,
      ".grok",
      "sessions",
      encodeURIComponent("/work"),
      liveId,
      "subagents",
      childId,
      "meta.json"
    ),
    JSON.stringify({ sessionKind: "subagent", parentPromptId: "p1" })
  )
  const kindPath = await writeSession(home, {
    id: kindId,
    summary: {
      generated_title: "Explore the store layout",
      session_kind: "subagent",
    },
    updates: userPrompt(kindId, "Explore the store layout"),
  })

  const provider = new GrokProvider(home)
  const files = Object.fromEntries(
    (await provider.discover()).map((file) => [file.path, file])
  )
  assert.equal(await provider.peek(files[placeholderPath]), null, "session/new without a prompt is not a thread")
  assert.equal((await provider.peek(files[livePath])).title, "Investigate untitled Grok sessions")
  assert.equal((await provider.peek(files[forkPath])).title, "Forked investigation", "forks stay in the catalog")
  assert.equal(await provider.peek(files[childPath]), null, "a child recorded under the parent subagents/ dir is not a thread")
  assert.equal(await provider.peek(files[kindPath]), null, "session_kind=subagent is not a thread")

  const catalog = new SessionCatalog([provider])
  const refs = await catalog.scan()
  assert.deepEqual(
    refs.map((ref) => ref.nativeId).sort(),
    [liveId, forkId].sort()
  )

  await writeFile(
    placeholderPath,
    hook(placeholderId) + userPrompt(placeholderId, "Look at Grok untitled sessions")
  )
  const grown = await catalog.scan({ emitChanges: true })
  const placeholder = grown.find((ref) => ref.nativeId === placeholderId)
  assert.equal(placeholder?.title, "Look at Grok untitled sessions")
  assert.deepEqual(
    grown.map((ref) => ref.nativeId).sort(),
    [liveId, forkId, placeholderId].sort(),
    "the first user turn promotes the placeholder to a thread"
  )

  console.log(
    "Grok placeholders stay off the catalog until a user turn; subagent children stay off it; forks remain"
  )
} finally {
  await rm(home, { recursive: true, force: true })
}
