import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SessionCatalog } from "../dist/catalog.js"

// A catalog makes its cache's folder as it starts, and a save never makes it again: a reader whose data was deleted
// under it (a host's data root, removed while the shared reader still runs) writes nothing back there, so the folder
// stays gone and the reader leaves on its own. Once, a debounced save put `~/.mako/catalogs/<id>` back into the root a
// proof was deleting, and the delete failed with ENOTEMPTY (#634, host-x64).
const root = await mkdtemp(join(tmpdir(), "mako-catalog-cache-folder-"))
try {
  const folder = join(root, "catalogs", "reader")
  const catalog = new SessionCatalog([], { cachePath: join(folder, "metadata.json") })
  await catalog.prepare()
  assert.ok(existsSync(folder), "the catalog makes its cache's folder as it starts")
  await rm(join(root, "catalogs"), { recursive: true, force: true })
  // SAFETY: the test drives the debounced save directly, as its timer would.
  await catalog["saveCache"]()
  assert.equal(existsSync(join(root, "catalogs")), false, "a save after the folder was deleted doesn't put it back")
  catalog.stop?.()
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("catalog cache folder: made as the catalog starts, never again by a save, so a deleted reader's folder stays gone")
