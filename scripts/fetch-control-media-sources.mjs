import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { downloadsDirectory, fetchSources, readManifest } from "./lib/control-media-sources.mjs"

/**
 * The recording media's pinned source archives into vendor/control-media/downloads, each checked by its hash; what
 * the build recipe and the Linux host image's context read. CI runs it between restoring and saving its cache.
 *
 *   node scripts/fetch-control-media-sources.mjs
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
await fetchSources(await readManifest(root), downloadsDirectory(root))
