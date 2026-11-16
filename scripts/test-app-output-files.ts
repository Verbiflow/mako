import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostStopping } from "@mako/host/base/host-stopping"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import type { WatchEvent } from "@mako/host/contracts/watcher-child"
import { AppOutputHints } from "@mako/host/workspaces/app-output-hints"
import { ThreadAppSampler } from "@mako/host/workspaces/app-sampler"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { ViewHints } from "@mako/host/workspaces/view-hints"
import { childBackend, type WatchBackend } from "@mako/host/workspaces/watch-backend"
import { DeskRefetch } from "../src/state/desk-refetch"
import { ViewRefetch } from "../src/lib/view-refetch"
import { appOutputReader } from "../src/state/thread-app-output"

const root = await realpath(await mkdtemp(join(tmpdir(), "mako-output-watch-")))
const app = AppKeySchema.parse(randomUUID()), other = AppKeySchema.parse(randomUUID())
const folder = join(root, app), otherFolder = join(root, other), path = join(folder, "process-web.log")
await Promise.all([mkdir(folder), mkdir(otherFolder), mkdir(join(root, "memory")), mkdir(join(root, "checkouts"))])
await writeFile(join(otherFolder, "process-web.log"), "hidden\n")
const scope = new HostStopping()
const child = scope.run(() => childBackend())
const received: WatchEvent[] = [], roots: string[] = []
const backend: WatchBackend = (root, ignore, listener, native) => {
  roots.push(root)
  return child(root, ignore, { ...listener, events: events => { received.push(...events); listener.events(events) } }, native)
}
const processes = new ThreadProcesses({ root, listening: async () => false })
const connection = randomUUID(), subscribers = new Set<(event: HostEvent) => void>()
const publisher = new ViewHints(event => { for (const subscriber of subscribers) subscriber(event) })
const sampler = new ThreadAppSampler({ connection: () => connection, demandChanged: () => watcher.reconcile(true), look: async () => ({ marks: [], signature: "", settling: false, alive: false }), publish: () => {} })
const watcher = new AppOutputHints({ wanted: () => sampler.outputWanted(), watch: (app, listener) => scope.run(() => processes.watchOutputFiles(app, backend, listener)), changed: fields => publisher.changed("output", fields), warn: message => { console.error(message) } })
const reads = new ViewRefetch()
const owner = new DeskRefetch({
  onEvent: subscriber => { subscribers.add(subscriber); return () => { subscribers.delete(subscriber) } },
  viewHints: async () => publisher.status(),
  followThreadApps: async demand => {
    if (!demand) return { kind: "ready", connection, generation: sampler.generation("window") }
    if (!sampler.follow("window", demand)) return { kind: "unavailable" }
    return { kind: "following", ...(demand.outputs && { outputs: watcher.ready(demand.outputs) }) }
  },
}, reads)
const subscribe = appOutputReader(owner, async (cwd, key, cursor) => {
  const chosen = cwd === "/fixture/one" ? app : other
  return { ...await processes.readLog(chosen, key === "check:quick:compile" ? "check-quick" : "process-web", cursor, undefined, key === "check:quick:compile" ? "compile" : undefined), app: chosen }
})
let text = "", resets = 0
const heard = (chunk: string, reset: boolean) => { text = reset ? chunk : text + chunk; if (reset) resets++ }
const retryTick = setInterval(watcher.reconcile, 1_000)
let release: (() => void) | undefined
let releaseStep: (() => void) | undefined
const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Output watch did not ${label} in time: ${JSON.stringify({ ready: watcher.ready(), roots, received })}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
try {
  release = subscribe("/fixture/one", "process:web", heard)
  await until(() => owner.outputFollowing(app), "become ready")
  assert.deepEqual(roots, [folder], "only the visible app folder is registered with the child")
  await Promise.all([appendFile(join(otherFolder, "process-web.log"), "still hidden\n"), writeFile(join(root, "memory", "busy.log"), "memory"), writeFile(join(root, "checkouts", "busy.log"), "checkout"), writeFile(join(folder, "runs.json"), "{}")])
  await writeFile(path, "first\n")
  await until(() => text === "first\n", "show the first log file")
  assert.ok(received.some(event => event.path === path), "the child delivered the visible log")
  assert.ok(received.every(event => event.path.startsWith(folder + "/") && !event.path.endsWith("runs.json")), "hidden apps and ignored metadata never reach the host listener")
  const first = await processes.readLog(app, "process-web")
  await appendFile(path, "second\n")
  await until(() => text === "first\nsecond\n", "show an append")
  const second = await processes.readLog(app, "process-web", first.cursor)
  assert.equal(second.text, "second\n"); assert.equal(second.reset, false)
  let stepText = ""
  releaseStep = subscribe("/fixture/one", "check:quick:compile", (chunk, reset) => { stepText = reset ? chunk : stepText + chunk })
  await mkdir(join(folder, "check-quick.steps"))
  await writeFile(join(folder, "check-quick.steps", "compile.log"), "compiled\n")
  await until(() => stepText === "compiled\n", "show a new nested step log")
  assert.equal(roots.length, 1, "multiple visible outputs of the same app share one watch")
  releaseStep(); releaseStep = undefined
  const beforeRotation = resets
  await rename(path, path + ".1"); await writeFile(path, "new run\n")
  await until(() => text === "new run\n" && resets > beforeRotation, "show a rotation")
  const rotated = await processes.readLog(app, "process-web", second.cursor)
  assert.equal(rotated.text, "new run\n"); assert.equal(rotated.reset, true)
  release()
  release = subscribe("/fixture/two", "process:web", heard)
  await until(() => owner.outputFollowing(other), "follow the replacement visible app")
  assert.deepEqual(roots, [folder, otherFolder])
  const from = received.length
  await appendFile(path, "now hidden\n")
  await appendFile(join(otherFolder, "process-web.log"), "now visible\n")
  // Initial watch readiness also schedules the actual reader's catch-up. An append coalesced at registration still arrives.
  await until(() => text.includes("now visible\n"), "catch up the replacement app")
  await appendFile(join(otherFolder, "process-web.log"), "after catch-up\n")
  await until(() => text.includes("after catch-up\n"), "follow the replacement after catch-up")
  assert.ok(received.slice(from).some(event => event.path.startsWith(otherFolder + "/")))
  assert.ok(received.slice(from).every(event => event.path.startsWith(otherFolder + "/")), "the old app no longer forwards events after the visible set changes")
  await rm(otherFolder, { recursive: true })
  await until(() => !watcher.ready(), "retire a removed output folder")
  await mkdir(otherFolder); await writeFile(join(otherFolder, "process-web.log"), "recreated\n")
  await until(() => text === "recreated\n" && owner.outputFollowing(other), "recover the recreated output folder")
  release(); release = undefined
  await Promise.all([watcher.close(), scope.stop()])
  assert.equal(watcher.ready(), false)
  console.log("output files: real child excludes hidden apps/metadata, follows visible-set changes, and drives the production reader through create/append/rotation/catch-up/root recovery; cursor reset and release pass")
} finally {
  clearInterval(retryTick)
  releaseStep?.(); release?.(); owner.close(); reads.dispose()
  await Promise.allSettled([watcher.close(), scope.stop()])
  await rm(root, { recursive: true, force: true })
}
