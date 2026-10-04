import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { WatchEvent } from "../electron/contracts/watcher-child.ts"
import { parcelBackend } from "../electron/watch-backend.ts"
import { useWatchBackend } from "../electron/tree-watcher.ts"

type Callback = (error: Error | null, events: WatchEvent[]) => void
const subscriptions: { path: string; closed: number; callback: Callback }[] = []
useWatchBackend(parcelBackend(async (path: string, callback: Callback) => {
  const watcher = { path, closed: 0, callback }
  subscriptions.push(watcher)
  return { unsubscribe: async () => { watcher.closed += 1 } }
}))
const platform = Object.getOwnPropertyDescriptor(process, "platform") ?? { value: process.platform, configurable: true }
const settled = () => new Promise((resolve) => setTimeout(resolve, 20))

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-background-watch-")))
execFileSync("git", ["init", "-q", root])

async function hostOn(os: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...platform, value: os })
  const { AgentHost } = await import(`../electron/host.ts?${os}`)
  Object.defineProperty(process, "platform", platform)
  const events: { type: string }[] = []
  const host = new AgentHost(`background-${os}`, (event: { type: string }) => events.push(event))
  await host.start(root)
  await settled()
  const watch = subscriptions.at(-1)
  assert.ok(watch, "a foreground host watches its folder")
  return { host, events, watch }
}

try {
  const linux = await hostOn("linux")
  assert.equal(linux.watch.path, root)
  linux.host.setForeground(false)
  await settled()
  assert.equal(linux.watch.closed, 0, "on Linux a background tab keeps its watch, so coming back doesn't read the tree again")
  const before = linux.events.filter((event) => event.type === "git").length
  linux.watch.callback(null, [{ type: "update", path: join(root, "a.txt") }])
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(linux.events.filter((event) => event.type === "git").length, before, "and doesn't read Git while in the background")
  const count = subscriptions.length
  linux.host.setForeground(true)
  await settled()
  assert.equal(subscriptions.length, count, "coming forward reuses the watch")
  for (let tries = 0; tries < 100 && linux.events.filter((event) => event.type === "git").length === before; tries++) await settled()
  assert.ok(linux.events.filter((event) => event.type === "git").length > before, "and reads Git once")
  linux.watch.callback(new Error("Events were dropped by the FSEvents client. File system must be re-scanned."), [])
  await new Promise((resolve) => setTimeout(resolve, 400))
  assert.equal(linux.watch.closed, 0, "dropped events leave the watch running")
  await linux.host.dispose()
  assert.equal(linux.watch.closed, 1)

  const mac = await hostOn("darwin")
  mac.host.setForeground(false)
  await settled()
  assert.equal(mac.watch.closed, 1, "on macOS a background tab closes its FSEvents stream at once")
  await mac.host.dispose()
  console.log("host background watch: Linux keeps it through a tab switch without reading Git, macOS closes it, dropped events survived")
} finally {
  await rm(root, { recursive: true, force: true })
}
