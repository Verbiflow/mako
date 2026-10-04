import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { join } from "node:path"
import { promisify } from "node:util"
import { appDataFolder, noteFixtureCheckout, runtimeLocation } from "../dist-electron/runtime-service.js"

// Desks live in HOME's app data and hosts in TMPDIR; both point into scratch, short enough for a socket path.
const scratch = mkdtempSync("/tmp/mako-remove-desk-")
process.env.HOME = join(scratch, "home")
process.env.TMPDIR = join(scratch, "tmp")
delete process.env.MAKO_PROFILE
mkdirSync(process.env.TMPDIR)
const run = (...args) => promisify(execFile)(process.execPath, ["scripts/remove-fixture-desk.mjs", ...args], { encoding: "utf8" })
const removed = join(scratch, "removed-worktree")
const live = join(scratch, "live-checkout")
mkdirSync(live)

const desk = async (name, checkout, host) => {
  const data = join(appDataFolder(), `mako-${name}`)
  mkdirSync(join(data, "conversations"), { recursive: true })
  if (checkout) await noteFixtureCheckout(data, checkout)
  const { directory, socket } = runtimeLocation(data)
  mkdirSync(directory, { recursive: true })
  if (host === "stale") writeFileSync(socket, "")
  return { data, directory, socket }
}

let held
try {
  const named = await desk("fixture-named", live, "stale")
  const gone = await desk("fixture-gone", removed, "stale")
  const kept = await desk("fixture-kept", live)
  const unnoted = await desk("fixture-unnoted")
  const other = await desk("dev", removed)
  const running = await desk("fixture-running", removed)
  // A host that answers nothing still holds its socket, so it isn't gone.
  held = createServer(() => {})
  await new Promise((resolve) => held.listen(running.socket, resolve))

  const { stdout } = await run("--profile", "fixture-named")
  assert.equal(existsSync(named.data) || existsSync(named.directory), false, stdout)
  assert.match(stdout, /^Removed .+\/mako-fixture-named and \S+\.$/m)
  assert.equal(existsSync(gone.data) || existsSync(gone.directory), false, "a desk whose checkout is gone goes, with its host's folder")
  assert.match(stdout, /^Removed .+\/mako-fixture-gone and \S+, whose checkout \S+removed-worktree is gone\.$/m)
  assert.ok(existsSync(kept.data), "a desk whose checkout is there stays")
  assert.ok(existsSync(unnoted.data), "a desk that noted no checkout stays")
  assert.ok(existsSync(other.data), "a profile that isn't a fixture's stays")
  assert.ok(existsSync(running.data), "a desk whose host still runs stays")
  assert.match(stdout, /^Left mako-fixture-running: its checkout \S+ is gone, but its host still runs\.$/m)

  await assert.rejects(run("--profile", "dev"), /dev isn't a fixture desk's profile, so nothing was removed/)
  assert.ok(existsSync(other.data))
  console.log("remove fixture desk: a named desk, then every desk whose checkout is gone and whose host left; one in use, unnoted, still running or not a fixture's stays")
} finally {
  held?.close()
  rmSync(scratch, { recursive: true, force: true })
}
