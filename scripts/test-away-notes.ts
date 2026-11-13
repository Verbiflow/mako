import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import type { ListedContinue } from "@mako/protocol/continues"
import type { OwnerAnswer, OwnerAsk } from "@mako/protocol/handoff"
import { AwayNotes } from "@mako/host/conversations/away-notes"
import { ownerHold } from "@mako/host/conversations/owner-check"

/*
 * The Sessions a going-away's note named that the account took (`AwayNotes`): they wait for the account's word with no
 * timer, kept on disk through a restart; an account that can't answer leaves them waiting; `departed` joins the
 * continue that took one and `yours` lets it go on here; a gateway with no `owner` lets them all go; and the person's
 * "run it here anyway" is the one way past by hand. The owner check holds a conversation of a held Session.
 */

const sessions = { a: randomUUID(), b: randomUUID(), c: randomUUID() }

function notes(answer: () => Promise<OwnerAnswer | "unserved">, file = join(mkdtempSync(join(tmpdir(), "mako-away-")), "away.json")) {
  const joined: Array<{ session: string; listed: ListedContinue }> = []
  const asked: OwnerAsk[] = []
  let released = 0
  const away = new AwayNotes({
    file,
    owner: () => async (ask) => {
      asked.push(ask)
      return answer()
    },
    deviceId: async () => "8f1c1a52-6c2e-4d8e-9d1e-1b2b3c4d5e6f",
    join: (session, listed) => void joined.push({ session, listed }),
    released: () => void (released += 1),
  })
  return { away, joined, asked, file, released: () => released }
}

test("held with no timer, through a restart, while the account can't answer", async () => {
  let reachable = false
  const n = notes(async () => {
    if (!reachable) throw new Error("offline")
    return { sessions: [{ session: sessions.a, answer: "yours", generation: 3 }] }
  })
  await n.away.noted(randomUUID(), [{ session: sessions.a, generation: 3 }])
  assert.ok(n.away.holds(sessions.a) !== undefined)
  assert.equal(n.away.holds(sessions.b), undefined)
  await n.away.ask()
  assert.ok(n.away.holds(sessions.a) !== undefined, "offline: still held, never given up")
  assert.equal(n.released(), 0)
  // A Mac that shut down and starts again holds it from its first moment.
  const again = new AwayNotes({ file: n.file, owner: () => undefined, deviceId: async () => undefined, join: () => {}, released: () => {} })
  assert.ok(again.holds(sessions.a) !== undefined, "read back from disk")
  reachable = true
  await n.away.ask()
  assert.equal(n.away.holds(sessions.a), undefined, "yours: let go")
  assert.equal(n.released(), 1)
  assert.deepEqual(n.asked.at(-1), { sessions: [{ session: sessions.a, generation: 3 }] }, "asked at the generation it held")
})

test("departed joins the continue that took it; yours goes on here", async () => {
  const op = randomUUID()
  const n = notes(async () => ({
    sessions: [
      { session: sessions.a, answer: "departed", generation: 4, cloudThread: "t-cloud", op, phase: "continued" },
      { session: sessions.b, answer: "yours", generation: 2 },
    ],
  }))
  await n.away.noted(randomUUID(), [{ session: sessions.a, generation: 3 }, { session: sessions.b, generation: 2 }])
  await n.away.ask()
  assert.deepEqual(n.joined.map((each) => ({ session: each.session, op: each.listed.op, cloudThread: each.listed.cloudThread, phase: each.listed.phase })), [{ session: sessions.a, op, cloudThread: "t-cloud", phase: "continued" }])
  assert.equal(n.away.any(), false)
  assert.equal(n.released(), 1)
})

test("a gateway with no owner answer took no note either: all let go", async () => {
  const n = notes(async () => "unserved")
  await n.away.noted(randomUUID(), [{ session: sessions.a, generation: 1 }])
  await n.away.ask()
  assert.equal(n.away.any(), false)
  assert.equal(n.joined.length, 0)
})

test("the person runs a Thread here anyway: only its Sessions let go, once", async () => {
  const n = notes(async () => { throw new Error("offline") })
  await n.away.noted(randomUUID(), [{ session: sessions.a, generation: 1 }, { session: sessions.b, generation: 1 }])
  assert.equal(await n.away.runHere([sessions.a, sessions.c]), 1)
  assert.equal(n.away.holds(sessions.a), undefined)
  assert.ok(n.away.holds(sessions.b) !== undefined)
  assert.equal(await n.away.runHere([sessions.a]), 0, "a repeat lets go of none")
  assert.equal(n.released(), 1)
})

test("going away, nothing asks the account until this Mac is back: it would say the Sessions are this Mac's and end its quiet", async () => {
  const n = notes(async () => ({ sessions: [{ session: sessions.a, answer: "yours", generation: 1 }] }))
  n.away.going()
  await n.away.noted(randomUUID(), [{ session: sessions.a, generation: 1 }])
  await n.away.ask()
  assert.equal(n.asked.length, 0, "the job's ask, before the note went or while the Mac is off: nothing asked")
  assert.ok(n.away.holds(sessions.a) !== undefined, "and nothing let go")
  n.away.back()
  await n.away.ask()
  assert.equal(n.asked.length, 1, "back: asked")
  assert.equal(n.away.holds(sessions.a), undefined, "yours: let go")
  // A host that starts is back: what it reads from disk is asked at once.
  const m = notes(async () => { throw new Error("offline") })
  m.away.going()
  await m.away.noted(randomUUID(), [{ session: sessions.b, generation: 1 }])
  const again = new AwayNotes({ file: m.file, owner: () => async () => "unserved", deviceId: async () => undefined, join: () => {}, released: () => {} })
  await again.ask()
  assert.equal(again.any(), false, "a new host asks, and a gateway with no owner answer lets it go")
})

test("the owner check holds a conversation of a held Session, and nothing else", async () => {
  const n = notes(async () => { throw new Error("offline") })
  await n.away.noted(randomUUID(), [{ session: sessions.a, generation: 1 }])
  const hold = ownerHold({ account: () => ({ ownerCheck: () => undefined }), moves: () => undefined, session: (conversation) => (conversation === "held" ? sessions.a : sessions.b), away: (session) => n.away.holds(session) })
  assert.ok(hold("held", Date.now(), true) !== undefined, "held")
  assert.equal(hold("free", Date.now(), true), undefined, "another Session runs")
})
