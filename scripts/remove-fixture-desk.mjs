/**
 * A worktree's cleanup: removes the fixture desk its checkout ran, meaning its
 * host, its profile's data and the host's folder. Only a fixture- profile is
 * removed, and only a fixture host is stopped: it refuses every write, so
 * stopping it loses nothing. Run from the checkout, with the desk stopped.
 */
import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { fileURLToPath, pathToFileURL } from "node:url"

/** A host with no page open stops itself 15 s after its desk does; this waits a little longer before stopping it. */
const LEAVE_MS = 20_000
const TERM_MS = 10_000

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const built = (name) => join(root, "dist-electron", name)
if (!existsSync(built("runtime-service.js"))) {
  console.log("Nothing to remove: no desk was built in this checkout, so none ran from it.")
  process.exit(0)
}
const { appDataFolder, fixtureProfile, runtimeDataRoot, runtimeLocation } = await import(pathToFileURL(built("runtime-service.js")).href)
const { probeRuntime } = await import(pathToFileURL(built("runtime-connection.js")).href)

const profile = fixtureProfile(root, process.env)
if (!profile.startsWith("fixture-")) throw new Error(`${profile} isn't a fixture desk's profile, so nothing was removed.`)
const dataRoot = runtimeDataRoot(appDataFolder(), { MAKO_PROFILE: profile })
const { directory, socket } = runtimeLocation(dataRoot)

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (done, ms) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await done()) return true
    await sleep(250)
  }
  return done()
}
const gone = async () => (await probeRuntime(socket, { timeoutMs: 2_000 })).state === "absent"

if (!(await until(gone, LEAVE_MS))) {
  const probe = await probeRuntime(socket, { timeoutMs: 2_000 })
  if (probe.state === "ready") {
    if (probe.info.fixture !== true) throw new Error(`The host on ${socket} isn't a fixture desk's, so it was left running and nothing was removed.`)
    console.log(`Stopping fixture host ${probe.info.pid}, which a page still held.`)
    process.kill(probe.info.pid, "SIGTERM")
    if (!(await until(() => !alive(probe.info.pid), TERM_MS))) process.kill(probe.info.pid, "SIGKILL")
  }
  if (!(await until(gone, TERM_MS))) throw new Error(`The fixture host on ${socket} didn't leave, so nothing was removed.`)
}

const removed = []
for (const folder of [dataRoot, directory]) {
  if (!existsSync(folder)) continue
  await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  removed.push(folder)
}
console.log(removed.length ? `Removed ${removed.join(" and ")}.` : `Nothing to remove: ${profile} has no data here.`)
