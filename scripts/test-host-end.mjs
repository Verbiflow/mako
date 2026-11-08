import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { endHost } from "./lib/host-end.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * A test's host ended and its traces cleared whatever fails on the way (`endHost`, `npm run test:node-host-secrets`).
 * A host that didn't quit is kept and killed, and when both of those throw (its log folder can't be made, it's gone by
 * the time it's killed) the keychain item and the scratch folder still go, keychain first, each failure said.
 */
const root = testScratch("mako-host-end-")
const blocked = join(root, "a-file")
await writeFile(blocked, "not a folder")

/** A pid that was a process and has ended: killing it throws ESRCH. */
async function endedPid() {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" })
  await new Promise((resolve) => child.once("exit", resolve))
  return child.pid
}

async function ended(steps) {
  const done = []
  const reported = []
  const quit = await endHost({
    ...steps,
    cleanup: [
      ["deleting the keychain item", async () => done.push("keychain")],
      ["removing the scratch folder", async () => done.push("scratch")],
    ],
    report: (line) => reported.push(line),
  })
  return { quit, done, reported }
}

// It didn't quit, and both earlier steps throw: its logs' folder can't be made, and it ended before it was killed.
{
  const pid = await endedPid()
  const { quit, done, reported } = await ended({
    quit: async () => false,
    keep: () => mkdir(join(blocked, "logs"), { recursive: true }),
    kill: () => process.kill(pid, "SIGKILL"),
  })
  assert.equal(quit, false, "it says the host didn't quit")
  assert.deepEqual(done, ["keychain", "scratch"], "the keychain item and the scratch folder go all the same, keychain first")
  assert.equal(reported.length, 2, `both failures are said: ${reported.join(" | ")}`)
  assert.match(reported[0], /^keeping the host's logs failed: .*ENOTDIR/)
  assert.match(reported[1], /^killing the host failed: .*ESRCH/)
}

// Asking it to quit throws: it's still kept and killed, and everything is cleared.
{
  const steps = []
  const { quit, done, reported } = await ended({
    quit: async () => {
      throw new Error("the socket is gone")
    },
    keep: async () => steps.push("keep"),
    kill: () => steps.push("kill"),
  })
  assert.equal(quit, false)
  assert.deepEqual(steps, ["keep", "kill"], "a host whose quit couldn't be asked is kept and killed")
  assert.deepEqual(done, ["keychain", "scratch"])
  assert.match(reported[0], /^asking the host to quit failed: the socket is gone/)
}

// A cleanup step that fails doesn't stop the next.
{
  const done = []
  const reported = []
  await endHost({
    quit: async () => true,
    keep: async () => assert.fail("a host that quit isn't kept"),
    kill: () => assert.fail("nor killed"),
    cleanup: [
      ["deleting the keychain item", async () => {
        throw new Error("security exited 44")
      }],
      ["removing the scratch folder", async () => done.push("scratch")],
    ],
    report: (line) => reported.push(line),
  })
  assert.deepEqual(done, ["scratch"], "the scratch folder goes though the keychain step failed")
  assert.deepEqual(reported, ["deleting the keychain item failed: security exited 44"])
}

// A host that quit: nothing kept, nothing killed, everything cleared.
{
  const { quit, done, reported } = await ended({
    quit: async () => true,
    keep: async () => assert.fail("a host that quit isn't kept"),
    kill: () => assert.fail("nor killed"),
  })
  assert.equal(quit, true)
  assert.deepEqual(done, ["keychain", "scratch"])
  assert.deepEqual(reported, [])
}

console.log("host end: a host that didn't quit is kept and killed, and the keychain item and scratch folder go whatever failed first")
