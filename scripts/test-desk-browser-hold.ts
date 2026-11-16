import assert from "node:assert/strict"
import { setTimeout as delay } from "node:timers/promises"
import { HostJobs } from "@mako/host/base/host-jobs"
import { DeskBrowser, type DeskPage } from "@mako/host/control/desk-browser"

// What an agent's use of the desk browser holds a profile host up for: a page being made, and use within `idleMs`. A
// connection the browser service keeps open and quiet holds nothing once the window passes, and a page that never
// comes gives up and lets go.
const IDLE_MS = 10_000
const CREATE_MS = 300

function fakePage(id: string, destroyed: () => void): DeskPage {
  return {
    id,
    url: () => "about:blank",
    title: () => "",
    send: async () => ({}),
    onMessage: () => () => {},
    onDestroyed: () => () => {},
    destroy: destroyed,
  }
}

const jobs = new HostJobs()
let release: ((page: DeskPage) => void) | undefined
let lateDestroyed = false
const desk = new DeskBrowser({
  jobs,
  allowsUrl: () => true,
  idleMs: IDLE_MS,
  createMs: CREATE_MS,
  // Never ready until the test says so: the agent views app stuck starting.
  createPage: () => new Promise<DeskPage>((resolve) => { release = resolve }),
})
try {
  assert.equal(desk.busy(), false, "unused, it holds nothing")
  const socket = new WebSocket(await desk.start())
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject })
  const connectedAt = Date.now()
  assert.equal(desk.busy(), true, "a connection just made is use")
  assert.equal(desk.busy(connectedAt + IDLE_MS + 1), false, "the same connection, open and quiet past the window, holds nothing")

  // A page that never comes: the wait gives up, the agent hears why, and nothing is left being made.
  const replies = new Map<number, { error?: { message: string } }>()
  socket.onmessage = (event) => {
    const reply = JSON.parse(String(event.data))
    if (Number.isInteger(reply.id)) replies.set(reply.id, reply)
  }
  socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: {} }))
  await delay(50)
  assert.equal(desk.busy(Date.now() + IDLE_MS + 1), true, "a page being made holds, however long since the last message")
  for (const deadline = Date.now() + 5_000; !replies.has(1); await delay(20)) assert.ok(Date.now() < deadline, "createTarget answered")
  assert.match(replies.get(1)?.error?.message ?? "", /didn.t open within/, JSON.stringify(replies.get(1)))
  assert.equal(desk.busy(Date.now() + IDLE_MS + 1), false, "a page that never came lets go once the wait gives up")
  // The window comes after all: no one asked for it any more, so it's closed.
  release?.(fakePage("late", () => { lateDestroyed = true }))
  for (const deadline = Date.now() + 2_000; !lateDestroyed; await delay(20)) assert.ok(Date.now() < deadline, "a late window is closed")
  assert.equal(desk.openPages, 0)

  socket.close()
  console.log("desk browser hold: recent use and a page being made hold a profile host; a quiet open connection and a page that never came don't, and a late window is closed")
} finally {
  desk.close()
  jobs.stop()
}
