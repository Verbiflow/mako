import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { parseArgs } from "node:util"
import type { ChildTranscript } from "../packages/sessions/src/children.ts"
import type { ThreadRef } from "../packages/sessions/src/format.ts"
import type { SessionRecords } from "../packages/sessions/src/harness-records.ts"
import type { SessionProvider } from "../packages/sessions/src/providers/types.ts"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"
import { homePlace, SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"
import { SessionCatalog } from "../packages/sessions/src/catalog.ts"
import { RecordStore } from "../packages/sessions/src/record-store.ts"

/**
 * What a session's child agents cost once its harness deletes the session,
 * on this Mac's own sessions: the newest parents with children of each
 * harness (read read-only through `NativeStores`).
 *
 * - Capture: the parent taken into a scratch store with its children, and
 *   without them (its records less every file and database a child's id
 *   names), each into a store of its own.
 * - Reading back a kept parent: its records restored into a private home,
 *   with and without its children.
 * - Then, in a scratch home holding only those sessions (restored from the
 *   first store), as the catalog reads them: listing the children and
 *   opening one while the harness has them, then after deleting them there,
 *   opening the kept parent, listing its children, and opening a kept
 *   child cold and warm.
 *
 *   npm run bench:kept-children                   up to 3 parents per harness
 *   npm run bench:kept-children -- --per 5 --json
 *   npm run bench:kept-children -- --keep         keep the scratch folder
 *
 * - Linking the children of sessions captured before captures named them,
 *   as the backfill's pass does once per session (`linkChildren`): the
 *   kept parents above, and the newest `--link` sessions of the rail
 *   captured into a scratch store with their links taken out.
 *
 * The harnesses' stores are only read; everything written goes under
 * `$MAKO_THREAD_DATA_DIR` (or `~/.mako/tmp`) and is removed unless `--keep`.
 */

const { values: options } = parseArgs({ options: {
  per: { type: "string", default: "3" },
  /** A parent whose records are larger than this many MiB sits out. */
  mib: { type: "string", default: "64" },
  json: { type: "boolean", default: false },
  keep: { type: "boolean", default: false },
  /** How many of the rail's newest sessions the linking is measured on; 0 leaves it out. */
  link: { type: "string", default: "200" },
} })
const per = Number(options.per)
const MIB = 1024 ** 2
const say = (text: string) => { if (!options.json) console.log(text) }
const base = process.env["MAKO_THREAD_DATA_DIR"] ?? join(homedir(), ".mako", "tmp")
const scratch = join(base, `bench-kept-children-${Date.now()}`)
mkdirSync(scratch, { recursive: true })
const home = homedir()
const readOnly = new NativeStores(true)
/** What restores write with: only scratch homes. */
const writable = new NativeStores(false)
const providers = SAVED_HISTORY_READERS.map((reader) => reader(readOnly))
const ownerOf = (providers: readonly SessionProvider[], path: string) => providers.find((provider) => provider.roots().some((root) => path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}#`))) ?? null
const timed = async <T>(work: () => Promise<T>): Promise<[T, number]> => {
  const started = performance.now()
  const value = await work()
  return [value, performance.now() - started]
}

interface Parent { ref: ThreadRef; children: ChildTranscript[]; records: SessionRecords; recordsMs: number }
const rail = (await new SessionCatalog(providers, { readOnly: true }).scan()).filter((ref) => !ref.archived)
const parents: Parent[] = []
const taken = new Map<string, number>()
for (const ref of rail) {
  if ((taken.get(ref.harness) ?? 0) >= per) continue
  const provider = ownerOf(providers, ref.path)
  const children = ((await provider?.children?.(ref.path).catch(() => null)) ?? []).filter((child) => child.path)
  if (!provider || !children.length) continue
  const [records, recordsMs] = await timed(() => provider.records(ref.path))
  if (!records?.children?.length) continue
  const own = (await provider.recordBytes?.(ref.path).catch(() => null)) ?? ref.bytes ?? 0
  if (own > Number(options.mib) * MIB) continue
  parents.push({ ref, children, records, recordsMs })
  taken.set(ref.harness, (taken.get(ref.harness) ?? 0) + 1)
}
say(`Parents with children: ${parents.length} (${[...taken].map(([harness, count]) => `${harness} ${count}`).join(", ")}), of ${rail.length} sessions in the rail`)

/** The parent's records without its children's: every file and database a child's id names, and the paths it reads them at. */
function withoutChildren(records: SessionRecords, children: readonly ChildTranscript[]): SessionRecords {
  const ids = children.map((child) => child.nativeId)
  const named = (path: string) => ids.some((id) => path.includes(id))
  const { children: _linked, ...rest } = records
  return { ...rest, files: records.files.filter((path) => !named(path)), databases: records.databases.filter((database) => !named(database.path)) }
}

const withStore = new RecordStore(join(scratch, "with"), readOnly)
const withoutStore = new RecordStore(join(scratch, "without"), readOnly)
interface Row { harness: string; parent: string; children: number; records: number; capture: [number, number]; stored: [number, number]; readBack: [number, number]; live?: { list: number; child: number }; kept?: { parent: number; list: number; childCold: number; childWarm: number } }
const rows: Row[] = []
for (const parent of parents) {
  const input = { harness: parent.ref.harness, nativeId: parent.ref.nativeId, home, path: parent.ref.path }
  const [full, fullMs] = await timed(() => withStore.capture({ ...input, records: parent.records }))
  const [bare, bareMs] = await timed(() => withoutStore.capture({ ...input, records: withoutChildren(parent.records, parent.children) }))
  const back = async (store: RecordStore, name: string) => (await timed(() => store.restore({ harness: parent.ref.harness, nativeId: parent.ref.nativeId, home: join(scratch, "read-back", name, parent.ref.nativeId), stores: writable })))[1]
  rows.push({
    harness: parent.ref.harness, parent: parent.ref.nativeId, children: parent.children.length, records: parent.recordsMs,
    capture: [fullMs, bareMs], stored: [full.storedBytes, bare.storedBytes],
    readBack: [await back(withStore, "with"), await back(withoutStore, "without")],
  })
}

// A home holding only these sessions, as the first store restores them, read by the catalog as it reads the person's.
const benchHome = join(scratch, "home")
for (const parent of parents) await withStore.restore({ harness: parent.ref.harness, nativeId: parent.ref.nativeId, home: benchHome, stores: writable })
await withStore.close()
await withoutStore.close()
const place = homePlace(benchHome)
const catalogOver = () => new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(writable, place)), { recordsPath: join(scratch, "kept"), recordsHome: benchHome, readBack: { readers: SAVED_HISTORY_READERS, stores: writable } })
const live = catalogOver()
await live.scan()
// Where each parent is there: a compressed rollout is restored plain, so by its id rather than its path.
const there = new Map(parents.map((parent) => [parent, live.list().find((ref) => ref.harness === parent.ref.harness && ref.nativeId === parent.ref.nativeId)?.path ?? join(benchHome, relative(home, parent.ref.path))]))
for (const [index, parent] of parents.entries()) {
  const path = there.get(parent)!
  const [listed, list] = await timed(() => live.children(path))
  const first = listed?.children.find((child) => child.path)
  if (!first?.path) continue
  const [, child] = await timed(() => live.open(first.path!, false))
  rows[index]!.live = { list, child }
  await live.hold(path)
  // Its harness deletes it: the session and its children.
  const local = SAVED_HISTORY_READERS.map((reader) => reader(writable, place))
  for (const each of [...(listed?.children ?? [])].reverse()) if (each.path) await ownerOf(local, each.path)?.remove?.(each.path).catch(() => false)
  await ownerOf(local, path)?.remove?.(path).catch(() => false)
}
await live.stop()
const kept = catalogOver()
await kept.scan()
for (const [index, parent] of parents.entries()) {
  const path = there.get(parent)!
  if (!kept.list().some((ref) => ref.path === path && ref.archived)) continue
  const [, opened] = await timed(() => kept.open(path, false))
  const [listed, list] = await timed(() => kept.children(path))
  const first = listed?.children.find((child) => child.path)
  if (!first?.path) continue
  const [, childCold] = await timed(() => kept.open(first.path!, false))
  const [, childWarm] = await timed(() => kept.open(first.path!, false))
  rows[index]!.kept = { parent: opened, list, childCold, childWarm }
}
/** Takes out every session's children's paths and its linked mark, as a store from before captures named them holds. */
const unlink = (folder: string) => {
  const db = new DatabaseSync(join(folder, "records.sqlite"))
  db.exec("DELETE FROM child_paths; DELETE FROM marks WHERE name = 'children linked'")
  db.close()
}
await kept.stop()
unlink(join(scratch, "kept"))
const relinking = catalogOver()
await relinking.scan()
const keptLinks = await relinking.linkChildren()
await relinking.stop()

// The rail's newest sessions, captured into a scratch store from this Mac's harness stores (read only), then linked as a pass would.
const railLinks = await (async () => {
  const count = Number(options.link)
  if (!count) return null
  const folder = join(scratch, "rail")
  const opened = { recordsPath: folder, recordsHome: home, readBack: { readers: SAVED_HISTORY_READERS, stores: readOnly } }
  const capturing = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(readOnly)), opened)
  let held = 0
  for (const ref of (await capturing.scan()).filter((each) => !each.archived)) {
    if (held >= count) break
    const provider = ownerOf(providers, ref.path)
    if (((await provider?.recordBytes?.(ref.path).catch(() => null)) ?? ref.bytes ?? 0) > Number(options.mib) * MIB) continue
    if (await capturing.hold(ref.path).catch(() => false)) held += 1
  }
  await capturing.stop()
  unlink(folder)
  const linking = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(readOnly)), opened)
  await linking.scan()
  const report = await linking.linkChildren()
  const again = await linking.linkChildren()
  await linking.stop()
  return { held, report, again: again.looked }
})()

if (options.json) console.log(JSON.stringify({ rows, keptLinks, railLinks }, null, 2))
else {
  const ms = (value: number | undefined) => (value === undefined ? "-" : `${value.toFixed(0)}`)
  const kib = (value: number) => `${(value / 1024).toFixed(0)}`
  say("harness   parent    kids  records  capture ms (with/without)  stored KiB (with/without)  read back ms (with/without)  live list/child ms  kept parent/list/child cold/warm ms")
  for (const row of rows)
    say(`${row.harness.padEnd(9)} ${row.parent.slice(0, 8)}  ${String(row.children).padStart(4)}  ${ms(row.records).padStart(7)}  ${`${ms(row.capture[0])}/${ms(row.capture[1])}`.padStart(25)}  ${`${kib(row.stored[0])}/${kib(row.stored[1])}`.padStart(25)}  ${`${ms(row.readBack[0])}/${ms(row.readBack[1])}`.padStart(27)}  ${`${ms(row.live?.list)}/${ms(row.live?.child)}`.padStart(18)}  ${row.kept ? `${ms(row.kept.parent)}/${ms(row.kept.list)}/${ms(row.kept.childCold)}/${ms(row.kept.childWarm)}` : "-"}`)
}
if (!options.json) {
  say(`Linking kept parents' children once: ${keptLinks.looked} sessions, ${keptLinks.children} children of ${keptLinks.parents}, in ${keptLinks.ms} ms`)
  if (railLinks) say(`Linking the rail's newest ${railLinks.held} sessions once: ${railLinks.report.children} children of ${railLinks.report.parents} parents in ${railLinks.report.ms} ms (${(railLinks.report.ms / Math.max(1, railLinks.report.looked)).toFixed(1)} ms a session, ${railLinks.report.failed} failed); a second pass looked at ${railLinks.again}`)
}
if (!options.keep) rmSync(scratch, { recursive: true, force: true })
else say(`Kept ${scratch}`)
