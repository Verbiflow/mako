import assert from "node:assert/strict"
import { test } from "node:test"
import type { ThreadListing } from "@mako/protocol/thread-listing"
import { AccountThreads } from "@mako/host/conversations/account-threads"
import { runtimeListing } from "@mako/host/conversations/thread-listing"
import type { LifecycleWork } from "@mako/host/contracts/app-lifecycle"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"

/**
 * The account's list of Threads on both of its ends in Mako: what a cloud machine says of its conversations
 * (`runtimeListing`), and a device holding the list in step with the account's stream (`AccountThreads`).
 */

const summary = (id: string, createdAt: number, session: Partial<LiveSummary["session"]> = {}, ids: Partial<Pick<LiveSummary, "threadId" | "sessionId">> = {}): LiveSummary => ({
  session: { id, harness: "codex", cwd: "/Users/ana/api", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [], ...session },
  revision: 1,
  createdAt,
  ...ids,
})
const work = (id: string, status: LifecycleWork["status"]): LifecycleWork => ({ id, token: id, title: "", provider: "codex", cwd: "", status, stoppable: true })

test("a machine lists its conversations newest first, each as the lifecycle sees it: at work, waiting on a person, or as its session stands", () => {
  const thread = "6f1c9a52-0d4e-4b8e-9a51-3f2c7d1e8b40"
  const listing = runtimeListing(
    [
      summary("old", 1_000, { status: "failed", title: "Fix the flaky test" }),
      summary("waiting", 3_000, { status: "running" }, { threadId: thread, sessionId: "0b8f3e1a-7c2d-4f6a-9e5b-1d3c8a7f2e60" }),
      summary("background", 2_000, { status: "ready" }),
      summary("idle", 4_000),
      summary("closed", 500, { status: "closed" }),
      summary("not-a-harness", 5_000, { harness: "Some Harness" }),
      summary("local-ids", 600, {}, { threadId: "thread-1" }),
    ],
    [work("waiting", "waiting"), work("background", "running")]
  )
  assert.deepEqual(listing.conversations.map((conversation) => [conversation.id, conversation.state]), [
    ["idle", "idle"],
    ["waiting", "waiting"],
    ["background", "working"],
    ["old", "failed"],
    ["local-ids", "idle"],
    ["closed", "closed"],
  ], "newest first; background work counts as work; a harness the protocol can't name is left out, not the rest")
  const waiting = listing.conversations.find((conversation) => conversation.id === "waiting")
  assert.equal(waiting?.thread, thread)
  assert.equal(waiting?.createdAt, new Date(3_000).toISOString())
  assert.equal(listing.conversations.find((conversation) => conversation.id === "local-ids")?.thread, undefined, "a Thread ID that isn't a UUID isn't carried")
  assert.equal(listing.conversations.find((conversation) => conversation.id === "old")?.title, "Fix the flaky test")
})

test("a long title is cut for a row, and at most fifty conversations are listed, the newest", () => {
  const many = Array.from({ length: 60 }, (_, index) => summary(`c-${index}`, index, { title: "x".repeat(300) }))
  const listing = runtimeListing(many, [])
  assert.equal(listing.conversations.length, 50)
  assert.equal(listing.conversations[0]?.id, "c-59")
  assert.equal(listing.conversations[0]?.title?.length, 200)
  assert.ok(listing.conversations[0]?.title?.endsWith("…"))
})

const listing = (threadId: string, state: "working" | "idle" = "idle"): ThreadListing => ({
  threadId,
  home: "cloud",
  repository: { url: "https://github.com/ana/api" },
  conversations: [{ id: `${threadId}-c`, harness: "claude", state, createdAt: "2026-10-24T20:00:00.000Z" }],
  updatedAt: "2026-10-24T20:00:00.000Z",
})

test("a device's list is the one it read, then each change the stream said after it, in order; one said twice or before the read changes nothing", () => {
  const list = new AccountThreads()
  assert.equal(list.known, false)
  // Heard before the list answered: waits for it.
  assert.equal(list.heard({ seq: 12, event: { type: "thread-listed", thread: listing("t-0000000000000003") } }), false)
  assert.equal(list.heard({ seq: 9, event: { type: "thread-unlisted", threadId: "t-0000000000000001", reason: "ended" } }), false)
  assert.equal(list.listed({ threads: [listing("t-0000000000000001"), listing("t-0000000000000002")], seq: 10 }), true)
  assert.deepEqual([...list.threads().keys()].sort(), ["t-0000000000000001", "t-0000000000000002", "t-0000000000000003"], "the change from before the read that's newer than it applies; the older one doesn't")
  assert.equal(list.heard({ seq: 12, event: { type: "thread-listed", thread: listing("t-0000000000000003", "working") } }), false, "heard twice")
  assert.equal(list.threads().get("t-0000000000000003")?.conversations[0]?.state, "idle")
  assert.equal(list.heard({ seq: 13, event: { type: "thread-listed", thread: listing("t-0000000000000003", "working") } }), true)
  assert.equal(list.threads().get("t-0000000000000003")?.conversations[0]?.state, "working")
  assert.equal(list.heard({ seq: 14, event: { type: "thread-unlisted", threadId: "t-0000000000000002", reason: "returned" } }), true)
  assert.equal(list.heard({ seq: 15, event: { type: "thread-unlisted", threadId: "t-0000000000000002", reason: "returned" } }), false, "already gone")
  assert.deepEqual([...list.threads().keys()].sort(), ["t-0000000000000001", "t-0000000000000003"])
  // Read again, the same: nothing changed.
  assert.equal(list.listed({ threads: [...list.threads().values()], seq: 15 }), false)
  list.clear()
  assert.equal(list.known, false)
  assert.equal(list.threads().size, 0)
})
