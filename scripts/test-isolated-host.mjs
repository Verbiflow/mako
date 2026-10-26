import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { setTimeout as delay } from "node:timers/promises"
import { startHost } from "./linux-host/host-process.mjs"

/*
 * A host started with a data root of its own (a test's, a proof's, outside
 * the platform's application-data folder) keeps everything Mako keeps per
 * user there: the record store and every stream its drivers write, decoded
 * views, session memory, the Thread store, model catalogs, installed
 * readings, the accounts Mako keeps with their selection and leases, and
 * the Cursor SDK agents Mako runs (`cursorSdkStateRoot`). It
 * starts no shared catalog reader and no login sync, and writes nothing at
 * all in the person's `~/.mako`, nor reads their account selection: it runs
 * each harness on its default login, the one a terminal uses. The person's
 * home here is a scratch one holding an account layout and a Cursor SDK store
 * as the installed app keeps them, so a failure touches nobody's. Its catalog
 * lists the Cursor agent in its own root and not the person's: that store is
 * Mako's, not Cursor's, so it isn't shared the way `~/.cursor` is.
 *
 * Needs the built host: `npx tsgo -b packages/host`.
 */

const scratch = await realpath(await mkdtemp(join(tmpdir(), "mako-isolated-host-")))
const home = join(scratch, "home")
const dataRoot = join(scratch, "data")
const bin = join(scratch, "bin")
await mkdir(home, { recursive: true })
await mkdir(bin)
const program = resolve("packages/host/dist/mako-host.js")
await chmod(program, 0o755)
await symlink(program, join(bin, "mako-host"))

// The person's Mako runs Codex on an account it keeps, and has chosen Claude Code's own login.
const people = join(home, ".mako", "accounts")
await mkdir(join(people, "codex", "work"), { recursive: true, mode: 0o700 })
await writeFile(join(people, "codex", "work", "auth.json"), JSON.stringify({ tokens: { access_token: "fixture", account_id: "fixture" } }), { mode: 0o600 })
await mkdir(join(people, "selection"), { mode: 0o700 })
await writeFile(join(people, "selection", "codex.json"), JSON.stringify({ codex: "work" }), { mode: 0o600 })
await writeFile(join(people, "selection", "claude.json"), JSON.stringify({ claude: null }), { mode: 0o600 })

// The person's Cursor agents, in the WAL mode the SDK keeps its stores in, and one agent in the isolated host's own root.
const pairs = resolve("scripts/fixtures/native-decoding/cursor/pairs")
const cursorStore = async (pair, stateRoot) => {
  await cp(join(pairs, pair, "home", ".mako", "cursor-sdk"), stateRoot, { recursive: true })
  // Each closes as the SDK's last connection does, taking its `-wal` and `-shm` with it.
  const wal = (path) => {
    const database = new DatabaseSync(path)
    try {
      database.exec("PRAGMA journal_mode = WAL")
      return database.prepare("SELECT name FROM sqlite_master WHERE name = 'agents'").get() && database.prepare("SELECT agent_id FROM agents").get().agent_id
    } finally {
      database.close()
    }
  }
  for (const agent of readdirSync(join(stateRoot, "agents"))) wal(join(stateRoot, "agents", agent, "store.db"))
  return wal(join(stateRoot, "index.db"))
}
const personsAgent = await cursorStore("stopped-shell", join(home, ".mako", "cursor-sdk"))
const ownAgent = await cursorStore("read-and-answer", join(dataRoot, "cursor-sdk"))

/** Every path under `folder`, relative to it. */
const listing = (folder) => (existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : [])
/** Each path under `folder` with its size, mtime and, for a file, its contents' digest: what any write would change. */
const snapshot = (folder) => listing(folder).map((path) => {
  const stat = statSync(join(folder, path))
  return `${path} ${stat.size} ${stat.mtimeMs}${stat.isFile() ? ` ${createHash("sha256").update(readFileSync(join(folder, path))).digest("hex")}` : ""}`
})
const before = snapshot(join(home, ".mako"))
/** SQLite's files beside a WAL database that a connection opened: any non-strict reader leaves them. */
const readerFiles = (folder) => listing(folder).filter((path) => /-(?:shm|wal)$/.test(path))
assert.deepEqual(readerFiles(join(home, ".mako")), [], "the person's Cursor store is at rest before the host starts")

const host = await startHost({
  dataRoot,
  output: join(scratch, "host-output.log"),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MAKO_"))), HOME: home, PATH: `${bin}:${process.env.PATH}` },
})
let codex
try {
  assert.ok((await host.call("mako:harness-descriptors")).length > 0, "the host answers")
  // The catalog opens its record store and views as it starts.
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !existsSync(join(dataRoot, "records", "records.sqlite")); ) await delay(100)
  // Its catalog lists the Cursor agent its own root holds, read as the host's driver would continue it.
  let cursor = []
  for (let listed = { ready: false }; !listed.ready; await delay(100)) {
    listed = await host.call("mako:threads", { harness: "cursor" })
    cursor = listed.threads ?? []
  }
  assert.deepEqual(cursor.map((thread) => thread.nativeId), [ownAgent], `the isolated host lists its own Cursor agent, not the person's (${personsAgent})`)
  assert.ok(cursor[0].path.startsWith(join(dataRoot, "cursor-sdk", "agents")), cursor[0].path)
  assert.ok((await host.call("mako:thread-open", cursor[0].path))?.entries.length, "its own agent reads")
  // Usage reads the SDK's index of the host's own root.
  await host.call("mako:usage")
  // Choosing an account takes the account lease and writes the selection, as every launch's lease does.
  await host.call("mako:account-select", "codex", null)
  codex = (await host.call("mako:accounts")).accounts.filter((account) => account.harness === "codex")
} finally {
  const stopped = await host.stop()
  assert.equal(stopped.code, 0, `the host stopped cleanly: ${JSON.stringify(stopped)}`)
}
try {
  const kept = listing(dataRoot)
  for (const store of ["records/records.sqlite", "views/unread.sqlite", "session-memory.sqlite", "threads.sqlite", "accounts/selection/codex.json"])
    assert.ok(kept.includes(store), `${store} is in the host's own root: ${kept.filter((path) => !path.includes("/")).join(", ")}`)
  assert.deepEqual(JSON.parse(readFileSync(join(dataRoot, "accounts", "selection", "codex.json"), "utf8")), { codex: null })
  assert.deepEqual(codex.map((account) => [account.name, account.active]), [["default", true]], "the person's Codex account and their choice of it stay theirs: Codex runs on its own login here")
  assert.deepEqual(readerFiles(join(home, ".mako")), [], "no reader left SQLite's -shm or -wal in the person's Cursor store")
  assert.deepEqual(snapshot(join(home, ".mako")), before, "nothing reaches the person's ~/.mako: no lease, no selection, no store, no Cursor agent")
  assert.ok(!existsSync(join(home, "Library", "LaunchAgents")), "no login sync is installed for the person")
  console.log(`isolated host: ${kept.filter((path) => !path.includes("/")).length} entries in its root, its accounts and its Cursor agent among them; ${relative(scratch, home)}/.mako as it was, cursor-sdk included`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
