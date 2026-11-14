import assert from "node:assert/strict"
import { test } from "node:test"
import { Inbox, Payload, type EventFrame, type Subscription } from "@mako/protocol"
import type { AccountEvent } from "@mako/protocol/account-events"
import type { ListedSession } from "@mako/protocol/thread-listing"
import { AccountList, accountListStore } from "../src/web-client/account-list"
import { Gateway } from "../src/web-client/gateway"

/**
 * A browser's list while its page is hidden (`AccountList.park`): the account's stream is let go and nothing is applied,
 * and shown again it's followed after the last number the list applied, the account replaying what happened meanwhile
 * in order and once each, with no read of the whole list. A gap on the replay, or a stream that failed, reads it whole
 * as before.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const MAC = uuid(900)
const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 10, minutes)).toISOString()
const row = (n: number, state: ListedSession["state"] = "idle", minute = 0): ListedSession => ({
  session: uuid(n), thread: uuid(100 + n), conversation: uuid(200 + n), harness: "codex", title: `Session ${n}`, state, folder: "/srv/api",
  createdAt: at(0), activityAt: at(minute), generation: 1, runsOn: { kind: "device", deviceId: MAC }, listedAt: at(minute),
})

/**
 * The account as a browser meets it: a numbered log every event is kept in, a read of the list at the log's number, and
 * a stream that replays the log after the number it's asked from, then each event as it's kept. `trimmedTo` drops the
 * log's start, as a log kept bounded would, so a follow from before it is said `lost`.
 */
function account() {
  const log: Array<{ seq: number; event: AccountEvent }> = []
  const listed = new Map<string, ListedSession>()
  const subscribes: number[] = []
  const counts = { reads: 0, subscribes, delivered: 0 }
  let trimmedTo = 0
  let open: { inbox: Inbox<EventFrame>; after: number } | undefined
  const frame = (seq: number, event: AccountEvent | { type: "lost" }) => {
    // SAFETY: an event frame as the list reads one: its number and its payload, nothing else of the envelope.
    return { seq, event: Payload.of(event) } as EventFrame
  }
  const deliver = (seq: number, event: AccountEvent) => {
    if (!open || open.inbox.closed || seq <= open.after) return
    counts.delivered += 1
    open.inbox.push(frame(seq, event))
  }
  const gateway = new Gateway({ origin: "https://app.example.com", connect: async () => ({ token: "t", expiresAt: Date.now() + 300_000, deviceId: uuid(1), account: { id: "ana", name: "Ana", email: "ana@example.com", image: null, entitlements: [] } }) })
  Object.defineProperty(gateway, "rest", {
    value: async (_method: string, path: string) => {
      if (path === "/v1/sessions") {
        counts.reads += 1
        return { sessions: [...listed.values()], seq: log.at(-1)?.seq ?? 0 }
      }
      if (path === "/v1/devices") return { devices: [] }
      throw new Error(`no ${path} in this test`)
    },
  })
  const subscribe = ({ after }: { after: number }): Subscription => {
    counts.subscribes.push(after)
    const inbox = new Inbox<EventFrame>()
    open = { inbox, after }
    if (after < trimmedTo) inbox.push(frame(trimmedTo + 1, { type: "lost" }))
    else for (const kept of log) if (kept.seq > after) {
      counts.delivered += 1
      inbox.push(frame(kept.seq, kept.event))
    }
    return { next: (ms) => inbox.next(ms), close: () => inbox.close() }
  }
  Object.defineProperty(gateway, "session", { value: { subscribe, close: () => {}, wake: () => {}, probe: () => {} } })
  return {
    gateway,
    counts,
    /** An event kept in the log, and sent to a browser following the stream now. */
    keep(event: AccountEvent) {
      const seq = (log.at(-1)?.seq ?? 0) + 1
      log.push({ seq, event })
      if (event.type === "sessions-listed") for (const each of event.sessions) listed.set(each.session, each)
      deliver(seq, event)
      return seq
    },
    /** A kept event sent again on the open stream, as a frame in flight at a park and resent would be. */
    resend(seq: number) {
      const kept = log.find((each) => each.seq === seq)
      if (kept && open && !open.inbox.closed) open.inbox.push(frame(kept.seq, kept.event))
    },
    /** The log keeps nothing up to `seq` from now. */
    trim(seq: number) {
      trimmedTo = seq
    },
    /** The stream's socket dropped under the browser, as a network does. */
    drop() {
      open?.inbox.close()
    },
    following: () => Boolean(open && !open.inbox.closed),
    rows: () => [...listed.values()],
  }
}

const shown = () => new Map(accountListStore.get().rows.map((each) => [each.session, each.state]))
const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
async function until(what: string, check: () => boolean) {
  const deadline = Date.now() + 3_000
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`)
    await settle()
  }
}

function browser() {
  const storage = new Map<string, string>()
  const held = Object.getOwnPropertyDescriptor(globalThis, "localStorage")
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) } })
  const before = accountListStore.get()
  const cloud = account()
  const list = new AccountList(cloud.gateway, "ana")
  return {
    cloud,
    list,
    close() {
      list.stop()
      accountListStore.set(before)
      if (held) Object.defineProperty(globalThis, "localStorage", held)
      else Reflect.deleteProperty(globalThis, "localStorage")
    },
  }
}

test("a hidden page follows nothing, and shown again replays what it missed without reading the list", async () => {
  const { cloud, list, close } = browser()
  try {
    cloud.keep({ type: "sessions-listed", sessions: [row(1), row(2)] })
    list.start()
    await until("the list read and followed", () => cloud.following() && accountListStore.get().phase === "live")
    assert.equal(cloud.counts.reads, 1)
    cloud.keep({ type: "sessions-listed", sessions: [row(1, "working", 1)] })
    await until("a change applied while shown", () => shown().get(uuid(1)) === "working")

    list.park()
    await settle()
    assert.equal(cloud.following(), false, "hidden, the stream is let go")
    const deliveredBefore = cloud.counts.delivered
    cloud.keep({ type: "sessions-listed", sessions: [row(1, "idle", 2)] })
    cloud.keep({ type: "sessions-listed", sessions: [row(3, "working", 3)] })
    cloud.keep({ type: "sessions-unlisted", sessions: [uuid(2)] })
    await settle()
    assert.equal(cloud.counts.delivered, deliveredBefore, "nothing reaches a hidden page")
    assert.equal(shown().get(uuid(1)), "working", "and nothing is applied while hidden")
    assert.equal(accountListStore.get().phase, "live", "parking isn't a failure")

    assert.equal(list.unpark(), true)
    await until("the missed changes replayed", () => shown().size === 2 && shown().get(uuid(1)) === "idle" && shown().get(uuid(3)) === "working")
    assert.equal(cloud.counts.reads, 1, "shown again, the list isn't read whole")
    assert.deepEqual(cloud.counts.subscribes, [1, 2], "followed again after the last number applied")
    assert.equal(cloud.counts.delivered - deliveredBefore, 3, "each missed event once")
    assert.deepEqual([...shown().keys()].sort(), cloud.rows().filter((each) => each.session !== uuid(2)).map((each) => each.session).sort(), "the list is the account's")
    assert.equal(list.unpark(), false, "shown twice, it replays once")
  } finally {
    close()
  }
})

test("hidden in the middle of a change, nothing of it is missed or applied twice", async () => {
  const { cloud, list, close } = browser()
  try {
    list.start()
    await until("followed", () => cloud.following())
    // A Mac reports a burst; the page is hidden after the first of it reached the list, the rest kept meanwhile.
    const first = cloud.keep({ type: "sessions-listed", sessions: [row(1, "working", 1)] })
    await until("the first of the burst", () => shown().get(uuid(1)) === "working")
    list.park()
    for (let n = 2; n <= 6; n += 1) cloud.keep({ type: "sessions-listed", sessions: [row(n, "working", n)] })
    cloud.keep({ type: "sessions-listed", sessions: [row(1, "idle", 7)] })
    list.unpark()
    await until("the burst replayed", () => shown().size === 6 && shown().get(uuid(1)) === "idle")
    // A number sent again (a frame in flight at the park, resent) is passed over: Session 1 stays as it is now, not as
    // that older frame says.
    cloud.resend(first)
    const seq = cloud.keep({ type: "sessions-listed", sessions: [row(6, "idle", 8)] })
    await until("the last change", () => shown().get(uuid(6)) === "idle")
    assert.equal(shown().get(uuid(1)), "idle", "an old frame sent again isn't applied")
    assert.equal(accountListStore.get().seq, seq)
    assert.equal(cloud.counts.reads, 1)
  } finally {
    close()
  }
})

test("hidden and shown before the stream's end is heard, it's still a park, not a failure", async () => {
  const { cloud, list, close } = browser()
  try {
    list.start()
    await until("followed", () => cloud.following())
    list.park()
    list.unpark()
    cloud.keep({ type: "sessions-listed", sessions: [row(1, "working", 1)] })
    await until("followed again and the change applied", () => shown().get(uuid(1)) === "working")
    assert.equal(cloud.counts.reads, 1, "no read of the whole list")
    assert.equal(accountListStore.get().failure, undefined, "nothing said failed")
  } finally {
    close()
  }
})

test("a replay the account can't give (its log moved on) reads the list whole", async () => {
  const { cloud, list, close } = browser()
  try {
    list.start()
    await until("followed", () => cloud.following())
    list.park()
    cloud.keep({ type: "sessions-listed", sessions: [row(1, "working", 1)] })
    cloud.keep({ type: "sessions-listed", sessions: [row(2, "working", 2)] })
    cloud.trim(2)
    list.unpark()
    await until("the list read whole", () => cloud.counts.reads === 2 && shown().size === 2)
  } finally {
    close()
  }
})

test("a stream that failed while shown is read whole, as before", async () => {
  const { cloud, list, close } = browser()
  try {
    list.start()
    await until("followed", () => cloud.following())
    cloud.drop()
    list.wake()
    await until("read again", () => cloud.counts.reads === 2)
  } finally {
    close()
  }
})

test("hidden before its first read lands, the list follows from that read once shown", async () => {
  const { cloud, list, close } = browser()
  try {
    cloud.keep({ type: "sessions-listed", sessions: [row(1)] })
    list.start()
    list.park()
    await until("read", () => cloud.counts.reads === 1)
    await settle()
    assert.equal(cloud.following(), false, "hidden, not followed")
    cloud.keep({ type: "sessions-listed", sessions: [row(1, "working", 1)] })
    list.unpark()
    await until("followed and replayed", () => shown().get(uuid(1)) === "working")
    assert.equal(cloud.counts.reads, 1)
  } finally {
    close()
  }
})
