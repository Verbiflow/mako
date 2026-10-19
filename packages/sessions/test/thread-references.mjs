import assert from "node:assert/strict"

import {
  findThreadReference,
  parseThreadReferenceAppendix,
  prefetchThreadReferences,
  prepareThreadReferences,
} from "../../../src/lib/thread-references.ts"
import { threadReferenceId, threadToken } from "../../../src/lib/mentions.ts"
import { sentDraft, writeDraft } from "../../../src/lib/context/draft.ts"
import { readSent } from "../../../src/lib/context/sent.ts"
import { readMessage } from "../../../src/lib/context/wire.ts"
import { transcriptNote } from "../src/transcript-builder.ts"

/** A draft as the composer sends it: its conversations prepared, then written. */
async function send(text, threads, options) {
  return writeDraft({ draft: text, records: [], conversations: await prepareThreadReferences(text, threads, options) }).text
}
/** A sent prompt as Reuse puts it back. */
function reuse(text) {
  return sentDraft(readSent(text)).text
}
const words = (text) => readMessage(text).body
const conversations = (text) => readSent(text).items.filter((item) => item.kind === "conversation").map((item) => item.conversation)

function installBridge(contextFor) {
  const calls = []
  globalThis.window = {
    mako: {
      threadContexts: async (paths, options) => {
        calls.push({ paths, options })
        // The host hands each transcript over with its note, as the catalog does.
        return paths.map((path) => {
          const context = contextFor(path, options)
          return context && { ...context, note: transcriptNote(context.file, { turns: 2 }, context.harness), turns: 2, digest: "0".repeat(64), losses: [] }
        })
      },
    },
  }
  return calls
}

const localThread = {
  harness: "codex",
  nativeId: "session-exact-1234567890",
  path: "/sessions/exact.jsonl",
  title: "Exact local reference",
}
const localToken = threadToken(localThread.harness, localThread.nativeId)
const localCalls = installBridge(() => ({
  kind: "file",
  file: `/content-addressed/sha256-abc/transcript.md`,
  title: localThread.title,
  harness: localThread.harness,
}))
const local = await send(`Compare ${localToken} before editing.`, [localThread])
assert.equal(words(local), "Compare [Conversation 1: Exact local reference] before editing.", "the words carry the marker, never the raw token")
assert.ok(local.includes("This conversation's history (codex, 2 turns) is in /content-addressed/sha256-abc/transcript.md."), "the item's body is the host's note")
assert.ok(local.includes("newest first"))
assert.deepEqual(localCalls, [{ paths: [localThread.path], options: undefined }])
// The item names the token the marker stands for, so the transcript can
// draw the chip again and a reused prompt references again.
assert.deepEqual(conversations(local), [{ ref: localToken.slice(1), harness: "codex", title: "Exact local reference" }])
assert.equal(reuse(local), `Compare ${localToken} before editing.`, "Reuse puts the token back where the marker stood")
const punctuated = await send(`${localToken}?`, [localThread])
assert.equal(reuse(punctuated), `${localToken}?`, "sentence punctuation after the chip stays prose after the token")

// A prompt sent before headings carried tokens: the title and harness are
// all that is known, and a title's own parentheses are not a harness when
// the heading also names one.
const legacy = parseThreadReferenceAppendix(
  "Ask [Referenced conversation 1] and [Referenced conversation 2].\n\n---\n[Referenced conversation 1] Older thread (with notes) (claude)\n\nLocal transcript bundle: /tmp/a\n\n[Referenced conversation 2] Untitled conversation\n\nThis referenced conversation is unavailable or no longer exists. Do not infer its contents."
)
assert.equal(legacy.body, "Ask [Referenced conversation 1] and [Referenced conversation 2].")
assert.deepEqual(legacy.references, [
  { number: 1, title: "Older thread (with notes)", harness: "claude" },
  { number: 2, title: "Untitled conversation" },
])
assert.equal(
  reuse("Ask [Referenced conversation 1] and [Referenced conversation 2].\n\n---\n[Referenced conversation 1] Older thread (with notes) (claude)\n\nLocal transcript bundle: /tmp/a\n\n[Referenced conversation 2] Untitled conversation\n\nThis referenced conversation is unavailable or no longer exists. Do not infer its contents."),
  "Ask Older thread (with notes) and Untitled conversation.",
  "an old prompt without tokens reuses its titles as words"
)
assert.deepEqual(parseThreadReferenceAppendix("No appendix here"), {
  body: "No appendix here",
  references: [],
})

// A title ending in parentheses keeps them when the token says the harness
// is something else; a heading out of sequence is a quote inside an inline
// bundle, not a reference.
const parenthetical = parseThreadReferenceAppendix(
  `Read [Referenced conversation 1].\n\n---\n[Referenced conversation 1] Sync (draft) (grok) — ${threadToken("grok", "abc")}\n\nbundle\n\n[Referenced conversation 3] Quoted heading (codex) — ${threadToken("codex", "zzz")}`
)
assert.deepEqual(parenthetical.references, [
  { number: 1, title: "Sync (draft)", harness: "grok", token: { harness: "grok", id: "abc" } },
])
const foreignParens = parseThreadReferenceAppendix(
  `Read [Referenced conversation 1].\n\n---\n[Referenced conversation 1] Ends (like this) — ${threadToken("grok", "abc")}`
)
assert.deepEqual(foreignParens.references, [
  { number: 1, title: "Ends (like this)", harness: "grok", token: { harness: "grok", id: "abc" } },
])

const duplicateThread = {
  harness: "claude",
  nativeId: "duplicate-reference-id",
  path: "/sessions/duplicate.jsonl",
  title: "Only once",
}
const duplicateToken = threadToken(duplicateThread.harness, duplicateThread.nativeId)
const duplicateCalls = installBridge(() => ({
  kind: "file",
  file: "/content-addressed/duplicate/transcript.md",
  title: duplicateThread.title,
  harness: duplicateThread.harness,
}))
const duplicate = await send(`${duplicateToken} and again ${duplicateToken}`, [duplicateThread])
assert.equal(words(duplicate), "[Conversation 1: Only once] and again [Conversation 1: Only once]", "one conversation named twice is one item")
assert.equal(readSent(duplicate).items.length, 1)
assert.deepEqual(duplicateCalls[0]?.paths, [duplicateThread.path])

const missingToken = threadToken("cursor", "deleted-reference")
const missingCalls = installBridge(() => {
  throw new Error("an unresolved token must not request an arbitrary path")
})
const missing = await send(`Recall ${missingToken}`, [])
assert.equal(words(missing), "Recall [Conversation 1: Untitled conversation]")
assert.ok(missing.includes("unavailable or no longer exists"))
assert.equal(missingCalls.length, 0)
// An unresolved reference still reads back as the chip that was typed: the
// item carries the token as written, since no catalog row could improve it.
assert.deepEqual(conversations(missing), [{ ref: missingToken.slice(1), harness: "cursor", title: "Untitled conversation" }])
assert.equal(reuse(missing), `Recall ${missingToken}`)

const colliding = [
  {
    harness: "codex",
    nativeId: "collision-prefix-alpha",
    path: "/sessions/collision-a.jsonl",
  },
  {
    harness: "codex",
    nativeId: "collision-prefix-beta",
    path: "/sessions/collision-b.jsonl",
  },
]
const collisionCalls = installBridge(() => {
  throw new Error("an ambiguous prefix must not select either conversation")
})
const collision = await send("Check @thread:codex:collision-prefix", colliding)
assert.equal(words(collision), "Check [Conversation 1: Untitled conversation]")
assert.ok(collision.includes("unavailable or no longer exists"))
assert.equal(collisionCalls.length, 0)

// Cursor writes a `cursor-agent -p --resume` continuation of an ACP session as
// a second store under chats/ with the same agent id; the catalog keeps both,
// the copy carrying `identity: "chats:<id>"`. A token minted from the native
// id alone once matched both rows and resolved to neither, so the sent prompt
// said the conversation no longer existed while its chip showed a title.
const forkId = "90a422d6-9c64-4ef2-bea9-807cb93a2abd"
const forkOriginal = {
  harness: "cursor",
  nativeId: forkId,
  path: `/cursor/acp-sessions/${forkId}/store.db`,
  title: "Fork original",
}
const forkCopy = {
  harness: "cursor",
  nativeId: forkId,
  identity: `chats:${forkId}`,
  liveResume: false,
  path: `/cursor/chats/workspace/${forkId}/store.db`,
  title: "Fork CLI continuation",
}
const forkThreads = [forkCopy, forkOriginal]
assert.equal(findThreadReference(forkThreads, "cursor", forkId), forkOriginal, "a bare native id means the original store")
assert.equal(findThreadReference(forkThreads, "cursor", `chats:${forkId}`), forkCopy, "the identity names the chats copy")
assert.equal(findThreadReference(forkThreads, "cursor", forkId.slice(0, 8)), forkOriginal, "a shortened id predates identities and means the original")
assert.equal(findThreadReference([forkCopy], "cursor", forkId), forkCopy, "the only remaining store answers its native id")
assert.equal(findThreadReference(forkThreads, "codex", forkId), undefined, "the harness is part of the token")
assert.equal(
  findThreadReference([forkOriginal, { ...forkOriginal, path: "/cursor/other/store.db" }], "cursor", forkId),
  undefined,
  "two originals sharing one native id stay ambiguous"
)
assert.notEqual(
  threadToken(forkCopy.harness, threadReferenceId(forkCopy)),
  threadToken(forkOriginal.harness, threadReferenceId(forkOriginal)),
  "the mention menu must mint distinct tokens for the two stores"
)
// The same session id resumed from another folder is a third conversation.
const forkElsewhere = {
  ...forkCopy,
  identity: `chats:elsewhere:${forkId}`,
  path: `/cursor/chats/elsewhere/${forkId}/store.db`,
  title: "Fork resumed elsewhere",
}
assert.equal(findThreadReference([forkElsewhere, forkCopy], "cursor", forkId), forkCopy, "without an original, a bare native id means the first chats store")
assert.equal(findThreadReference([forkElsewhere, forkCopy, forkOriginal], "cursor", forkId), forkOriginal, "the original still wins")
assert.equal(findThreadReference([forkElsewhere, forkCopy], "cursor", `chats:elsewhere:${forkId}`), forkElsewhere, "its identity names it")
const forkCalls = installBridge((path) => ({
  kind: "file",
  file: `/content-addressed/${path.includes("/chats/") ? "fork-copy" : "fork-original"}/transcript.md`,
  title: path.includes("/chats/") ? forkCopy.title : forkOriginal.title,
  harness: "cursor",
}))
const forked = await send(
  `Continue ${threadToken("cursor", forkId)} and compare ${threadToken("cursor", threadReferenceId(forkCopy))}.`,
  forkThreads
)
assert.ok(!forked.includes("unavailable or no longer exists"), "both stores of a forked session must resolve")
assert.equal(words(forked), "Continue [Conversation 1: Fork original] and compare [Conversation 2: Fork CLI continuation].")
assert.ok(forked.includes("/content-addressed/fork-original/transcript.md"))
assert.ok(forked.includes("/content-addressed/fork-copy/transcript.md"))
assert.deepEqual(forkCalls[0]?.paths, [forkOriginal.path, forkCopy.path])
// Each item carries the catalog's own token for its store, so reusing the
// prompt names the two stores as distinctly as the menu minted them.
assert.deepEqual(
  conversations(forked).map((entry) => entry.ref),
  [threadToken("cursor", forkId).slice(1), threadToken("cursor", `chats:${forkId}`).slice(1)]
)
assert.equal(
  reuse(forked),
  `Continue ${threadToken("cursor", forkId)} and compare ${threadToken("cursor", threadReferenceId(forkCopy))}.`
)

// A shortened id from an old draft resolves to one conversation and its
// item carries that conversation's whole token.
const shortened = await send(`See ${threadToken("cursor", forkId.slice(0, 8))}`, [forkOriginal])
assert.equal(conversations(shortened)[0]?.ref, threadToken("cursor", forkId).slice(1))

const staleThread = {
  harness: "devin",
  nativeId: "stale-after-prefetch",
  path: "/sessions/devin.db#stale-after-prefetch",
  title: "Survives catalog refresh",
}
const staleToken = threadToken(staleThread.harness, staleThread.nativeId)
const staleCalls = installBridge(() => ({
  kind: "file",
  file: "/content-addressed/stale/transcript.md",
  title: staleThread.title,
  harness: staleThread.harness,
}))
prefetchThreadReferences(staleToken, [staleThread])
const stale = await send(staleToken, [])
assert.ok(stale.includes("/content-addressed/stale/transcript.md"))
assert.equal(staleCalls.length, 1, "prefetch should be reused after the catalog entry disappears")

const growingThread = {
  harness: "claude",
  nativeId: "growing-reference",
  path: "/sessions/growing.jsonl",
  title: "Growing reference",
  bytes: 10,
  updatedAt: "2026-08-19T00:00:00.000Z",
}
let generation = 0
const growingCalls = installBridge(() => ({
  kind: "file",
  file: `/content-addressed/growing-${++generation}/transcript.md`,
  title: growingThread.title,
  harness: growingThread.harness,
}))
const growingToken = threadToken(growingThread.harness, growingThread.nativeId)
const firstGrowth = await send(growingToken, [growingThread])
const secondGrowth = await send(growingToken, [
  { ...growingThread, bytes: 20, updatedAt: "2026-08-19T00:01:00.000Z" },
])
assert.ok(firstGrowth.includes("growing-1"))
assert.ok(secondGrowth.includes("growing-2"))
assert.equal(growingCalls.length, 2, "a grown thread must invalidate its prepared context")

console.log("Thread reference tests clean: markers, item tokens, read-back and Reuse, legacy headings, local, missing, collisions, duplicates, forked stores, growth, and stale recovery verified.")
