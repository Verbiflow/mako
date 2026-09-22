import { reconcileTerminalGroups } from "../src/lib/terminal-layout.ts"
import assert from "node:assert/strict"
import {
  createMakoBridge,
  type HostEvent,
  type TerminalEvent,
  type TerminalSession,
  type TerminalSnapshot,
} from "../electron/shared.ts"
import {
  terminalActions,
  terminalStore,
  subscribeTerminalOutput,
} from "../src/state/terminal.ts"

const sessions: TerminalSession[] = ["one", "two"].map((id, index) => ({
  id,
  title: id,
  cwd: "/fixture",
  createdAt: index,
  updatedAt: index,
  status: "running",
  cols: 80,
  rows: 24,
  sequence: 0,
}))
const requests: Array<{
  id: string
  deferred: ReturnType<typeof Promise.withResolvers<TerminalSnapshot>>
}> = []
let listener: ((event: TerminalEvent) => void) | undefined
let hostListener: ((event: HostEvent) => void) | undefined
let lists = 0
const bridge = createMakoBridge({
  invoke: async (channel, ...args) => {
    if (channel === "mako:terminal-list") {
      lists++
      return sessions
    }
    if (channel === "mako:terminal-create") {
      const session = {
        ...sessions[0],
        id: `created-${sessions.length}`,
        createdAt: sessions.length,
      }
      sessions.push(session)
      return session
    }
    if (channel === "mako:terminal-attach") {
      const deferred = Promise.withResolvers<TerminalSnapshot>()
      requests.push({ id: String(args[0]), deferred })
      return deferred.promise
    }
    return undefined
  },
  onEvent: (next) => {
    hostListener = next
    return () => {
      hostListener = undefined
    }
  },
  onTerminalEvent: (next) => {
    listener = next
    return () => {
      listener = undefined
    }
  },
  pathForFile: () => null,
  resolveFileUrl: (url) => url,
})
Object.assign(globalThis, { window: { mako: bridge } })
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
function resolve(request: (typeof requests)[number], sequence = 0) {
  const session = sessions.find((entry) => entry.id === request.id)
  assert.ok(session)
  request.deferred.resolve({
    session,
    sequence,
    data: `snapshot:${request.id}`,
  })
}
const unmount = terminalActions.mount()
await tick()
resolve(requests[0])
await tick()
assert.equal(terminalStore.get().activeId, "two")

terminalActions.activate("one")
const stale = requests.at(-1)!
terminalActions.activate("two")
const current = requests.at(-1)!
stale.deferred.reject(new Error("old attachment failed"))
await tick()
assert.equal(
  terminalStore.get().phase,
  "ready",
  "An old tab cannot mark the new tab disconnected"
)
const output: string[] = []
const unsubscribe = subscribeTerminalOutput("two", (event) =>
  output.push(event.data)
)
listener?.({
  type: "output",
  sessionId: "two",
  sequence: 1,
  data: "during attach",
})
resolve(current)
await tick()
assert.deepEqual(
  output,
  ["during attach"],
  "Output arriving ahead of the snapshot reply survives"
)
assert.equal(terminalStore.get().snapshots.two?.sequence, 0)
const beforeDuplicate = requests.length
listener?.({ type: "output", sessionId: "two", sequence: 1, data: "duplicate" })
assert.equal(
  requests.length,
  beforeDuplicate,
  "A duplicate output frame does not reset the terminal"
)

terminalActions.activate("one")
resolve(requests.at(-1)!)
await tick()
await terminalActions.ensureWorkspace("/fixture")
assert.equal(
  terminalStore.get().activeId,
  "one",
  "Workspace recovery retains the selected shell"
)
listener?.({ type: "connection", state: "disconnected" })
listener?.({ type: "connection", state: "connecting" })
listener?.({ type: "connection", state: "ready" })
await tick()
assert.equal(lists, 2, "Reconnect through connecting reloads the session list")
assert.equal(requests.at(-1)?.id, "one")
resolve(requests.at(-1)!)
await tick()
assert.equal(terminalStore.get().phase, "ready")
terminalActions.resync()
const beforeDisconnect = requests.at(-1)!
hostListener?.({ type: "host-disconnected", message: "Host restarting" })
hostListener?.({ type: "host-reconnected" })
await tick()
assert.equal(
  lists,
  3,
  "Host transport reconnect also restores terminal attachment"
)
const afterDisconnect = requests.at(-1)!
assert.notEqual(
  afterDisconnect,
  beforeDisconnect,
  "Recovery cannot reuse an attachment from a dead host connection"
)
resolve(afterDisconnect)
await tick()
beforeDisconnect.deferred.reject(new Error("late host outage"))
await tick()
assert.equal(terminalStore.get().phase, "ready")
assert.equal(terminalStore.get().fault, undefined)
// Splits attach both panes and keep input/output ownership separate.
const split = terminalActions.split("horizontal", "one")
await tick()
const splitRequest = requests.at(-1)!
resolve(splitRequest)
await split
const splitId = splitRequest.id
assert.deepEqual(
  terminalStore.get().groups.find((g) => g.sessionIds.includes("one"))
    ?.sessionIds,
  ["one", splitId]
)
const paneOne: string[] = []
const paneTwo: string[] = []
const offOne = subscribeTerminalOutput("one", (event) =>
  paneOne.push(event.data)
)
const offTwo = subscribeTerminalOutput(splitId, (event) =>
  paneTwo.push(event.data)
)
let publishes = 0
const offState = terminalStore.subscribe(() => publishes++)
listener?.({
  type: "output",
  sessionId: "one",
  sequence: 1,
  data: "first pane",
})
listener?.({
  type: "output",
  sessionId: splitId,
  sequence: 1,
  data: "second pane",
})
assert.deepEqual(paneOne, ["first pane"])
assert.deepEqual(paneTwo, ["second pane"])
assert.equal(publishes, 0, "Streaming frames do not publish React state")
const beforeFocus = requests.length
terminalActions.activate("one")
assert.equal(
  requests.length,
  beforeFocus,
  "Focusing another visible pane does not reattach"
)
// Repeated host outages restore all visible panes, not just the focused one.
for (let cycle = 0; cycle < 12; cycle++) {
  hostListener?.({ type: "host-disconnected", message: "fixture outage" })
  hostListener?.({ type: "host-reconnected" })
  await tick()
  const pending = requests.slice(-2)
  assert.deepEqual(new Set(pending.map((r) => r.id)), new Set(["one", splitId]))
  for (const request of pending) resolve(request)
  await tick()
  assert.equal(terminalStore.get().activeId, "one")
}
terminalActions.unsplit(splitId)
assert.equal(
  terminalStore.get().groups.find((g) => g.sessionIds.includes(splitId))
    ?.sessionIds.length,
  1
)
terminalActions.requestClose(splitId)
assert.equal(terminalStore.get().closingId, splitId)
terminalActions.cancelClose()
assert.equal(terminalStore.get().closingId, undefined)
offOne()
offTwo()
offState()
unsubscribe()
unmount()
console.log(
  "terminal state: stale responses, output ordering, duplicate frames, reconnect and selected shell passed"
)

const regrouped = reconcileTerminalGroups(
  [{ id: "one", sessionIds: ["two"], orientation: "horizontal" }],
  sessions
)
assert.equal(
  new Set(regrouped.map((g) => g.id)).size,
  regrouped.length,
  "Moving the first pane out cannot duplicate group IDs"
)
const mixed = reconcileTerminalGroups(
  [
    {
      id: "gone",
      sessionIds: ["gone", "one", "two"],
      orientation: "horizontal",
    },
  ],
  sessions.map((session) => ({
    ...session,
    cwd: session.id === "one" ? "/elsewhere" : session.cwd,
  }))
)
assert.ok(
  mixed.every(
    (g) => !(g.sessionIds.includes("one") && g.sessionIds.includes("two"))
  ),
  "Restored groups never mix workspaces"
)
