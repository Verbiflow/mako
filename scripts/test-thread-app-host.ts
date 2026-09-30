import assert from "node:assert/strict"
import type { AppOutputChunk, AppOutputCursor, ThreadAppView } from "../electron/contracts/thread-app"

/**
 * The strip's app control and the dock's output, driven by a host: a click
 * shows its phase at once and holds it until the host catches up, output
 * follows a cursor and starts over on a new run, a host that can't answer
 * hides the control, and a folder nothing shows stops being asked about.
 */

const CWD = "/work/shop"
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean, label: string) => {
  const deadline = Date.now() + 5_000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    await wait(20)
  }
}

const ready = (phase: "stopped" | "starting" | "running"): ThreadAppView => ({
  kind: "ready",
  project: "shop",
  phase,
  address: { host: "shop.thread.localhost", port: 20_010 },
  processes: [{ name: "web", state: phase === "stopped" ? "stopped" : phase, port: 20_010 }],
  checks: [],
})

let hostView: ThreadAppView = ready("stopped")
let failing = false
let views = 0
let releaseStart: (() => void) | undefined
const reads: (AppOutputCursor | undefined)[] = []
const chunks: AppOutputChunk[] = [
  { text: "listening\n", cursor: { file: "1:1", offset: 10 }, reset: true },
  { text: "GET /\n", cursor: { file: "1:1", offset: 16 }, reset: false },
  { text: "listening again\n", cursor: { file: "2:2", offset: 16 }, reset: true },
]
const bridge = {
  threadApp: async (cwd: string) => {
    assert.equal(cwd, CWD)
    views += 1
    if (failing) throw new Error("No handler for mako:thread-app")
    return hostView
  },
  startThreadApp: () => new Promise<{ problems: string[] }>((resolve) => {
    releaseStart = () => resolve({ problems: [] })
  }),
  stopThreadApp: async () => {},
  threadAppOutput: async (_cwd: string, _key: string, cursor?: AppOutputCursor) => {
    reads.push(cursor)
    const next = chunks.shift()
    return next ?? { text: "", cursor: cursor ?? { file: "", offset: 0 }, reset: false }
  },
}
const storage = new Map<string, string>()
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
} })
Object.defineProperty(globalThis, "window", { configurable: true, value: { mako: bridge, addEventListener() {}, dispatchEvent() { return true } } })
const element = () => ({ appendChild() {}, setAttribute() {} })
// Enough of a page for sonner, which adds its stylesheet when it loads.
Object.defineProperty(globalThis, "document", { configurable: true, value: {
  visibilityState: "visible",
  addEventListener() {},
  head: element(),
  createElement: element,
  createTextNode: () => ({}),
} })

const { installHostThreadApp } = await import("../src/state/thread-app-host")
const { threadAppDriver, threadAppStore } = await import("../src/state/thread-app")
installHostThreadApp()
const driver = threadAppDriver()!
const phase = () => {
  const view = threadAppStore.get().byCwd[CWD]
  return view?.kind === "ready" ? view.phase : view?.kind
}

const unwatch = driver.watch!(CWD)
await until(() => phase() === "stopped", "the first view")

// A click shows where it leads at once, and the host's older answer doesn't undo it.
driver.start(CWD)
assert.equal(phase(), "starting", "the control answers the click before the host does")
await wait(500)
assert.equal(phase(), "starting", "a view from before the host caught up keeps the click's phase")
hostView = ready("running")
releaseStart!()
await until(() => phase() === "running", "the host's running view")

// Output: everything so far, then only what's new, then a new run from the top.
const received: [string, boolean][] = []
const unsubscribe = driver.subscribeOutput(CWD, "process:web", (text, reset) => received.push([text, reset]))
await until(() => received.length === 3, "three reads of output")
unsubscribe()
assert.deepEqual(received, [["listening\n", true], ["GET /\n", false], ["listening again\n", true]])
assert.deepEqual(reads.slice(0, 3), [undefined, { file: "1:1", offset: 10 }, { file: "1:1", offset: 16 }], "each read goes on from where the last ended")
const readsAfter = reads.length
await wait(700)
assert.equal(reads.length, readsAfter, "an output nothing shows isn't read")

// A host that can't answer hides the control instead of showing something stale.
failing = true
driver.stop(CWD)
await until(() => threadAppStore.get().byCwd[CWD] === undefined, "the control hidden")

// Nothing shows the folder: the host isn't asked about it again.
unwatch()
const asked = views
await wait(1_500)
assert.equal(views, asked)

console.log("thread app host driver: a click shows its phase at once and holds it until the host catches up; output follows its cursor and starts over on a new run; a host that can't answer hides the control; a folder nothing shows isn't polled")
