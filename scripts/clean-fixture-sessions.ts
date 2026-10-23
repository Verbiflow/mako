/**
 * Find native sessions that Mako's own tests and probes left in the real
 * provider stores, and remove them through their providers.
 *
 *   npx tsx scripts/clean-fixture-sessions.ts            # list only
 *   npx tsx scripts/clean-fixture-sessions.ts --delete   # remove them
 *   npx tsx scripts/clean-fixture-sessions.ts --root <finished-run> --delete
 *                                                       # remove that exact run now, wherever it ran
 *
 * A fixture session is one whose working directory is a disposable directory
 * that a Mako test or probe creates under the OS temporary directory: one
 * named `mako-…` (every test's `mkdtemp` prefix starts so) or one of the
 * older prefixes below, or a run of the cloud moves proof under
 * `~/.mako/moves-e2e/run-…`, which a cloud machine needs under the person's
 * home rather than the temporary directory. Nothing else qualifies. macOS keeps those
 * directories around, so their presence says nothing; a fixture updated in
 * the last thirty minutes is treated as a run in progress and left alone.
 */
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { defaultCatalog } from "@mako/sessions"
import type { ThreadRef } from "@mako/sessions"
import { makoRecords } from "@mako/sessions/record-streams"

const FIXTURE_DIRECTORY =
  /\/(?:mako|acp-perm|acp-steer|acp-steer-tools|acp-probe|codex-home|codex-steer)-[^/]+(?:\/|$)/

/** The cloud moves proof's runs (`machines -- moves-e2e`): under the home, where a cloud machine can make the same folder. */
const MOVES_RUNS = join(homedir(), ".mako", "moves-e2e")

function fixtureRoot(ref: ThreadRef): boolean {
  const cwd = ref.cwd ?? ""
  if (cwd.startsWith(`${MOVES_RUNS}/run-`)) return true
  const temporary = [
    tmpdir(),
    "/tmp",
    "/private/tmp",
    "/var/folders",
    "/private/var/folders",
  ]
  return (
    temporary.some((root) => cwd.startsWith(root)) &&
    FIXTURE_DIRECTORY.test(cwd)
  )
}

const IN_PROGRESS_MS = 30 * 60_000
const remove = process.argv.includes("--delete")
const rootIndex = process.argv.indexOf("--root")
const requestedRootValue =
  rootIndex < 0 ? undefined : process.argv[rootIndex + 1]
if (rootIndex >= 0 && requestedRootValue === undefined)
  throw new Error("--root needs a finished fixture directory")
const requestedRoot = requestedRootValue
  ? await realpath(requestedRootValue)
  : undefined
const scratch = await mkdtemp(join(tmpdir(), "mako-clean-fixtures-"))
// Deleting opens the record store, so a session deleted here leaves Mako's records too (`SessionCatalog.remove`); scanning alone captures nothing. A dry run doesn't open it.
const catalog = defaultCatalog({ cachePath: join(scratch, "cache.json"), ...remove && { recordsPath: makoRecords() } })
try {
  const refs = await catalog.scan()
  // A run named by `--root` is the person's word that it's finished and disposable, wherever it ran: a scratch
  // profile's worktrees, say, which no temporary prefix names.
  const fixtures = refs
    .filter((ref) => requestedRoot !== undefined || fixtureRoot(ref))
    .filter(
      (ref) => {
        if (requestedRoot === undefined) return true
        // macOS's temporary folders are /var and /tmp, really /private/var and /private/tmp; harnesses record either spelling.
        const cwd = ref.cwd?.replace(/^\/(var|tmp)\//, "/private/$1/")
        return cwd === requestedRoot || cwd?.startsWith(`${requestedRoot}/`)
      }
    )
  const recent = (ref: ThreadRef) =>
    Date.now() - Date.parse(ref.updatedAt ?? "") < IN_PROGRESS_MS
  const live = requestedRoot === undefined ? fixtures.filter(recent) : []
  const stale =
    requestedRoot === undefined
      ? fixtures.filter((ref) => !recent(ref))
      : fixtures
  const byHarness = new Map<string, number>()
  for (const ref of stale)
    byHarness.set(ref.harness, (byHarness.get(ref.harness) ?? 0) + 1)
  console.log(
    `${stale.length} fixture sessions (${[...byHarness].map(([harness, count]) => `${harness} ${count}`).join(", ") || "none"}); ${live.length} updated in the last 30 minutes (kept)`
  )
  for (const ref of stale)
    console.log(
      `  ${ref.harness}  ${(ref.updatedAt ?? "").slice(0, 16)}  ${(ref.title ?? "untitled").slice(0, 40).padEnd(40)}  ${ref.cwd}`
    )
  if (!remove) {
    if (stale.length)
      console.log(
        "Dry run. Add --delete to remove these through their providers."
      )
  } else {
    let removed = 0
    const unsupported: string[] = []
    // A harness refuses to remove a session another one continues (a Codex
    // fork's parent), so what was refused is tried again once a pass removed
    // something: the forks go first, then what they continued.
    let pending = stale
    const refused = new Map<string, string>()
    for (let progress = true; pending.length && progress;) {
      progress = false
      const next: ThreadRef[] = []
      for (const ref of pending) {
        // Removing a session takes the agents it started and the paths folded onto it; one taken that way is counted, not retried.
        if (!catalog.list({ harness: ref.harness }).some((listed) => listed.path === ref.path)) {
          removed += 1
          continue
        }
        try {
          if (await catalog.remove(ref.path)) {
            removed += 1
            progress = true
            refused.delete(ref.path)
          } else unsupported.push(`${ref.harness}: ${ref.path}`)
        } catch (error) {
          refused.set(ref.path, `${ref.harness}: ${error instanceof Error ? error.message : String(error)}`)
          next.push(ref)
        }
      }
      pending = next
    }
    console.log(`Removed ${removed} of ${stale.length}.`)
    for (const entry of unsupported)
      console.log(`  no removable form: ${entry}`)
    for (const reason of refused.values()) console.log(`  refused: ${reason}`)
    if (refused.size) process.exitCode = 1
  }
} finally {
  await catalog.stop()
  await rm(scratch, { recursive: true, force: true })
}
