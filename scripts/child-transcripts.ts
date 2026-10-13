import { parseArgs } from "node:util"
import { childCompleteness, formatChildCompleteness, SAVED_HISTORY_READERS } from "@mako/sessions"
import { NativeStores } from "@mako/sessions/read-only-sqlite"

/**
 * Whether every child agent this Mac's sessions name is here and reads,
 * per harness: sessions with children, children by state and why, calls
 * that resolve to a row of the parent's transcript, children that read
 * through their harness's reader, and what each step cost. Read-only: the
 * stores are opened as a fixture desk opens them.
 *
 *   npm run audit:children                     every harness, reading each child
 *   npm run audit:children -- codex            one harness
 *   npm run audit:children -- --no-decode      links only, no transcript read
 *   npm run audit:children -- --json           one machine-readable array
 *
 * Exits 1 when a located child doesn't read or a direct child's call is no
 * row of its parent. Partial and missing children are reported, not failed:
 * they are what the harness kept.
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    json: { type: "boolean", default: false },
    "no-decode": { type: "boolean", default: false },
    parents: { type: "string" },
  },
})

const stores = new NativeStores(true)
const readers = SAVED_HISTORY_READERS.map((make) => make(stores)).filter((reader) => !positionals[0] || reader.harness === positionals[0])
if (!readers.length) {
  console.error(`No reader for ${positionals[0]}. Harnesses: ${[...new Set(SAVED_HISTORY_READERS.map((make) => make(stores).harness))].join(", ")}`)
  process.exit(2)
}
const reports = await childCompleteness(readers, {
  decode: !options["no-decode"],
  parents: options.parents === undefined ? undefined : Number(options.parents),
})
for (const reader of readers) reader.close?.()

if (options.json) console.log(JSON.stringify(reports, null, 2))
else console.log(reports.map(formatChildCompleteness).join("\n\n"))
if (reports.some((report) => report.failures.length)) process.exit(1)
