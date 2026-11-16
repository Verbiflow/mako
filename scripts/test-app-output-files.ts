import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { HostStopping } from "@mako/host/base/host-stopping"
import { AppKeySchema } from "@mako/host/contracts/thread-environments"
import { AppOutputHints } from "@mako/host/workspaces/app-output-hints"
import { ThreadProcesses } from "@mako/host/workspaces/thread-processes"
import { childBackend } from "@mako/host/workspaces/watch-backend"

const root = await mkdtemp(join(tmpdir(), "mako-output-watch-"))
const app = AppKeySchema.parse(randomUUID()), folder = join(root, app), path = join(folder, "process-web.log")
await mkdir(folder)
const scope = new HostStopping()
const backend = scope.run(() => childBackend())
const processes = new ThreadProcesses({ root, listening: async () => false })
let wanted = true, hints = 0
const watcher = new AppOutputHints({ wanted: () => wanted, watch: listener => scope.run(() => processes.watchOutputFiles(backend, listener)), changed: fields => { if (fields.includes("output")) hints++ }, warn: message => { console.error(message) } })
const until = async (condition: () => boolean, label: string) => {
  const deadline = Date.now() + 10_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Output watch did not ${label} in time`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
try {
  watcher.reconcile()
  await until(() => watcher.ready(), "become ready")
  let before = hints
  await writeFile(path, "first\n")
  await until(() => hints > before, "hear the first log file")
  const first = await processes.readLog(app, "process-web")
  assert.equal(first.text, "first\n"); assert.equal(first.reset, true)
  before = hints
  await appendFile(path, "second\n")
  await until(() => hints > before, "hear an append")
  const second = await processes.readLog(app, "process-web", first.cursor)
  assert.equal(second.text, "second\n"); assert.equal(second.reset, false)
  before = hints
  await rename(path, path + ".1"); await writeFile(path, "new run\n")
  await until(() => hints > before, "hear a rotation")
  const rotated = await processes.readLog(app, "process-web", second.cursor)
  assert.equal(rotated.text, "new run\n"); assert.equal(rotated.reset, true)
  wanted = false; watcher.reconcile()
  await Promise.all([watcher.close(), scope.stop()])
  assert.equal(watcher.ready(), false)
  console.log("output files: existing watcher child hears create/append/rotation; actual log cursor preserves append and reset; owner releases before scratch removal")
} finally {
  await Promise.allSettled([watcher.close(), scope.stop()])
  await rm(root, { recursive: true, force: true })
}
