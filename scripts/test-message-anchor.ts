import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageAnchorSchema, resolveAnchor } from "@mako/host/contracts/message-anchor"
import { LiveConversations } from "@mako/host/conversations/live-conversations"
import type { Entry, ThreadRef } from "@mako/host/contracts/conversation-session"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"

type Item = { kind: string; id?: string; at?: number }
const user = (id?: string, at?: number): Item => ({ kind: "user", id, at })
const answer = (id?: string, at?: number): Item => ({ kind: "assistant", id, at })
const answers = (item: Item) => item.kind === "assistant"

// A store whose entries carry ids (Claude, Codex, Cursor): the id is decisive
// wherever the entry now sits.
const withIds = [user("u1", 1), answer("a1", 2), user("u2", 3), answer("a2", 4)]
assert.equal(resolveAnchor(withIds, 0, { index: 1, id: "a1" }, answers), 1)
// The store grew at the front (an earlier page loaded) or was rewritten: the
// remembered index is wrong, the id still finds the answer.
const grown = [answer("a0", 0), ...withIds]
assert.equal(resolveAnchor(grown, 0, { index: 1, id: "a1" }, answers), 2)
assert.equal(resolveAnchor(grown, 0, { index: 3, id: "a2" }, answers), 4)
// A page starting later in the history reports absolute indexes.
assert.equal(resolveAnchor(withIds.slice(2), 2, { index: 3, id: "a2" }, answers), 3)
// An entry that is no longer there is not guessed at.
assert.equal(resolveAnchor(withIds, 0, { index: 1, id: "gone" }, answers), undefined)
// An id on a user entry does not answer for an answer's anchor.
assert.equal(resolveAnchor(withIds, 0, { index: 0, id: "u1" }, answers), undefined)
assert.equal(resolveAnchor(withIds, 0, { index: 0, id: "u1" }), 0)

// An older capture's anchor with a timestamp but no id: the timestamp plus
// kind identifies the entry; two answers at the same time resolve to the one
// nearest the remembered position.
const byTime = [user(undefined, 1), answer(undefined, 2), user(undefined, 3), answer(undefined, 4)]
assert.equal(resolveAnchor(byTime, 0, { index: 1, at: 2 }, answers), 1)
assert.equal(resolveAnchor([answer(undefined, 0), ...byTime], 0, { index: 3, at: 4 }, answers), 4)
const sameTime = [answer(undefined, 5), user(undefined, 5), answer(undefined, 5), answer(undefined, 5)]
assert.equal(resolveAnchor(sameTime, 0, { index: 2, at: 5 }, answers), 2)
assert.equal(resolveAnchor(sameTime, 0, { index: 1, at: 5 }, answers), 0, "nearest of the candidates, never the user entry")
assert.equal(resolveAnchor(byTime, 0, { index: 1, at: 99 }, answers), undefined)

// Neither: only the position, and only while the same kind of entry still
// sits there.
const bare = [user(), answer(), user(), answer()]
assert.equal(resolveAnchor(bare, 0, { index: 3 }, answers), 3)
assert.equal(resolveAnchor(bare, 0, { index: 2 }, answers), undefined)
assert.equal(resolveAnchor(bare, 0, { index: 9 }, answers), undefined)
assert.equal(resolveAnchor(bare.slice(2), 2, { index: 3 }, answers), 3)

// The wire shape a renderer sends.
assert.deepEqual(MessageAnchorSchema.parse({ index: 4, id: "a2", at: 4 }), { index: 4, id: "a2", at: 4 })
assert.throws(() => MessageAnchorSchema.parse({ index: -1 }))
assert.throws(() => MessageAnchorSchema.parse({ index: 1, at: "2026-01-01T00:00:00.000Z" }), "times are epoch milliseconds")

// The host's fork: a captured native history whose store moved since the
// transcript was read still forks at the chosen answer when the renderer
// names it; without a name the moved store is refused as before.
{
  const root = await mkdtemp(join(tmpdir(), "mako-anchor-"))
  const path = "/store/session.jsonl"
  const ref: ThreadRef = { harness: "claude", nativeId: "native-1", path, revision: "r1", bytes: 100, updatedAt: "2026-01-01T00:00:01.000Z" }
  const said = (id: string, text: string): Entry => ({ type: "user", id, text })
  const answered = (id: string, text: string): Entry => ({ type: "text", id, text })
  const entries: Entry[] = [said("u1", "first"), answered("a1", "one"), said("u2", "second"), answered("a2", "two")]
  const owner = new LiveConversations({
    root, appPath: root, driver: () => undefined, emit: () => {},
    history: async () => ({ ref, entries, start: 0, total: entries.length, hasEarlier: false }),
  })
  try {
    const source = await owner.capture(randomUUID(), path)
    assert.ok(source.base)
    const revision = JSON.stringify([ref.revision, ref.bytes, ref.updatedAt])
    const at = (index: number, id: string, rev = revision) => ({ kind: "native" as const, index, revision: rev, anchor: { index, id } })
    const same = owner.fork(source.session.id, { id: randomUUID(), provider: "claude", point: at(1, "a1") })
    assert.equal(same.base?.entries.length, 2, "an unchanged store forks by position")
    const stale = JSON.stringify(["r0", 50, 0])
    const moved = owner.fork(source.session.id, { id: randomUUID(), provider: "claude", point: at(3, "a2", stale) })
    assert.equal(moved.base?.entries.length, 4, "a moved store forks at the answer the anchor names")
    assert.equal(moved.base?.entries.at(-1)?.id, "a2")
    assert.throws(
      () => owner.fork(source.session.id, { id: randomUUID(), provider: "claude", point: { kind: "native", index: 3, revision: stale } }),
      /Reload it before choosing a fork point/,
      "a moved store with no anchor is refused"
    )
    assert.throws(
      () => owner.fork(source.session.id, { id: randomUUID(), provider: "claude", point: at(3, "gone", stale) }),
      /no longer in it/,
      "an anchor the moved store no longer holds is refused by name"
    )
    assert.throws(
      () => owner.fork(source.session.id, { id: randomUUID(), provider: "claude", point: at(0, "u1") }),
      /answer present/,
      "a user entry is never a fork point"
    )
  } finally {
    owner.stop()
    await rm(root, { recursive: true, force: true })
  }
}

// A live Session whose turns a checkpoint covered: the native history read
// afterwards replaced those blocks. A fork after the last covered answer still
// starts from it; an earlier one goes on from the live record, or is named by
// its native message.
{
  const { LiveJournal } = await import("@mako/host/conversations/live-journal")
  const root = await mkdtemp(join(tmpdir(), "mako-anchor-covered-"))
  const id = randomUUID()
  const r1 = randomUUID()
  const r2 = randomUUID()
  const path = "/store/live.jsonl"
  const ref: ThreadRef = { harness: "claude", nativeId: "native-live", path, revision: "r2", bytes: 200, updatedAt: "2026-01-01T00:00:02.000Z" }
  const entries: Entry[] = [
    { type: "user", id: "u1", text: "first" }, { type: "text", id: "a1", text: "one" },
    { type: "user", id: "u2", text: "second" }, { type: "text", id: "a2", text: "two" },
  ]
  const journal = new LiveJournal(root, id)
  journal.commit({
    session: { id, harness: "claude", cwd: root, connection: "disconnected", status: "ready", modes: [], currentMode: null, configOptions: [] },
    revision: 0, createdAt: 1, base: null, permissions: [],
    requests: [
      { id: r1, text: "first", attachments: [], status: "completed" },
      { id: r2, text: "second", attachments: [], status: "completed" },
    ],
    blocks: [
      { type: "user", requestId: r1, text: "first" }, { type: "text", id: "t1", text: "one" },
      { type: "user", requestId: r2, text: "second" }, { type: "text", id: "t2", text: "two" },
    ],
    control: { activeBindingId: id, bindings: [{ id, provider: "claude", nativeId: "native-live", path, includesBase: true, coveredBlocks: 4 }], transfers: [], actions: [], merges: [] },
  })
  journal.close()
  const owner = new LiveConversations({
    root, appPath: root, driver: () => undefined, emit: () => {},
    history: async () => ({ ref, entries, start: 0, total: entries.length, hasEarlier: false, checkpoint: 2 }),
  })
  try {
    assert.equal((await owner.refreshedSnapshot(id))?.baseCoveredBlocks, 4)
    const last = owner.fork(id, { id: randomUUID(), provider: "claude", point: { kind: "run", requestId: r2 } })
    assert.deepEqual(last.base?.entries.map((entry) => entry.id), ["u1", "a1", "u2", "a2"], "the last covered answer forks from the native history that ends at it")
    const moved = owner.fork(id, { id: randomUUID(), provider: "claude", point: { kind: "run", requestId: r2 }, thread: "parent", move: true }, join(root, "worktree"))
    assert.equal(moved.session.cwd, join(root, "worktree"), "Continue in a worktree takes the same answer into its own folder")
    assert.deepEqual(moved.base?.entries.map((entry) => entry.id), ["u1", "a1", "u2", "a2"])
    const said = (fork: LiveSnapshot) => fork.base?.entries.map((entry) => entry.type === "user" || entry.type === "text" ? entry.text : entry.type)
    assert.deepEqual(said(owner.fork(id, { id: randomUUID(), provider: "claude", point: { kind: "run", requestId: r1 } })), ["first", "one"],
      "an earlier covered answer forks from the live record up to it")
    assert.deepEqual(said(owner.fork(id, { id: randomUUID(), provider: "claude", point: { kind: "before-run", requestId: r2 } })), ["first", "one"],
      "a covered prompt's edge is the live record before it")
    const revision = JSON.stringify([ref.revision, ref.bytes, ref.updatedAt])
    const earlier = owner.fork(id, { id: randomUUID(), provider: "claude", point: { kind: "native", index: 1, revision, anchor: { index: 1, id: "a1" } } })
    assert.deepEqual(earlier.base?.entries.map((entry) => entry.id), ["u1", "a1"], "the panel names an earlier covered answer by its native message")
  } finally {
    owner.stop()
    await rm(root, { recursive: true, force: true })
  }
}

console.log("Message anchors: id, timestamp and positional resolution across moved stores, and the host fork that lands on the named answer passed")
