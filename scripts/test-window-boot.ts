import assert from "node:assert/strict"
import { mock } from "node:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate as tick } from "node:timers/promises"
import { WorkspaceClients } from "../electron/workspace-clients.ts"
import { WorkspaceGit } from "../electron/host-git.ts"
import type { BootPayload, GitStatus, HostEvent } from "../electron/shared.ts"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-window-boot-")))
const originalCwd = process.cwd()
const git = Promise.withResolvers<GitStatus>()
const gitRoot = Promise.withResolvers<string | null>()
mock.method(WorkspaceGit.prototype, "root", () => gitRoot.promise)
mock.method(WorkspaceGit.prototype, "status", () => git.promise)
const clients = new WorkspaceClients(() => {})
let payload: BootPayload
try {
  process.chdir(root)
  // Held Git promises reproduce the live failure without touching a real repo.
  const pool = await Promise.race([
    clients.ready("fixture"),
    tick().then(() => { throw new Error("Window startup waited for Git discovery") }),
  ])
  payload = {
    tabs: pool.snapshots(), activeTabId: pool.activeId,
    live: [], models: [], platform: "darwin", archives: { revision: 0, keys: [] },
  }
  assert.equal(payload.tabs[0]?.git, undefined, "Pending Git is not reported as a clean worktree")
  assert.equal(payload.tabs[0]?.session.meta.cwd, root)
  const opened = await Promise.race([
    pool.open({ cwd: root }),
    tick().then(() => { throw new Error("Opening another tab waited for Git status") }),
  ])
  assert.equal(opened.git, undefined, "An unfinished Git read must not become a clean worktree")
  await Promise.race([
    pool.active.setCwd(root),
    tick().then(() => { throw new Error("Workspace restoration waited for Git status") }),
  ])
} finally {
  await clients.dispose()
  process.chdir(originalCwd)
  mock.restoreAll()
  gitRoot.resolve(null)
  git.resolve({ cwd: root, ahead: 0, behind: 0, files: [] })
  await rm(root, { recursive: true, force: true })
}

let gitReads = 0
let answer = Promise.withResolvers<BootPayload>()
let receive: (event: HostEvent) => void = () => {}
const background = () => new Promise<never>(() => {})
Object.assign(globalThis, {
  window: {
    addEventListener: () => {},
    dispatchEvent: () => true,
    mako: {
      daemonStatus: background,
      unfollowThread: async () => {},
      onEvent: (callback: typeof receive) => { receive = callback; return () => {} },
      boot: () => answer.promise,
      setCwd: async () => payload.tabs[0],
      harnessProfiles: async () => [], harnessUpdates: background,
      openTab: async () => ({ ...payload.tabs[0], id: "new-tab", git: undefined }),
      gitStatus: () => { gitReads++; return background() }, updateState: background,
      lifecycleState: background, installationState: background,
      automations: background, threads: background, harnessDescriptors: background,
    },
  },
})
const { actions, store } = await import("../src/state/session.ts")
const { hostConnectionStore } = await import("../src/state/host-connection.ts")
const schedule = globalThis.setTimeout
mock.method(globalThis, "setTimeout", (callback: () => void, ms: number) => schedule(callback, ms === 45_000 ? 5 : ms))
try {
  const boot = actions.boot()
  const dispose = await boot
  assert.equal(store.get().phase, "detached")
  answer.resolve(payload)
  await tick()
  assert.equal(store.get().phase, "ready", "Late boot response must restore the conversation view")
  assert.equal(store.get().fault, undefined)
  assert.equal(hostConnectionStore.get().kind, "connected")
  dispose()

  store.set({ phase: "booting", meta: undefined })
  answer = Promise.withResolvers<BootPayload>()
  const older = answer
  const failedBoot = actions.boot()
  const disposeFailed = await failedBoot
  answer = Promise.withResolvers<BootPayload>()
  receive({ type: "host-reconnected" })
  answer.resolve(payload)
  await tick()
  assert.equal(store.get().phase, "ready", "Reconnection must clear a previous boot failure")
  assert.equal(store.get().fault, undefined)
  assert.equal(store.get().platform, "darwin")
  older.reject(new Error("Old boot failed after reconnection"))
  await tick()
  assert.equal(store.get().phase, "ready", "Stale failures must not undo successful recovery")
  disposeFailed()

  answer = Promise.withResolvers<BootPayload>()
  const stale = answer
  const staleBoot = actions.boot()
  answer = Promise.withResolvers<BootPayload>()
  const latestBoot = actions.boot()
  const latest = { ...payload, platform: "linux" as const }
  answer.resolve(latest)
  const disposeLatest = await latestBoot
  stale.resolve(payload)
  const disposeStale = await staleBoot
  assert.equal(store.get().platform, "linux", "An older successful boot must not overwrite a newer one")
  disposeStale()
  disposeLatest()
  const before = gitReads
  assert.equal(await actions.openTab({ cwd: root }), true)
  assert.equal(store.get().meta?.cwd, root)
  assert.equal(store.get().git, undefined, "The new composer renders while Git is pending")
  assert.equal(gitReads, before + 1, "New requests Git after adopting the tab")
  console.log("Window boot: held Git cannot block startup or workspace restoration; late replies and reconnections recover; stale attempts cannot overwrite recovery")
} finally {
  mock.restoreAll()
}
