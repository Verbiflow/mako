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
 * current one. CI keeps the archives in its cache (`.github/actions/harness-builds`),
 * saved on main as soon as a pin changes, and the Linux host image lays them
 * out as the vendor's installer would (`scripts/linux-host/seed-harnesses.mjs`),
 * so an image build never depends on the vendor still serving the build.
 * The checksum alone decides whether bytes are the build.
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
 * Each build into `directory`: one already there (from CI's cache) is kept
 * when its checksum matches, else it comes from its URL and is checked. A
 * build in neither place fails, naming what to do: the vendor withdrew it and
 * no copy was kept, so the pin moves.
 */
export async function fetchBuilds(builds, directory, download = curl) {
  await mkdir(directory, { recursive: true })
  for (const build of builds) {
    const file = join(directory, build.archive)
    if (await held(file, build.sha256)) continue
    const partial = `${file}.partial`
    await rm(partial, { force: true })
    const failure = await download(build.url, partial).then(() => undefined, (error) => error instanceof Error ? error.message : String(error))
    if (failure === undefined && await held(partial, build.sha256)) {
      await rename(partial, file)
      continue
    }
    await rm(partial, { force: true })
    throw new Error(`${build.harness} ${build.version} (${build.archive}) is in no kept copy, and ${build.url} ${failure === undefined ? "served other bytes than its pinned sha256" : `didn't serve it (${failure.split("\n")[0]})`}. The vendor has withdrawn it: move the pin with npx tsx scripts/bump-harness-versions.ts ${build.harness} --write.`)
  }
}
