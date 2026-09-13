import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MessageAnchorSchema, resolveAnchor } from "../electron/contracts/message-anchor.js"
import { LiveConversations } from "../electron/live-conversations.js"
import type { ThreadEntry, ThreadRef } from "../electron/shared.js"

type Entry = { kind: string; id?: string; at?: string }
const user = (id?: string, at?: string): Entry => ({ kind: "user", id, at })
const answer = (id?: string, at?: string): Entry => ({ kind: "assistant", id, at })

// A store whose messages carry ids (Claude, Codex, Cursor): the id is decisive
// wherever the message now sits.
const withIds = [user("u1", "t1"), answer("a1", "t2"), user("u2", "t3"), answer("a2", "t4")]
assert.equal(resolveAnchor(withIds, 0, { index: 1, id: "a1" }, "assistant"), 1)
// The store grew at the front (an earlier page loaded) or was rewritten: the
// remembered index is wrong, the id still finds the answer.
const grown = [answer("a0", "t0"), ...withIds]
assert.equal(resolveAnchor(grown, 0, { index: 1, id: "a1" }, "assistant"), 2)
assert.equal(resolveAnchor(grown, 0, { index: 3, id: "a2" }, "assistant"), 4)
// A page starting later in the history reports absolute indexes.
assert.equal(resolveAnchor(withIds.slice(2), 2, { index: 3, id: "a2" }, "assistant"), 3)
// A message that is no longer there is not guessed at.
assert.equal(resolveAnchor(withIds, 0, { index: 1, id: "gone" }, "assistant"), undefined)
// An id on a user entry does not answer for an assistant anchor.
assert.equal(resolveAnchor(withIds, 0, { index: 0, id: "u1" }, "assistant"), undefined)
assert.equal(resolveAnchor(withIds, 0, { index: 0, id: "u1" }), 0)

// A store with timestamps but no ids (Grok, OpenCode): the timestamp plus kind
// identifies the message; two answers in the same second resolve to the one
// nearest the remembered position.
const byTime = [user(undefined, "t1"), answer(undefined, "t2"), user(undefined, "t3"), answer(undefined, "t4")]
assert.equal(resolveAnchor(byTime, 0, { index: 1, at: "t2" }, "assistant"), 1)
assert.equal(resolveAnchor([answer(undefined, "t0"), ...byTime], 0, { index: 3, at: "t4" }, "assistant"), 4)
const sameSecond = [answer(undefined, "t"), user(undefined, "t"), answer(undefined, "t"), answer(undefined, "t")]
assert.equal(resolveAnchor(sameSecond, 0, { index: 2, at: "t" }, "assistant"), 2)
assert.equal(resolveAnchor(sameSecond, 0, { index: 1, at: "t" }, "assistant"), 0, "nearest of the candidates, never the user entry")
assert.equal(resolveAnchor(byTime, 0, { index: 1, at: "never" }, "assistant"), undefined)

// A store with neither: only the position, and only while the same kind of
// entry still sits there.
const bare = [user(), answer(), user(), answer()]
assert.equal(resolveAnchor(bare, 0, { index: 3 }, "assistant"), 3)
assert.equal(resolveAnchor(bare, 0, { index: 2 }, "assistant"), undefined)
assert.equal(resolveAnchor(bare, 0, { index: 9 }, "assistant"), undefined)
assert.equal(resolveAnchor(bare.slice(2), 2, { index: 3 }, "assistant"), 3)

// The wire shape a renderer sends.
assert.deepEqual(MessageAnchorSchema.parse({ index: 4, id: "a2", at: "t4" }), { index: 4, id: "a2", at: "t4" })
assert.throws(() => MessageAnchorSchema.parse({ index: -1 }))

// The host's fork: a captured native history whose store moved since the
// transcript was read still forks at the chosen answer when the renderer
// names it; without a name the moved store is refused as before.
{
  const root = await mkdtemp(join(tmpdir(), "mako-anchor-"))
  const path = "/store/session.jsonl"
  const ref: ThreadRef = { harness: "claude", nativeId: "native-1", path, revision: "r1", bytes: 100, updatedAt: 1 }
  const said = (id: string, text: string): ThreadEntry => ({ kind: "user", id, text })
  const answered = (id: string, text: string): ThreadEntry => ({ kind: "assistant", id, blocks: [{ type: "text", text }] })
  const entries: ThreadEntry[] = [said("u1", "first"), answered("a1", "one"), said("u2", "second"), answered("a2", "two")]
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

console.log("Message anchors: id, timestamp and positional resolution across moved stores, and the host fork that lands on the named answer passed")
