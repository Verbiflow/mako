import { lstat, readdir, rm } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"

/**
 * Packaged builds `package-mac.mjs` keeps in `release/`, the one just written
 * included. Each is about 0.8 GB; 72 of them once filled 42 GB. Three leave
 * the new build, the one before it to compare against, and one more. They are
 * not the rollback path: the installer keeps the replaced app itself.
 */
export const KEEP_RELEASE_BUILDS = 3
/** A build folder touched this recently may belong to a build still running. */
export const RECENT_BUILD_MS = 60 * 60_000

async function bytesUnder(path) {
  const info = await lstat(path).catch(() => null)
  if (!info) return 0
  if (!info.isDirectory()) return info.size
  const entries = await readdir(path).catch(() => [])
  const sizes = await Promise.all(entries.map((name) => bytesUnder(join(path, name))))
  return sizes.reduce((sum, size) => sum + size, 0)
}

/**
 * Remove older packaged builds from `<project>/release` after a package was
 * written to `output`. A build is a visible folder directly in `release/`
 * holding `mac-arm64/Mako.app`; anything else there (files, links, hidden
 * folders such as `update:local`'s own outputs) is left alone. The newest
 * `keep` by modification time stay, as do the folder holding `output` and any
 * folder modified within the last hour. Nothing happens when `output` is
 * outside `release/`.
 */
export async function pruneReleaseBuilds({
  project,
  output,
  keep = KEEP_RELEASE_BUILDS,
  now = Date.now(),
  unregister = async () => {},
  log = console.log,
}) {
  const release = resolve(project, "release")
  const written = relative(release, resolve(output))
  if (written.startsWith("..") || isAbsolute(written)) return []
  // The release folder itself (`release/mac-arm64`) protects no sibling.
  const protectedName = written ? written.split(sep)[0] : null
  const builds = []
  for (const name of await readdir(release).catch(() => [])) {
    if (name.startsWith(".") || name === protectedName) continue
    const folder = join(release, name)
    const app = join(folder, "mac-arm64/Mako.app")
    const infos = await Promise.all([folder, join(folder, "mac-arm64"), app].map((path) => lstat(path).catch(() => null)))
    const [info, , appInfo] = infos
    if (!info?.isDirectory() || info.isSymbolicLink() || !appInfo?.isDirectory() || appInfo.isSymbolicLink()) continue
    builds.push({ folder, app, modified: Math.max(...infos.map((entry) => entry?.mtimeMs ?? 0)) })
  }
  builds.sort((a, b) => b.modified - a.modified)
  // The folder just written counts toward `keep` when it is one of these.
  const kept = Math.max(0, keep - (protectedName ? 1 : 0))
  const removed = []
  let freed = 0
  for (const build of builds.slice(kept)) {
    if (now - build.modified < RECENT_BUILD_MS) continue
    const bytes = await bytesUnder(build.folder)
    await unregister(build.app)
    await rm(build.folder, { recursive: true, force: true })
    removed.push(build.folder)
    freed += bytes
    log(`Removed older packaged build ${build.folder} (${(bytes / 1e9).toFixed(2)} GB)`)
  }
  if (removed.length)
    log(`Freed ${(freed / 1e9).toFixed(2)} GB from ${removed.length} older packaged ${removed.length === 1 ? "build" : "builds"} in ${release}; kept the newest ${keep}.`)
  return removed
}
