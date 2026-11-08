import assert from "node:assert/strict"
import type { Lease } from "@mako/protocol/borrow"
import { HeldLeases } from "@mako/host/base/held-leases"

/**
 * Borrowing's one set of lease lifecycle rules, as the source serving (`Lending`) and the borrower using
 * (`BorrowedSimulators`) both hold leases under them: fenced async steps, ended stays ended, renewals by a later expiry
 * only, local expiry, and a release kept until it's confirmed.
 */

function lease(id: string, expiresAt = 1_000): Lease {
  return {
    id,
    grant: "simulators",
    grantVersion: 1,
    borrower: { account: "acct", repository: "acme/shop", thread: "t1", place: { kind: "machine", machine: "m-1" } },
    resource: { kind: "operation", ref: "ios-simulator" },
    source: { kind: "capable", requires: [{ capability: "ios-simulator" }] },
    mode: "relay",
    access: "run",
    version: "g1",
    issuedAt: 0,
    expiresAt,
    delivery: { transfer: "none", secret: false },
    device: "mac",
    session: { state: "starting", heartbeatMs: 60_000, lastBeat: 0 },
  }
}

{
  // A step that began before a release, an end or another lease holds nothing it brings back.
  const held = new HeldLeases()
  const acquiring = held.begin()
  held.invalidate()
  assert.equal(held.take(lease("A"), 0, acquiring), "stale", "released while acquiring")
  const again = held.begin()
  held.end("A")
  assert.equal(held.take(lease("A"), 0, again), "stale", "ended while acquiring")
  assert.equal(held.take(lease("B"), 0, held.begin()), "held")
  const renewing = held.begin()
  held.end("B")
  assert.equal(held.take(lease("C"), 0), "held")
  assert.equal(held.take(lease("B", 5_000), 0, renewing), "stale", "a renewal of a lease since replaced")
  assert.equal(held.get("C")?.expiresAt, 1_000, "and the lease held now is untouched")
}

{
  // Ended stays ended; a renewal is a later expiry only, and never a second hold.
  const held = new HeldLeases()
  held.take(lease("A"), 0)
  assert.equal(held.take(lease("A", 2_000), 0), "renewed")
  assert.equal(held.take(lease("A", 1_500), 0), "same", "an older word never shortens it")
  assert.equal(held.get("A")?.expiresAt, 2_000)
  assert.equal(held.leases().length, 1)
  held.end("A")
  assert.equal(held.take(lease("A", 9_000), 0), "stale", "late word of an ended lease")
  assert.equal(held.take(lease("old", 10), 20), "stale", "one already past its expiry")
}

{
  // Past its expiry, a lease ends here; a list read since a point can say ended only what was held by then.
  const held = new HeldLeases()
  held.take(lease("A", 100), 0)
  const reading = held.begin()
  held.take(lease("B", 500), 0)
  assert.deepEqual(held.heldBefore(reading).map((each) => each.id), ["A"])
  assert.deepEqual(held.expired(100).map((each) => each.id), ["A"])
  assert.equal(held.has("A"), false)
  assert.equal(held.ended("A"), true)
}

{
  // A release is kept until it's confirmed, so one that failed can be tried again.
  const held = new HeldLeases()
  held.releasing("A")
  held.releasing("A")
  assert.deepEqual(held.unreleased(), ["A"])
  held.released("A")
  assert.deepEqual(held.unreleased(), [])
}

console.log("held leases: ok")
