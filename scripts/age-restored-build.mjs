import { readdir, utimes } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

/*
 * Dates every package's build info before the checkout, so `tsgo -b` over outputs restored from another run compiles
 * what changed by content and never by time. Run after the restore and before `npm run build:control-runtime`.
 *
 * `tsgo -b` first asks a project whether its build info is newer than every input, by modification time, and skips
 * or only re-stamps it when so, without reading a source. A restored entry keeps the times of the run that built it,
 * and that run can end after this one checked out: PR #987's gate restored main's entry built 2 s after its checkout,
 * found the host and client up to date, re-stamped the host's build info and saved main's declarations under the pull
 * request's sources; its performance job restored that, kept the host and recompiled the client against the old
 * `agentToolText`. With every build info dated 2000, each project's sources are newer, so each builds, and the
 * incremental build compares every file's hash with its build info's: unchanged files cost a hash, changed ones
 * compile, as they would cold.
 *
 *   node scripts/age-restored-build.mjs [root]    root defaults to this checkout; `test-restored-build.mjs` passes its own
 */

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."))
// Not the epoch: a time of 0 is what the compiler reads a missing file as.
const before = new Date("2000-01-01T00:00:00Z")
for (const name of await readdir(join(root, "packages"))) {
  await utimes(join(root, "packages", name, "tsconfig.tsbuildinfo"), before, before).catch(error => {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
  })
}
