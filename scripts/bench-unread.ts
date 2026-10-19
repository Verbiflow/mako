import { mkdirSync, rmSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { NativeStores } from "../packages/sessions/src/read-only-sqlite.ts"
import { SAVED_HISTORY_READERS } from "../packages/sessions/src/readers.ts"
import { SessionCatalog } from "../packages/sessions/src/catalog.ts"
import { UNREAD_INDEX_FILE, UnreadIndex, unreadCounts } from "../packages/sessions/src/unread-index.ts"
import type { EntryOf } from "../packages/sessions/src/entries.ts"

/**
 * What counting unread records by harness version costs, on this Mac's own
 * sessions: the newest sessions in the rail (read read-only through strict
 * `NativeStores`) decoded into a scratch views folder, which notes their
 * unread records (`unread-index.ts`), and taken into a scratch record store,
 * which names the version that wrote each; then the count Settings ›
 * Diagnostics and `harness:doctor` read, timed cold and warm.
 *
 *   npx tsx scripts/bench-unread.ts                    the newest 300 sessions of at most 256 MiB each
 *   npx tsx scripts/bench-unread.ts --sessions 1000 --max-mib 64
 *   npx tsx scripts/bench-unread.ts --per-session 20  also note 20 made-up unread records in each session, as a release no decoder knows would leave
 */

const { values: options } = parseArgs({
  options: {
    sessions: { type: "string", default: "300" },
    "max-mib": { type: "string", default: "256" },
    keep: { type: "boolean", default: false },
    "per-session": { type: "string", default: "0" },
  },
})
const base = process.env.MAKO_THREAD_DATA_DIR ?? join(homedir(), ".mako", "tmp")
const scratch = join(base, `bench-unread-${process.pid}`)
mkdirSync(scratch, { recursive: true })
const views = join(scratch, "views")
const records = join(scratch, "records")
const stores = new NativeStores(true)
const catalog = new SessionCatalog(SAVED_HISTORY_READERS.map((reader) => reader(stores)), { viewsPath: views, recordsPath: records, readBack: { readers: SAVED_HISTORY_READERS, stores } })
try {
  const discovered = performance.now()
  await catalog.scan()
  const max = Number(options["max-mib"]) * 1024 ** 2
  const chosen = catalog.list().filter((ref) => !ref.archived && !ref.childOf && (ref.path.includes("#") || (ref.bytes ?? 0) <= max)).slice(0, Number(options.sessions))
  console.log(`The rail: ${catalog.list().length} sessions in ${Math.round(performance.now() - discovered)} ms; ${chosen.length} chosen`)
  const decoded = performance.now()
  let unread = 0
  for (const ref of chosen) {
    const thread = await catalog.open(ref.path, false).catch(() => null)
    unread += thread?.entries.filter((entry) => entry.type === "unread" && entry.reason !== "undrawn").length ?? 0
    await catalog.hold(ref.path).catch(() => false)
  }
  console.log(`Decoded and held ${chosen.length} sessions in ${((performance.now() - decoded) / 1000).toFixed(1)} s; ${unread} unread records among them`)
  await catalog.stop()
  const made = Number(options["per-session"])
  if (made) {
    // A release that writes a kind no decoder knows, in every session: rows as the views would note them, each naming its record's bytes.
    const index = new UnreadIndex(join(views, UNREAD_INDEX_FILE))
    const entries = (count: number): EntryOf<"unread">[] => Array.from({ length: count }, (_, at) => {
      const range: [number, number] = [at * 400, at * 400 + 200]
      return { type: "unread", kind: `response_item kind_${at % 4}`, reason: "unknown", id: `@${range[0]}`, at: Date.now(), record: { ranges: [range] } }
    })
    for (const ref of chosen) index.note(ref, "bench", entries(made))
    index.close()
  }
  const times: number[] = []
  let counts = unreadCounts({ views, records })
  for (let run = 0; run < 7; run++) {
    const started = performance.now()
    counts = unreadCounts({ views, records })
    times.push(performance.now() - started)
  }
  times.sort((a, b) => a - b)
  console.log(`Counting: ${counts.records} records in ${counts.sessions} sessions, ${counts.groups.length} groups, ${counts.unattributed} without a version; ${times[0]!.toFixed(1)} ms fastest, ${times[3]!.toFixed(1)} ms median of 7 (index ${UNREAD_INDEX_FILE})`)
  for (const group of counts.groups.slice(0, 12)) console.log(`  ${group.harness.padEnd(8)} ${(group.version ?? "unknown").padEnd(14)} ${group.source ?? ""}  ${group.kind}  ${group.reason} ×${group.count} in ${group.sessions}`)
} finally {
  if (!options.keep) rmSync(scratch, { recursive: true, force: true })
  else console.log(`Kept: ${scratch}`)
}
