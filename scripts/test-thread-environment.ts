import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { userTextFrom, withoutControlEnvelope } from "../packages/sessions/src/format.ts"
import type { Actor } from "../electron/contracts/thread-identity.js"
import { THREAD_PORT_COUNT, THREAD_PORT_FIRST, THREAD_PORT_LAST } from "../electron/contracts/thread-environments.js"
import { launchInstructions } from "../electron/control-launch.js"
import { ThreadEnvironments, applyThreadEnvironment } from "../electron/thread-environment.js"
import { ThreadStore } from "../electron/thread-store.js"

const root = mkdtempSync(join(tmpdir(), "mako-thread-environment-"))
const actor: Actor = { kind: "service", name: "migration" }
let clock = 1_000_000_000
const now = () => clock

function started(store: ThreadStore) {
  const conversationId = randomUUID()
  const placed = store.registerJournal({ conversationId, harness: "codex", createdAt: clock, bindings: [] }, actor)
  return { conversationId, ...placed }
}

async function stableAndApart(): Promise<void> {
  const store = new ThreadStore(join(root, "stable.sqlite"), { now })
  const busy = new Set<number>([THREAD_PORT_FIRST + 3])
  const environments = new ThreadEnvironments({ store, dataRoot: join(root, "data"), listening: async (port) => busy.has(port), now })
  const first = started(store)
  const second = started(store)

  const one = await environments.forLaunch(first.conversationId, "Fix the login redirect")
  assert.ok(one)
  assert.equal(one.thread, first.thread)
  assert.equal(one.host, "fix-login-redirect.thread.localhost", "the host is named like the Thread's worktree would be")
  assert.equal(one.port, THREAD_PORT_FIRST + THREAD_PORT_COUNT, "a block with anything listening in it is skipped")
  assert.equal(one.ports, THREAD_PORT_COUNT)
  assert.ok(statSync(one.dataDir).isDirectory(), "the data folder exists before the agent starts")
  assert.equal(statSync(one.dataDir).mode & 0o777, 0o700, "only the user can read a Thread's data folder")

  const two = await environments.forLaunch(second.conversationId, "Fix the login redirect")
  assert.ok(two)
  assert.equal(two.host, "fix-login-redirect-2.thread.localhost", "two Threads never share a host")
  assert.notEqual(two.port, one.port, "two Threads never share ports")
  assert.notEqual(two.dataDir, one.dataDir)

  busy.add(one.port)
  clock += 1000
  const again = await environments.forLaunch(first.conversationId, "Renamed later")
  assert.deepEqual(again, one, "a Thread keeps its values for its life, even while its own app holds its ports")
  assert.deepEqual(environments.launchedWith(first.conversationId), one)

  const untitled = started(store)
  const three = await environments.forLaunch(untitled.conversationId)
  assert.equal(three?.host, `t-${untitled.thread.slice(0, 8)}.thread.localhost`, "a Thread with no name yet is named by its ID")

  const reopened = new ThreadStore(join(root, "stable.sqlite"), { now })
  const other = new ThreadEnvironments({ store: reopened, dataRoot: join(root, "data"), listening: async () => false, now })
  assert.deepEqual(await other.forLaunch(first.conversationId), one, "another host sharing the store hands out the same values")
  reopened.close()

  const later = started(store)
  store.joinThread({ operationId: randomUUID(), sessions: [later.session], thread: first.thread, actor })
  assert.equal((await environments.forLaunch(later.conversationId))?.port, one.port, "Sessions in one Thread share its values")
  store.close()
}

async function reclaimed(): Promise<void> {
  const store = new ThreadStore(join(root, "reclaim.sqlite"), { now })
  const environments = new ThreadEnvironments({ store, dataRoot: join(root, "reclaim-data"), listening: async () => false, now })
  const blocks = Math.floor((THREAD_PORT_LAST - THREAD_PORT_FIRST + 1) / THREAD_PORT_COUNT)
  const owners: { conversationId: string; thread: string; port: number }[] = []
  for (let index = 0; index < blocks; index += 1) {
    const thread = started(store)
    const values = await environments.forLaunch(thread.conversationId, `Thread ${index}`)
    assert.ok(values && values.port + THREAD_PORT_COUNT - 1 <= THREAD_PORT_LAST, "every block stays inside the range")
    owners.push({ conversationId: thread.conversationId, thread: thread.thread, port: values.port })
    clock += 1
  }
  const extra = started(store)
  await assert.rejects(environments.forLaunch(extra.conversationId), /used in the last week/, "a full device never takes a Thread used recently")

  clock += 8 * 24 * 60 * 60 * 1000
  await environments.forLaunch(owners[0]!.conversationId)
  const taken = await environments.forLaunch(extra.conversationId)
  assert.equal(taken?.port, owners[1]!.port, "a new Thread takes the ports of the Thread unused longest")
  assert.equal(store.heldEnvironments().some((values) => values.thread === owners[1]!.thread), false, "that Thread no longer holds them")
  assert.ok(store.heldEnvironments().some((values) => values.thread === owners[0]!.thread), "a Thread used since keeps its ports")
  store.close()
}

async function claimRace(): Promise<void> {
  const store = new ThreadStore(join(root, "race.sqlite"), { now })
  const first = started(store)
  const second = started(store)
  const stale = started(store)
  const claimed = store.claimEnvironment({ thread: first.thread, host: "race.thread.localhost", port: THREAD_PORT_FIRST })
  assert.ok(claimed)
  assert.ok(store.claimEnvironment({ thread: stale.thread, host: "stale.thread.localhost", port: THREAD_PORT_FIRST + 10 }))
  assert.equal(store.claimEnvironment({ thread: second.thread, host: "race.thread.localhost", port: THREAD_PORT_FIRST + 20 }), undefined, "a host another Thread holds is refused")
  assert.equal(store.claimEnvironment({ thread: second.thread, host: "race-2.thread.localhost", port: THREAD_PORT_FIRST, reclaim: stale.thread }), undefined, "a port another Thread holds is refused")
  assert.ok(store.heldEnvironments().some((values) => values.thread === stale.thread), "a refused claim gives nothing up, even what it meant to reclaim")
  assert.equal(store.claimEnvironment({ thread: second.thread, host: "race-2.thread.localhost", port: THREAD_PORT_FIRST + 10, reclaim: stale.thread })?.port, THREAD_PORT_FIRST + 10, "a reclaimed Thread's ports go to the claimant")
  assert.deepEqual(store.claimEnvironment({ thread: first.thread, host: "else.thread.localhost", port: THREAD_PORT_FIRST + 20 }), claimed, "a Thread that has values keeps them")
  store.close()
}

async function listeningProbe(): Promise<void> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = z.object({ port: z.number() }).parse(server.address())
  const store = new ThreadStore(join(root, "probe.sqlite"), { now })
  const environments = new ThreadEnvironments({ store, dataRoot: join(root, "probe-data"), now })
  const thread = started(store)
  const values = await environments.forLaunch(thread.conversationId, "Probe")
  assert.ok(values)
  assert.ok(address.port < values.port || address.port >= values.port + values.ports, "the real probe skips a port something listens on")
  server.close()
  store.close()
}

function processEnvironment(): void {
  const environment = { thread: randomUUID(), host: "fix-login.thread.localhost", port: 20_010, ports: 10, dataDir: "/tmp/fix-login" }
  const env: NodeJS.ProcessEnv = { MAKO_THREAD_ID: "inherited", MAKO_THREAD_PORT: "1", PATH: "/bin" }
  applyThreadEnvironment(env, environment)
  assert.equal(env.MAKO_THREAD_ID, environment.thread)
  assert.equal(env.MAKO_THREAD_HOST, "fix-login.thread.localhost")
  assert.equal(env.MAKO_THREAD_PORT, "20010")
  assert.equal(env.MAKO_THREAD_PORTS, "10")
  assert.equal(env.MAKO_THREAD_URL, "http://fix-login.thread.localhost:20010")
  assert.equal(env.MAKO_THREAD_DATA_DIR, "/tmp/fix-login")
  assert.equal(env.PATH, "/bin")

  const bare: NodeJS.ProcessEnv = { MAKO_THREAD_ID: "inherited", MAKO_THREAD_URL: "http://elsewhere" }
  applyThreadEnvironment(bare)
  assert.deepEqual(bare, {}, "values inherited from a Mako started inside a Thread never reach another Thread's agents")

  const note = launchInstructions(undefined, environment)
  assert.ok(note?.includes("ports 20010-20019"))
  const prompt = `${note}\n\nMake the login page remember me`
  assert.equal(withoutControlEnvelope(prompt), "Make the login page remember me", "history readers strip the note like Local Control's")
  assert.equal(userTextFrom(prompt), "Make the login page remember me")
  assert.equal(launchInstructions(undefined, undefined), undefined, "no note when there is nothing to say")
}

try {
  await stableAndApart()
  await reclaimed()
  await claimRace()
  await listeningProbe()
  processEnvironment()
  assert.ok(existsSync(root))
  console.log("thread environment tests passed")
} finally {
  rmSync(root, { recursive: true, force: true })
}
