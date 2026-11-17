import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"

/**
 * The exact builds of a harness whose vendor withdraws each one as it ships
 * the next (Devin served 3000.12.57's installer and archives for a day,
 * then 403s), pinned by the sha256 its own manifest gave for the version
 * Mako tested: `vendor/harness-builds/sources.json`, written by
 * `scripts/bump-harness-versions.ts` while that version is the vendor's
 * current one. A pin landing on main publishes them, checked, as assets of a
 * prerelease of this repository (`keptRelease`, `.github/workflows/harness-builds.yml`),
 * which no expiry drops; CI's cache (`.github/actions/harness-builds`) only
 * saves the download. The Linux host image lays them out as the vendor's
 * installer would (`scripts/linux-host/seed-harnesses.mjs`), so an image
 * build never depends on the vendor still serving the build. The checksum
 * alone decides whether bytes are the build.
 */

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
export const buildsFile = (root) => join(root, "vendor/harness-builds/sources.json")
export const buildsDirectory = (root) => join(root, "vendor/harness-builds/downloads")

const Text = z.string().min(1)
const Builds = z.object({
  builds: z.array(z.object({
    harness: Text, version: Text, target: Text, archive: Text, url: Text, sha256: z.string().regex(/^[0-9a-f]{64}$/), unpack: Text,
    links: z.record(z.string(), Text), files: z.record(z.string(), z.string()).optional(),
  })),
})

/** The pinned builds, each `{ harness, version, target, archive, url, sha256, unpack, links, files? }`. */
export async function readBuilds(root) {
  return Builds.parse(JSON.parse(await readFile(buildsFile(root), "utf8"))).builds
}

async function held(file, expected) {
  try {
    return sha256(await readFile(file)) === expected
  } catch {
    return false
  }
}

const run = promisify(execFile)
const curl = (url, file) => run("curl", ["-fsSL", "--retry", "3", "--retry-max-time", "120", "-o", file, url], { maxBuffer: 1024 * 1024 })

/**
 * The prerelease of this repository holding a kept build's archives: a tag no Mako version can be (never semver), and
 * a prerelease, which `releases/latest` (the app's updater, install-macos.sh) never answers.
 */
export const keptRelease = (build) => `harness-builds-${build.harness}-${build.version}`
export const KEPT_REPOSITORY = "Verbiflow/mako"

/** A kept build's archive from its release, with `gh` and a token (CI's), or a refusal saying why it couldn't. */
async function fromRelease(build, file) {
  if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN) throw new Error("no GitHub token to read the kept release with")
  const folder = `${file}.release`
  await rm(folder, { recursive: true, force: true })
  try {
    await run("gh", ["release", "download", keptRelease(build), "--repo", process.env.GITHUB_REPOSITORY ?? KEPT_REPOSITORY, "--pattern", build.archive, "--dir", folder], { maxBuffer: 1024 * 1024 })
    await rename(join(folder, build.archive), file)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

const words = (error) => (error instanceof Error ? error.message : String(error)).split("\n")[0]

/**
 * Each build into `directory`: one already there (from CI's cache) is kept
 * when its checksum matches, else it comes from the vendor's URL, else from
 * its kept release, each checked. A build in no place fails, naming each
 * place and what to do.
 */
export async function fetchBuilds(builds, directory, download = curl, release = fromRelease) {
  await mkdir(directory, { recursive: true })
  for (const build of builds) {
    const file = join(directory, build.archive)
    if (await held(file, build.sha256)) continue
    const partial = `${file}.partial`
    const tried = []
    for (const [where, fetch] of [[build.url, () => download(build.url, partial)], [`release ${keptRelease(build)}`, () => release(build, partial)]]) {
      await rm(partial, { force: true })
      const failure = await fetch().then(() => undefined, words)
      if (failure === undefined && await held(partial, build.sha256)) break
      tried.push(`${where} ${failure === undefined ? "served other bytes than its pinned sha256" : `didn't serve it (${failure})`}`)
    }
    if (tried.length < 2) {
      await rename(partial, file)
      continue
    }
    await rm(partial, { force: true })
    throw new Error(`${build.harness} ${build.version} (${build.archive}) is in no kept copy: ${tried.join("; ")}. Publish it with the harness-builds workflow while the vendor serves it, or move the pin with npx tsx scripts/bump-harness-versions.ts ${build.harness} --write.`)
  }
}
