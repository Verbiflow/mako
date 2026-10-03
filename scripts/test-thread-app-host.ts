import assert from "node:assert/strict"
import type { AppMark, AppOutputChunk, AppOutputCursor, ThreadAppView } from "../electron/contracts/thread-app"

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
let heldView: Promise<ThreadAppView> | undefined
let releaseStart: (() => void) | undefined
const WORKTREE = "/work/shop-worktree"
let hostMarks: AppMark[] = [{ checkout: CWD, state: "crashed" }, { checkout: WORKTREE, state: "running", port: 20_020 }]
let markLooks = 0
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
    if (heldView) { const pending = heldView; heldView = undefined; return pending }
    if (failing) throw new Error("No handler for mako:thread-app")
    return hostView
  },
  startThreadApp: () => new Promise<{ problems: string[] }>((resolve) => {
    releaseStart = () => resolve({ problems: [] })
  }),
  stopThreadApp: async () => {},
  threadAppMarks: async (): Promise<AppMark[]> => {
    markLooks += 1
    return hostMarks
  },
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
const { appMarkOf, threadAppDriver, threadAppStore } = await import("../src/state/thread-app")
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

// An older successful or failed read must not overwrite a newer answer, even across watch lifetimes.
unwatch()
let releaseOld: (view: ThreadAppView) => void = () => {}
heldView = new Promise((resolve) => { releaseOld = resolve })
const unwatchOld = driver.watch!(CWD)
unwatchOld()
const unwatchFresh = driver.watch!(CWD)
await until(() => phase() === "running", "the newly watched view")
releaseOld(ready("stopped"))
await wait(30)
assert.equal(phase(), "running", "a read from an earlier watcher can't land on a new one")
unwatchFresh()
let rejectOld: (error: Error) => void = () => {}
heldView = new Promise((_resolve, reject) => { rejectOld = reject })
const unwatchPending = driver.watch!(CWD)
driver.stop(CWD)
await until(() => phase() === "running", "the newer action read")
rejectOld(new Error("older failed read"))
await wait(30)
assert.equal(phase(), "running", "an older failure can't hide a newer running view")

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
unwatchPending()
const asked = views
await wait(1_500)
assert.equal(views, asked)

// The sidebar's marks: one look at every app while the rail shows them, and none after.
failing = false
assert.equal(markLooks, 0, "nothing asks for marks until the rail does")
const unwatchMarks = driver.watchMarks!()
await until(() => Object.keys(threadAppStore.get().marks).length === 2, "the first marks")
assert.deepEqual(appMarkOf(threadAppStore.get(), WORKTREE), { checkout: WORKTREE, state: "running", port: 20_020 })
assert.deepEqual(appMarkOf(threadAppStore.get(), CWD), { checkout: CWD, state: "crashed" }, "a folder the strip doesn't follow takes the sidebar's look")
hostView = ready("running")
const unwatchAgain = driver.watch!(CWD)
await until(() => appMarkOf(threadAppStore.get(), CWD)?.state === "running", "the strip's view")
assert.deepEqual(appMarkOf(threadAppStore.get(), CWD), { state: "running", port: 20_010 }, "the strip's closer view of its folder wins, so the two never disagree")
unwatchAgain()
assert.equal(appMarkOf(threadAppStore.get(), CWD)?.state, "crashed", "once the strip lets go, its view may be old, and the sidebar's look stands")
hostMarks = [{ checkout: WORKTREE, state: "starting" }]
await until(() => appMarkOf(threadAppStore.get(), WORKTREE)?.state === "starting", "a later look")
assert.equal(appMarkOf(threadAppStore.get(), CWD), undefined, "an app that stopped loses its mark")
unwatchMarks()
const looked = markLooks
await wait(1_500)
assert.equal(markLooks, looked, "once the rail goes, nothing asks")

console.log("thread app host driver: a click shows its phase at once and holds it until the host catches up; output follows its cursor and starts over on a new run; a host that can't answer hides the control; a folder nothing shows isn't polled; the sidebar's marks come from one look while the rail shows them, the strip's view of its folder wins, and nothing is asked once the rail goes")
