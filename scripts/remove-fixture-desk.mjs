/**
 * A worktree's cleanup: removes the fixture desk its checkout ran, meaning its
 * host, its profile's data and the host's folder. Only a fixture- profile is
 * removed, and only a fixture host is stopped: it refuses every write, so
 * stopping it loses nothing. Run from the checkout, with the desk stopped;
 * `--profile fixture-…` names another desk instead.
 *
 * Then it removes every other fixture desk whose launching checkout is gone
 * and whose host has left, such as one a worktree removed without this
 * cleanup ran. A desk that noted no checkout, or whose host still runs, stays.
 */
import { existsSync } from "node:fs"
import { readdir, rm } from "node:fs/promises"
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
const { appDataFolder, fixtureCheckout, fixtureProfile, runtimeDataRoot, runtimeLocation } = await import(pathToFileURL(built("runtime-service.js")).href)
const { probeRuntime } = await import(pathToFileURL(built("runtime-connection.js")).href)

const named = process.argv.indexOf("--profile")
const profile = named >= 0 ? process.argv[named + 1] : fixtureProfile(root, process.env)
if (!profile?.startsWith("fixture-")) throw new Error(`${profile ?? "--profile needs a name, and"} isn't a fixture desk's profile, so nothing was removed.`)
const dataRoot = runtimeDataRoot(appDataFolder(), { MAKO_PROFILE: profile })

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
const gone = (socket) => probeRuntime(socket, { timeoutMs: 2_000 }).then((probe) => probe.state === "absent", () => false)
const remove = async (data) => {
  const removed = []
  for (const folder of [data, runtimeLocation(data).directory]) {
    if (!existsSync(folder)) continue
    await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
    removed.push(folder)
  }
  return removed
}

const { socket } = runtimeLocation(dataRoot)
if (!(await until(() => gone(socket), LEAVE_MS))) {
  const probe = await probeRuntime(socket, { timeoutMs: 2_000 })
  if (probe.state === "ready") {
    if (probe.info.fixture !== true) throw new Error(`The host on ${socket} isn't a fixture desk's, so it was left running and nothing was removed.`)
    console.log(`Stopping fixture host ${probe.info.pid}, which a page still held.`)
    process.kill(probe.info.pid, "SIGTERM")
    if (!(await until(() => !alive(probe.info.pid), TERM_MS))) process.kill(probe.info.pid, "SIGKILL")
  }
  if (!(await until(() => gone(socket), TERM_MS))) throw new Error(`The fixture host on ${socket} didn't leave, so nothing was removed.`)
}
const removed = await remove(dataRoot)
console.log(removed.length ? `Removed ${removed.join(" and ")}.` : `Nothing to remove: ${profile} has no data here.`)

const appData = appDataFolder()
// A build from before desks noted their checkout has none to go by.
for (const name of fixtureCheckout ? await readdir(appData) : []) {
  const data = join(appData, name)
  if (!name.startsWith("mako-fixture-") || data === dataRoot) continue
  const checkout = await fixtureCheckout(data)
  if (!checkout || existsSync(checkout)) continue
  if (!(await gone(runtimeLocation(data).socket))) {
    console.log(`Left ${name}: its checkout ${checkout} is gone, but its host still runs.`)
    continue
  }
  console.log(`Removed ${(await remove(data)).join(" and ")}, whose checkout ${checkout} is gone.`)
}
