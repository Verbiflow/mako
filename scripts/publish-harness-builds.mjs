import { execFile } from "node:child_process"
import { join, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { buildsDirectory, fetchBuilds, KEPT_REPOSITORY, keptRelease, readBuilds } from "./lib/harness-builds.mjs"

/**
 * Publishes each kept harness build (vendor/harness-builds/sources.json) as an asset of its prerelease,
 * `harness-builds-<harness>-<version>`: the copy CI reads once the vendor withdraws the build and the cache has let it
 * go. Each archive is checked by its sha256 first. A prerelease, never `latest`, under a tag no Mako version can be, so
 * neither the app's updater nor install-macos.sh ever reads it. An asset already there is left as it is. Run by
 * .github/workflows/harness-builds.yml when a pin lands on main, while the vendor still serves the build.
 *
 *   GH_TOKEN=… node scripts/publish-harness-builds.mjs
 */
const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const repository = process.env.GITHUB_REPOSITORY ?? KEPT_REPOSITORY
const gh = (...args) => run("gh", [...args, "--repo", repository], { maxBuffer: 16 * 1024 * 1024 })
const builds = await readBuilds(root)
await fetchBuilds(builds, buildsDirectory(root))
for (const tag of new Set(builds.map(keptRelease))) {
  const kept = builds.filter((build) => keptRelease(build) === tag)
  const files = kept.map((build) => join(buildsDirectory(root), build.archive))
  const assets = await gh("release", "view", tag, "--json", "assets", "--jq", ".assets[].name").then(({ stdout }) => stdout.split("\n").filter(Boolean), () => undefined)
  if (assets === undefined) {
    const [{ harness, version }] = kept
    const notes = `The ${harness} ${version} builds Mako tested, kept for CI once ${harness} withdraws them; each checked against the sha256 in vendor/harness-builds/sources.json. Not a Mako release.`
    await gh("release", "create", tag, ...files, "--prerelease", "--latest=false", "--title", `Harness builds: ${harness} ${version}`, "--notes", notes, "--target", process.env.GITHUB_SHA ?? "main")
    console.log(`${tag}: published ${kept.map((build) => build.archive).join(", ")}`)
    continue
  }
  const missing = files.filter((file, index) => !assets.includes(kept[index].archive))
  if (missing.length) await gh("release", "upload", tag, ...missing)
  console.log(`${tag}: ${missing.length ? `added ${missing.length}` : "already holds every archive"}`)
}
