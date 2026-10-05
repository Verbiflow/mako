import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { userTextFrom, withoutMakoFraming } from "../packages/sessions/src/format.ts"
import { execFileSync } from "node:child_process"
import { mkdirSync, realpathSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import { ThreadIdSchema, type Actor } from "../electron/contracts/thread-identity.js"
import { AppKeySchema, THREAD_PORT_COUNT, THREAD_PORT_FIRST, THREAD_PORT_LAST } from "../electron/contracts/thread-environments.js"
import { launchInstructions } from "../electron/control-launch.js"
import { ThreadEnvironments, applyThreadEnvironment, folderApp } from "../electron/thread-environment.js"
import { ThreadStore } from "../electron/thread-store.js"

const root = mkdtempSync(join(tmpdir(), "mako-thread-environment-"))
const actor: Actor = { kind: "service", name: "migration" }
let clock = 1_000_000_000
const now = () => clock

const app = (thread: string) => AppKeySchema.parse(thread)

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

  const unclaimed = await environments.fileDataDir({ conversationId: first.conversationId })
  assert.equal(unclaimed, environments.dataDir(app(first.thread)))
  assert.equal(existsSync(unclaimed!), false, "File resolution never creates a data folder")
  assert.equal(store.heldEnvironments().length, 0, "File resolution never claims ports or updates their use")
  assert.equal(await environments.fileDataDir({}), undefined, "A missing owner cannot use the active Thread's data folder")

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
  assert.equal(await environments.fileDataDir({ conversationId: first.conversationId, cwd: root }), one.dataDir, "A running agent keeps the data folder it was launched with after a cwd change")

  const untitled = started(store)
  const three = await environments.forLaunch(untitled.conversationId)
  assert.equal(three?.host, `t-${untitled.thread.slice(0, 8)}.thread.localhost`, "a Thread with no name yet is named by its ID")

  const reopened = new ThreadStore(join(root, "stable.sqlite"), { now })
  const other = new ThreadEnvironments({ store: reopened, dataRoot: join(root, "data"), listening: async () => false, now })
  assert.deepEqual(await other.forLaunch(first.conversationId), one, "another host sharing the store hands out the same values")
  reopened.close()

  const tab = store.createSession({ operationId: randomUUID(), thread: first.thread, actor })
  const later = randomUUID()
  store.registerJournal({ conversationId: later, harness: "codex", createdAt: clock, bindings: [], session: tab.session }, actor)
  assert.equal((await environments.forLaunch(later))?.port, one.port, "Sessions in one Thread share its values")
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
  assert.equal(store.heldEnvironments().some((values) => values.app === app(owners[1]!.thread)), false, "that Thread no longer holds them")
  assert.ok(store.heldEnvironments().some((values) => values.app === app(owners[0]!.thread)), "a Thread used since keeps its ports")
  store.close()
}

async function claimRace(): Promise<void> {
  const store = new ThreadStore(join(root, "race.sqlite"), { now })
  const first = started(store)
  const second = started(store)
  const stale = started(store)
  const claimed = store.claimEnvironment({ app: app(first.thread), host: "race.thread.localhost", port: THREAD_PORT_FIRST })
  assert.ok(claimed)
  assert.ok(store.claimEnvironment({ app: app(stale.thread), host: "stale.thread.localhost", port: THREAD_PORT_FIRST + 10 }))
  assert.equal(store.claimEnvironment({ app: app(second.thread), host: "race.thread.localhost", port: THREAD_PORT_FIRST + 20 }), undefined, "a host another Thread holds is refused")
  assert.equal(store.claimEnvironment({ app: app(second.thread), host: "race-2.thread.localhost", port: THREAD_PORT_FIRST, reclaim: app(stale.thread) }), undefined, "a port another Thread holds is refused")
  assert.ok(store.heldEnvironments().some((values) => values.app === app(stale.thread)), "a refused claim gives nothing up, even what it meant to reclaim")
  assert.equal(store.claimEnvironment({ app: app(second.thread), host: "race-2.thread.localhost", port: THREAD_PORT_FIRST + 10, reclaim: app(stale.thread) })?.port, THREAD_PORT_FIRST + 10, "a reclaimed Thread's ports go to the claimant")
  assert.deepEqual(store.claimEnvironment({ app: app(first.thread), host: "else.thread.localhost", port: THREAD_PORT_FIRST + 20 }), claimed, "a Thread that has values keeps them")
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
  const thread = ThreadIdSchema.parse(randomUUID())
  const environment = { thread, app: app(thread), host: "fix-login.thread.localhost", port: 20_010, ports: 10, dataDir: "/tmp/fix-login" }
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
  assert.equal(withoutMakoFraming(prompt), "Make the login page remember me", "history readers strip the note like Local Control's")
  assert.equal(userTextFrom(prompt), "Make the login page remember me")
  assert.equal(launchInstructions(undefined, undefined), undefined, "no note when there is nothing to say")
}

/** One app per folder: Threads sharing a folder share its values; a Worktree Thread's app is its own. */
async function onePerFolder(): Promise<void> {
  const store = new ThreadStore(join(root, "folders.sqlite"), { now })
  const environments = new ThreadEnvironments({ store, dataRoot: join(root, "folders-data"), listening: async () => false, now })
  const project = realpathSync(mkdtempSync(join(root, "folders-")))
  const shop = join(project, "shop")
  mkdirSync(join(shop, "web"), { recursive: true })
  execFileSync("git", ["init", "-q", shop])
  const first = started(store)
  const second = started(store)
  const one = await environments.forConversation(first.conversationId, "Fix the cart", shop)
  const two = await environments.forConversation(second.conversationId, "Add coupons", join(shop, "web"))
  assert.ok(one && two)
  assert.equal(one.app, folderApp(shop), "a folder no Worktree Thread owns has its own app")
  assert.equal(two.app, one.app, "two Threads in one folder, even from a subfolder, share its app")
  assert.equal(two.port, one.port)
  assert.equal(two.dataDir, one.dataDir)
  assert.equal(await environments.fileDataDir({ cwd: join(shop, "web"), thread: second.thread }), one.dataDir, "An imported native conversation resolves the folder's data owner from its recorded cwd")
  assert.equal(one.host, "shop.thread.localhost", "the folder's app is named after the folder")
  assert.notEqual(two.thread, one.thread, "each agent still knows its own Thread")

  const owner = started(store)
  const worktree = join(project, "shop-coupons")
  mkdirSync(worktree)
  execFileSync("git", ["init", "-q", worktree])
  store.attachWorktree({ path: worktree, thread: owner.thread, repoRoot: shop, project: "shop", branch: "mako/coupons", base: "main" })
  const own = await environments.forConversation(owner.conversationId, "Coupons", worktree)
  assert.equal(own?.app, owner.thread, "a Worktree Thread's app is keyed by the Thread")
  assert.equal(own?.host, "shop-coupons.thread.localhost", "and named after its worktree")
  assert.notEqual(own?.port, one.port)
  assert.equal(await environments.fileDataDir({ cwd: worktree, thread: owner.thread }), own?.dataDir, "A native worktree conversation uses its Worktree Thread's data folder")
  assert.equal(await environments.fileDataDir({ cwd: join(project, "elsewhere") }), environments.dataDir(folderApp(join(project, "elsewhere"))), "Native folder ownership is deterministic even when ports have not been claimed")
  const visitor = started(store)
  assert.equal((await environments.forConversation(visitor.conversationId, "Look around", worktree))?.app, owner.thread, "another Thread's Session in that worktree shares its app")
  assert.deepEqual(environments.held(one.app), { app: one.app, host: one.host, port: one.port, ports: THREAD_PORT_COUNT, dataDir: one.dataDir })
  assert.equal(environments.held(folderApp(join(project, "elsewhere"))), undefined, "a folder that never claimed holds nothing")
  store.close()
}

/** Values held per Thread before apps were one per folder move over, so Worktree Threads keep their ports. */
async function heldBefore(): Promise<void> {
  const path = join(root, "before.sqlite")
  const store = new ThreadStore(path, { now })
  const thread = started(store)
  store.close()
  const db = new DatabaseSync(path)
  const device = z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM store_meta WHERE key = 'device'").get()).value
  db.prepare("INSERT INTO thread_environments VALUES (?, ?, ?, ?, ?, ?)").run(thread.thread, device, "old.thread.localhost", THREAD_PORT_FIRST + 40, clock, clock)
  db.close()
  const reopened = new ThreadStore(path, { now })
  assert.deepEqual(reopened.environment(app(thread.thread)), { app: thread.thread, host: "old.thread.localhost", port: THREAD_PORT_FIRST + 40, usedAt: clock })
  reopened.close()
  const raw = new DatabaseSync(path)
  assert.equal(z.object({ count: z.number() }).parse(raw.prepare("SELECT count(*) AS count FROM thread_environments").get()).count, 0, "moved, not copied")
  raw.close()
}

try {
  await stableAndApart()
  await onePerFolder()
  await heldBefore()
  await reclaimed()
  await claimRace()
  await listeningProbe()
  processEnvironment()
  assert.ok(existsSync(root))
  console.log("thread environment tests passed")
} finally {
  rmSync(root, { recursive: true, force: true })
}
