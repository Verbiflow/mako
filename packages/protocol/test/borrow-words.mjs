import assert from "node:assert/strict"
import { test } from "node:test"
import { borrowWords, operationWords, spanWords } from "../dist/borrow-words.js"

const mac = { id: "mac-1", name: "Kashyab's Mac", online: true, lastSeen: 0 }
const now = 10 * 60 * 60_000

test("a wait reads with its reason and its deadline, and a sleeping Mac reads offline, waiting, its waking the person's", () => {
  assert.equal(borrowWords({ pending: "capacity", why: "all-busy", position: 2, since: now - 60_000, deadline: now + 29 * 60_000 }, "ios-simulator", [mac], now), "iOS simulator: on Kashyab's Mac, queued (2nd), starts when it's free; waiting up to 29 min.")
  assert.equal(
    borrowWords({ pending: "capacity", why: "no-device-online", position: 1, since: now, deadline: now + 30 * 60_000 }, "ios-simulator", [{ ...mac, online: false, lastSeen: now - 2 * 60 * 60_000 }], now),
    "iOS simulator: Kashyab's Mac is offline, waiting; waiting up to 30 min. Kashyab's Mac was last seen 2 h ago. Waking it is yours to do."
  )
  assert.match(borrowWords({ pending: "capacity", why: "none-capable", position: 1, since: now, deadline: now + 60 * 60_000 }, "ios-simulator", [], now), /no Mac of yours has an iOS simulator ready; waiting up to 1 h/)
  assert.equal(borrowWords({ pending: "source", ask: "a", source: { kind: "device", device: "mac-1" } }, "ios-simulator", [mac], now), "iOS simulator: asking Kashyab's Mac; it starts once it says yes.")
})

test("every end of a wait reads in words, never silently", () => {
  assert.match(borrowWords({ refusal: { refused: "no-capable-device", why: "all-busy", waited: 30 * 60_000 } }, "ios-simulator", [mac], now), /no Mac could lend an iOS simulator within 30 min \(each was busy\)/)
  assert.match(borrowWords({ refusal: { refused: "declined", by: { kind: "person", account: "a" } } }, "ios-simulator", [mac], now), /declined/)
  for (const refused of ["revoked", "expired", "out-of-scope", "thread-ended"]) assert.ok(borrowWords({ refusal: { refused } }, "ios-simulator", [mac], now).startsWith("iOS simulator: "))
  assert.equal(operationWords("android-emulator"), "an Android emulator")
  assert.equal(operationWords("toaster"), "toaster")
  assert.deepEqual([spanWords(30_000), spanWords(90 * 60_000), spanWords(25 * 60 * 60_000), spanWords(72 * 60 * 60_000)], ["1 min", "2 h", "a day", "3 days"])
})
