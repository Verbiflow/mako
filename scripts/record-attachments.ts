import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import { appDataFolder } from "@mako/host/transport/service"
import { attachmentReaders } from "../packages/host/src/threads/attachment-readers.ts"
import { sessionMemoryPath } from "../packages/host/src/threads/session-memory.ts"
import { AttachmentSweep, headOf, totals, type AttachmentSweepReport, type FilesAndBytes } from "../packages/sessions/src/attachment-sweep.ts"
import { openReadOnly } from "../packages/sessions/src/read-only-sqlite.ts"
import { takeLock } from "../packages/sessions/src/record-locks.ts"
import { makoViews } from "../packages/sessions/src/view-cache.ts"

/**
 * `tsx scripts/records.ts attachments`: the attachment files Mako keeps (the
 * archive's `assets/`, each profile's `LiveAssets`, the staged
 * `~/.mako/attachments`), as the backfill's sweep sees them
 * (`attachment-sweep.ts`).
 *
 *   attachments                      a dry run: each folder's totals, what's named and by whom, what's held
 *                                    and why, what a sweep would take, what the record store also holds,
 *                                    and the trash; reads only
 *   attachments --sweep              one pass now, under the backfill's lock: trash what nothing names,
 *                                    bring back what's named again, delete what sat in the trash long enough
 *   attachments --restore-trash      move everything in every trash back (undoing a sweep), under the lock
 *
 *   --archive <dir>    the archive (default ~/.mako/archive)
 *   --app-data <dir>   where every profile's data root sits (default this platform's)
 *   --store <dir>      the record store (default ~/.mako/records)
 *   --here             read every source in this process rather than in a child, as the worker does
 *   --json
 *
 * A dry run keeps its marks in memory and writes nothing anywhere.
 */
export async function attachmentsCommand(args: string[], given: { store: string; archive: string; json: boolean }): Promise<number> {
  const option = (name: string): string | undefined => {
    const at = args.indexOf(name)
    return at < 0 ? undefined : args[at + 1]
  }
  const sweep = args.includes("--sweep")
  const restoring = args.includes("--restore-trash")
  const { store, archive, json } = given
  const appData = resolve(option("--app-data") ?? appDataFolder())
  const app = z.object({ name: z.string() }).parse(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).name
  const sweeper = new AttachmentSweep({
    archive,
    views: makoViews(),
    readers: () => attachmentReaders({ appData, app, dataRoot: join(appData, app), sessionMemory: sessionMemoryPath(), home: homedir() }),
    // As the catalog worker reads: in a child of its own, so this process's memory is what the sweep keeps.
    ...!args.includes("--here") && { aside: process.execPath },
    ...!(sweep || restoring) && { state: null },
  })
  const control = { stopped: () => false, yieldToPerson: async () => {} }
  if (sweep || restoring) {
    const lock = await takeLock(join(store, "backfill.lock"))
    if (!lock) {
      console.log("A backfill pass holds the store's lock; try again when it ends")
      return 1
    }
    try {
      if (restoring) {
        console.log(`${await sweeper.restoreAll()} files moved back from the trash`)
        return 0
      }
      return print(await sweeper.pass(control, { sweep: true }), null, json)
    } finally {
      await lock.release()
    }
  }
  const report = await sweeper.pass(control, { sweep: false })
  return print(report, heldByStore(store, report), json)
}

/** The files whose bytes the record store also holds, by folder: a version of a unit with the same hash and size. */
function heldByStore(store: string, report: AttachmentSweepReport): Record<string, FilesAndBytes> | null {
  const path = join(store, "records.sqlite")
  if (!existsSync(path)) return null
  const { database } = openReadOnly(path, { timeout: 2_000 })
  try {
    const held = new Set<string>()
    for (const row of z.object({ digest: z.string(), size: z.number() }).array().parse(database.prepare("SELECT lower(hex(digest)) AS digest, size FROM versions WHERE kind = 'replace' AND digest IS NOT NULL").all()))
      held.add(`${row.digest}:${row.size}`)
    const byFolder: Record<string, FilesAndBytes> = {}
    for (const [label, folder] of Object.entries(report.folders)) {
      const total = { files: 0, bytes: 0 }
      for (const name of existsSync(folder.path) ? readdirSync(folder.path) : []) {
        const head = headOf(name)
        if (!head || head.length !== 64) continue
        const size = statSync(join(folder.path, name)).size
        if (!held.has(`${head}:${size}`)) continue
        total.files += 1
        total.bytes += size
      }
      byFolder[label] = total
    }
    return byFolder
  } finally {
    database.close()
  }
}

function print(report: AttachmentSweepReport, held: Record<string, FilesAndBytes> | null, json: boolean): number {
  if (json) {
    console.log(JSON.stringify({ ...report, ...held && { heldByStore: held } }, null, 2))
    return 0
  }
  const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`
  const both = (total: FilesAndBytes) => `${total.files} files, ${mib(total.bytes)}`
  for (const [label, folder] of Object.entries(report.folders)) {
    if (!folder.files && !folder.trash.files) continue
    console.log(`${label} (${folder.path}): ${folder.files} files, ${mib(folder.bytes)}`)
    console.log(`  named ${both(folder.named)}; held ${both(folder.held)}; kept ${both(folder.kept)}; young ${both(folder.young)}`)
    console.log(`  reclaimable (a sweep takes them): ${both(folder.reclaimable)}`)
    if (held?.[label]?.files) console.log(`  whose bytes the record store also holds: ${both(held[label]!)} (kept while named: no reader of these paths reads the store)`)
    if (folder.trash.files) console.log(`  trash: ${both(folder.trash)}`)
    if (report.swept) console.log(`  this pass: ${both(folder.trashed)} trashed, ${folder.restored} brought back, ${both(folder.deleted)} deleted`)
  }
  const all = totals(report)
  console.log(`all: ${all.files} files, ${mib(all.bytes)}; named ${mib(all.named.bytes)}, held ${mib(all.held.bytes)}, kept ${mib(all.kept.bytes)}, young ${mib(all.young.bytes)}, reclaimable ${mib(all.reclaimable.bytes)}, trash ${mib(all.trash.bytes)}`)
  console.log("named or held by:")
  for (const [owner, total] of Object.entries(report.owners).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 20)) console.log(`  ${owner.padEnd(60)} ${both(total)}`)
  for (const hold of report.holds) console.log(`hold: ${hold.why}${hold.through < Number.MAX_SAFE_INTEGER ? `, files from before ${new Date(hold.through).toISOString()}` : ""}`)
  if (report.stopped) console.log(`nothing swept: ${report.stopped}`)
  for (const entry of report.unreadable.slice(0, 10)) console.log(`  unreadable: ${entry.path}: ${entry.why}`)
  console.log(`${report.sources.total} sources: ${report.sources.read} read, ${report.sources.cached} unchanged since the last pass, ${report.sources.unreadable} unreadable; ${Math.round(report.ms)} ms`)
  for (const slow of report.slowest) console.log(`  ${String(slow.ms).padStart(6)} ms  ${slow.path}`)
  console.log(`this process's peak RSS ${mib(process.resourceUsage().maxRSS * 1024)}${report.childPeakRss ? `, its reading child's ${mib(report.childPeakRss)}` : ""}`)
  return 0
}
