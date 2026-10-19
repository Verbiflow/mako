import { SessionArchive } from "../../dist/archive.js"
import { ArchiveMigration } from "../../dist/archive-migration.js"

/**
 * Dies mid-way through the archive's migration (`drop`: right after its
 * first row is dropped) or while it reclaims space (`vacuum`: once the
 * rewrite has started), as a quit or a crash would, for
 * `archive-migration.mjs` to check what's left.
 */
const [root, when] = process.argv.slice(2)
const archive = new SessionArchive(root)
await archive.load()
if (when === "drop") {
  const migration = new ArchiveMigration(archive, {
    live: () => archive.copies(),
    discovered: () => true,
    captured: () => true,
    decodesNative: async () => 2,
    decodesRecords: async () => null,
    keepListing: async () => true,
  })
  await migration.pass({ stopped: () => false, yieldToPerson: async () => {}, onDropped: () => process.kill(process.pid, "SIGKILL") })
} else {
  setTimeout(() => process.kill(process.pid, "SIGKILL"), 15)
  await archive.reclaim({ minBytes: 0 })
  // Finished before the kill: wait for it.
  await new Promise((resolve) => setTimeout(resolve, 1_000))
}
