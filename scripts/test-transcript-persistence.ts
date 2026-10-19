import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  SessionArchive,
  buildTranscript,
  type ToolDetail,
} from "@mako/sessions"
import { decodeAcpUpdate } from "@mako/sessions/acp-decoder"
import {
  reduceLiveUpdates,
  type LiveUpdate,
} from "@mako/sessions/live-content"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { liveEntries } from "@mako/host/conversations/live-context"
import { entriesToMessages } from "../src/lib/entry-messages.js"
import { pairTools } from "../src/lib/tools.js"
import { highlightCode } from "../src/lib/highlight-code.js"
import { keepCopies } from "../packages/sessions/test/fixtures/archive-copies.mjs"

const root = await mkdtemp(join(tmpdir(), "mako-transcript-persistence-"))
const id = randomUUID()
const details: ToolDetail[] = [
  {
    type: "diff",
    path: "/fixture/app.ts",
    oldText: "before",
    newText: "after",
  },
  { type: "terminal", terminalId: "terminal-proof" },
]
try {
  const updates: LiveUpdate[] = [{ kind: "user", text: "Apply the change" }]
  const decode = (update: Parameters<typeof decodeAcpUpdate>[0]) => {
    for (const item of decodeAcpUpdate(update)) if (item.kind === "update") updates.push(item.update)
  }
  decode({
    sessionUpdate: "tool_call",
    toolCallId: "edit",
    title: "Edit",
    status: "in_progress",
  })
  decode({
    sessionUpdate: "tool_call_update",
    toolCallId: "edit",
    status: "completed",
    content: [
      {
        type: "diff",
        path: "/fixture/app.ts",
        oldText: "before",
        newText: "after",
      },
      { type: "terminal", terminalId: "terminal-proof" },
      {
        type: "content",
        content: { type: "image", data: "cHJvb2Y=", mimeType: "image/png" },
      },
    ],
  })
  const blocks = reduceLiveUpdates([], updates)
  blocks.push({
    type: "event",
    id: "native-compaction-1",
    label: "Context compacted",
    detail: "Automatic",
    body: "The retained summary",
    tone: "warning",
    source: { harness: "fixture", record: "native-compaction-1" },
  })
  const journal = new LiveJournal(root, id)
  journal.commit({
    session: {
      id,
      harness: "fixture",
      cwd: root,
      status: "ready",
      connection: "connected",
      modes: [],
      currentMode: null,
      configOptions: [],
    },
    revision: 1,
    createdAt: 1,
    base: null,
    permissions: [],
    requests: [],
    blocks,
  })
  journal.close()
  const reopened = new LiveJournal(root, id)
  const recovered = reopened.read()!
  reopened.close()
  assert.deepEqual(recovered.blocks, JSON.parse(JSON.stringify(blocks)))
  const messages = entriesToMessages(recovered.blocks, { kind: "live", running: false }).messages
  const call = messages.flatMap((message) => pairTools(message.blocks))[0]!
  assert.deepEqual(call.details, details)
  assert.equal(call.attachments?.[0]?.source.kind, "inline")
  assert.equal(call.pending, false)
  const ref = {
    harness: "fixture",
    nativeId: id,
    path: join(root, "native"),
    bytes: 1,
  }
  const thread = { ref, entries: liveEntries(recovered.blocks) }
  // A copy an earlier build kept in the archive reads back whole.
  await keepCopies(join(root, "archive"), [thread])
  const archive = new SessionArchive(join(root, "archive"))
  const archived = (await archive.read(ref.path))!
  const marker = archived.entries.find((entry) => entry.type === "event")
  assert.deepEqual(marker, {
    type: "event",
    id: "native-compaction-1",
    label: "Context compacted",
    detail: "Automatic",
    body: "The retained summary",
    tone: "warning",
    source: { harness: "fixture", record: "native-compaction-1" },
  })
  await archive.stop()
  const archivedCall = entriesToMessages(archived.entries, { kind: "saved" }).messages.flatMap((message) =>
    pairTools(message.blocks)
  )[0]!
  assert.deepEqual(archivedCall.details, details)
  assert.equal(archivedCall.attachments?.length, 1)
  const transcript = await buildTranscript({ harness: "fixture", entries: archived.entries })
  const carried = [transcript.markdown, ...transcript.files.map((file) => file.bytes.toString("utf8"))].join("\n")
  for (const content of [
    "/fixture/app.ts",
    "before",
    "after",
    "terminal-proof",
  ])
    assert.ok(carried.includes(content), `Replay retains ${content}`)
  const tokens = await highlightCode(
    'const answer = "proof" // retained',
    "typescript"
  )
  assert.equal(
    tokens
      .flat()
      .map((token) => token.content)
      .join(""),
    'const answer = "proof" // retained'
  )
  assert.ok(
    tokens.flat().some((token) => token.color === "var(--shiki-token-comment)")
  )
  assert.ok(
    tokens.flat().some((token) => token.color === "var(--shiki-token-string)")
  )
  console.log(
    "ACP media and typed details survive journal reopen, archive, renderer projection, and replay; syntax tokens retain source and theme variables"
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
