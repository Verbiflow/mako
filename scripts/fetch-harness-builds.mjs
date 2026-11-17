import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildsDirectory, fetchBuilds, readBuilds } from "./lib/harness-builds.mjs"

/**
 * The harness builds Mako keeps (vendor/harness-builds/sources.json) into vendor/harness-builds/downloads, each
 * checked by its sha256; what the Linux host image's context reads. CI runs it between restoring and saving its cache.
 *
 *   node scripts/fetch-harness-builds.mjs
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
await fetchBuilds(await readBuilds(root), buildsDirectory(root))
