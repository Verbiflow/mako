import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { startHost } from "./linux-host/host-process.mjs"

/*
 * A host started with a data root of its own (a test's, a proof's, outside
 * the platform's application-data folder) keeps everything Mako keeps per
 * user there: the record store and every stream its drivers write, decoded
 * views, session memory, the Thread store, model catalogs, installed
 * readings. It starts no shared catalog reader and no login sync, and so
 * writes nothing in the person's `~/.mako` but the account lease (the
 * person's harness sign-ins, which it runs as). The person's home here is a
 * scratch one, so a failure touches nobody's.
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

/** Every path under `folder`, relative to it. */
const listing = (folder) => (existsSync(folder) ? readdirSync(folder, { recursive: true }).map(String).sort() : [])

const host = await startHost({
  dataRoot,
  output: join(scratch, "host-output.log"),
  env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("MAKO_"))), HOME: home, PATH: `${bin}:${process.env.PATH}` },
})
try {
  assert.ok((await host.call("mako:harness-descriptors")).length > 0, "the host answers")
  // The catalog opens its record store and views as it starts.
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !existsSync(join(dataRoot, "records", "records.sqlite")); ) await delay(100)
  await host.call("mako:threads")
} finally {
  const stopped = await host.stop()
  assert.equal(stopped.code, 0, `the host stopped cleanly: ${JSON.stringify(stopped)}`)
}
try {
  const kept = listing(dataRoot)
  for (const store of ["records/records.sqlite", "views/unread.sqlite", "session-memory.sqlite", "threads.sqlite"])
    assert.ok(kept.includes(store), `${store} is in the host's own root: ${kept.filter((path) => !path.includes("/")).join(", ")}`)
  // The person's ~/.mako holds only the account lease's folder: harness sign-ins are the person's, and the host runs as them.
  const touched = listing(join(home, ".mako")).filter((path) => path !== "accounts" && !path.startsWith("accounts/"))
  assert.deepEqual(touched, [], "nothing of Mako's own reaches the person's ~/.mako")
  assert.ok(!existsSync(join(home, "Library", "LaunchAgents")), "no login sync is installed for the person")
  console.log(`isolated host: ${kept.filter((path) => !path.includes("/")).length} stores in its root, nothing in ${relative(scratch, home)}/.mako but the account lease`)
} finally {
  await rm(scratch, { recursive: true, force: true })
}
