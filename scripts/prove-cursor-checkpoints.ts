// Collects the Cursor SDK checkpoints in a clone of a state root and proves every agent reads as it did:
//   cp -cR ~/.mako/cursor-sdk <scratch>/cursor-sdk     (an APFS clone: no space until the collection writes)
//   npx tsx scripts/prove-cursor-checkpoints.ts --root <scratch>/cursor-sdk [--agent <id>]
// Each agent's thread (`CursorProvider.read`) and its newest turns (`recent`) are read before and after, with
// `--quiet-ms 0`, and must be the same; it prints what each store took and what the collection freed.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { collectCursorCheckpoints } from "@mako/sessions/cursor-sdk-collect"
import { cursorSdkStateRoot } from "@mako/sessions/cursor-sdk-paths"
import { makoUserRoot } from "@mako/sessions/mako-root"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { CursorProvider } from "@mako/sessions"

const args = process.argv.slice(2)
const option = (name: string) => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const stateRoot = resolve(option("--root") ?? "")
assert.ok(existsSync(join(stateRoot, "index.db")), "pass --root <a clone of a Cursor SDK state root>")
assert.notEqual(stateRoot, resolve(cursorSdkStateRoot(makoUserRoot())), "runs only on a clone, never the person's own store")
const only = option("--agent")
const stores = new NativeStores(false, stateRoot)
// The provider reads `<user root>/cursor-sdk`; an empty home keeps it off the person's `~/.cursor`.
const home = mkdtempSync(join(tmpdir(), "mako-cursor-checkpoints-"))
const reader = () => new CursorProvider(stores, home, dirname(stateRoot), join(home, "outputs.sqlite"))
const digest = (json: string) => createHash("sha256").update(json).digest("hex")
const agentStores = readdirSync(join(stateRoot, "agents"))
  .map((directory) => join(stateRoot, "agents", directory, "store.db"))
  .filter((path) => existsSync(path) && (!only || path.includes(createHash("sha256").update(only).digest("hex"))))

async function readAll(): Promise<Map<string, { thread: string; recent: string; entries: number; ms: number }>> {
  const provider = reader()
  const read = new Map<string, { thread: string; recent: string; entries: number; ms: number }>()
  for (const path of agentStores) {
    const started = performance.now()
    try {
      const thread = await provider.read(path)
      const recent = await provider.recent(path, 4)
      const entries = thread?.entries ?? []
      read.set(path, { thread: digest(JSON.stringify(entries)), recent: digest(JSON.stringify(recent)), entries: entries.length, ms: Math.round(performance.now() - started) })
    } catch (error) {
      read.set(path, { thread: `unreadable: ${error instanceof Error ? error.message : String(error)}`, recent: "", entries: 0, ms: 0 })
    }
  }
  return read
}

try {
  const before = await readAll()
  const started = performance.now()
  const sweeps = collectCursorCheckpoints({ stateRoot, stores, quietMs: 0 })
  const collectMs = Math.round(performance.now() - started)
  const after = await readAll()
  let failures = 0
  for (const path of agentStores) {
    const was = before.get(path)
    const is = after.get(path)
    const sweep = sweeps.find((each) => path.includes(each.directory))
    const same = was?.thread === is?.thread && was?.recent === is?.recent
    if (!same) failures += 1
    if (!same || (sweep?.fileBefore ?? 0) > 100e6)
      console.log(
        `${same ? "same" : "DIFFERS"} ${sweep?.directory.slice(0, 18)} ${(sweep?.fileBefore ?? 0) / 1e9 > 0 ? `${((sweep?.fileBefore ?? 0) / 1e9).toFixed(2)} GB → ${((sweep?.fileAfter ?? 0) / 1e9).toFixed(2)} GB` : ""}`,
        `deleted=${sweep?.deleted} ${sweep?.outcome}${sweep?.reason ? ` (${sweep.reason})` : ""}${sweep?.vacuumed ? " vacuumed" : ""} ${sweep?.ms} ms; entries=${was?.entries}, read ${was?.ms} → ${is?.ms} ms`,
        same ? "" : `\n  before ${was?.thread}\n  after  ${is?.thread}`,
      )
  }
  const sum = (pick: (sweep: (typeof sweeps)[number]) => number) => sweeps.reduce((total, sweep) => total + pick(sweep), 0)
  console.log(
    `\n${agentStores.length} agents: ${(sum((sweep) => sweep.fileBefore) / 1e9).toFixed(2)} GB → ${(sum((sweep) => sweep.fileAfter) / 1e9).toFixed(2)} GB,`,
    `${sum((sweep) => sweep.deleted)} roots deleted, ${sweeps.filter((sweep) => sweep.vacuumed).length} vacuumed, collected in ${collectMs} ms; ${failures} read differently`,
  )
  assert.equal(failures, 0, "every agent reads after the collection as it did before")
} finally {
  rmSync(home, { recursive: true, force: true })
}
