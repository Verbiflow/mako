import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  SessionArchive,
  renderTranscriptBundle,
  type ToolDetail,
} from "@mako/sessions"
import { forward } from "../electron/acp-notifications.js"
import {
  reduceLiveUpdates,
  type LiveUpdate,
} from "../electron/contracts/live-content.js"
import { LiveJournal } from "../electron/live-journal.js"
import { liveEntries } from "../electron/live-context.js"
import { acpBlocksToMessages } from "../src/lib/acp-blocks.js"
import { threadToMessages } from "../src/lib/foreign-thread.js"
import { pairTools } from "../src/lib/tools.js"
import { highlightCode } from "../src/lib/highlight-code.js"

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
  forward(
    { id },
    {
      sessionId: id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "edit",
        title: "Edit",
        status: "in_progress",
      },
    },
    (event) => {
      if (event.type === "live-update") updates.push(event.update)
    },
    () => {}
  )
  forward(
    { id },
    {
      sessionId: id,
      update: {
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
      },
    },
    (event) => {
      if (event.type === "live-update") updates.push(event.update)
    },
    () => {}
  )
  const blocks = reduceLiveUpdates([], updates)
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
  const messages = acpBlocksToMessages(recovered.blocks, false).messages
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
  const archive = new SessionArchive(join(root, "archive"))
  archive.note(ref, async () => thread)
  await archive.flush()
  const archived = (await archive.read(ref.path))!
  await archive.stop()
  const archivedCall = threadToMessages(archived.entries).flatMap((message) =>
    pairTools(message.blocks)
  )[0]!
  assert.deepEqual(archivedCall.details, details)
  assert.equal(archivedCall.attachments?.length, 1)
  const bundle = renderTranscriptBundle(archived)
  for (const content of [
    "/fixture/app.ts",
    "before",
    "after",
    "terminal-proof",
  ])
    assert.ok(bundle.markdown.includes(content), `Replay retains ${content}`)
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
