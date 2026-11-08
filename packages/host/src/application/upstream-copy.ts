import { constants } from "node:fs"
import { lstat } from "node:fs/promises"
import { join } from "node:path"
import type { Git } from "@mako/git"
import { physicalFiles } from "../base/physical-files.js"

/**
 * The upstream's commit, checked out clean in Mako's own clone of the source
 * checkout, where an update that builds the upstream builds it.
 *
 * The person's checkout is only read: the clone borrows its objects
 * (`--shared`), so it costs no copy of the history, and the commit the
 * reading fetched is already there. Each build checks out its commit with
 * `--force` and removes untracked files, so nothing another session left
 * lying around goes in; what Git ignores stays, so `node_modules` and the
 * compile output carry from one build to the next and only what changed is
 * rebuilt. No hook runs: the person's templates aren't the build's.
 */
export const UPSTREAM_COPY = "upstream.noindex"

/**
 * What a clean checkout lacks that packaging needs and rebuilding costs many
 * minutes: the recording encoder, built from FFmpeg's sources. Packaging
 * checks its recipe and rebuilds it when the commit's differs, so the source
 * checkout's copy is only ever a head start.
 */
const CARRIED = ["vendor/control-media/darwin-arm64"]

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false"]

/** Check `commit` out clean in the clone under `root`, making it first, and answer its folder. */
export async function checkoutUpstream(git: Git, source: string, root: string, commit: string, signal?: AbortSignal): Promise<string> {
  const copy = join(root, UPSTREAM_COPY)
  const files = await physicalFiles()
  const place = async () => {
    await git.run({ cwd: copy, args: [...NO_HOOKS, "checkout", "--quiet", "--force", "--detach", commit], timeoutMs: 5 * 60_000, signal })
    await git.run({ cwd: copy, args: [...NO_HOOKS, "clean", "-ffdq"], timeoutMs: 2 * 60_000, signal })
  }
  const cloned = await lstat(join(copy, ".git")).then(() => true, () => false)
  if (cloned) {
    try {
      await place()
    } catch {
      signal?.throwIfAborted()
      // A clone whose borrowed objects the source has since pruned: start it again.
      await files.rm(copy, { recursive: true, force: true })
      return checkoutUpstream(git, source, root, commit, signal)
    }
  } else {
    await files.rm(copy, { recursive: true, force: true })
    await git.run({ cwd: root, args: [...NO_HOOKS, "clone", "--quiet", "--shared", "--no-checkout", "--", source, copy], timeoutMs: 5 * 60_000, signal })
    await place()
  }
  for (const path of CARRIED) {
    const from = join(source, path)
    const to = join(copy, path)
    if (!(await lstat(from).catch(() => null))?.isDirectory() || (await lstat(to).catch(() => null))) continue
    await files.cp(from, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  }
  return copy
}

/**
 * Give the copy a `node_modules` to start from: the source checkout's,
 * cloned, when the copy has none. The build then installs whatever the
 * commit's package-lock.json lists beyond it, in the copy.
 */
export async function seedDependencies(source: string, copy: string): Promise<boolean> {
  const files = await physicalFiles()
  if (await lstat(join(copy, "node_modules")).catch(() => null)) return false
  if (!(await lstat(join(source, "node_modules")).catch(() => null))?.isDirectory()) return false
  await files.cp(join(source, "node_modules"), join(copy, "node_modules"), { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE })
  return true
}
