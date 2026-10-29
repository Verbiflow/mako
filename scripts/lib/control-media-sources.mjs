import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdir, readFile, rename, rm } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

/**
 * The recording media's pinned sources (vendor/control-media/sources.json), each archive checked by its sha256. A
 * source lists the URLs that serve it, mirrors first: the checksum alone decides whether bytes are the source, so any
 * host serving the same bytes is as good as the project's own, and one being down only moves the fetch to the next.
 * Archives are kept in vendor/control-media/downloads, which the Mac build, the Linux host image's build context and
 * CI's cache all read, so a source is downloaded once per checkout and never again while its hash is pinned.
 */

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")

/** What a build is made of. Where an archive was fetched from doesn't change its bytes, which its hash names. */
export const sourceIdentity = ({ name, version, archive, sha256 }) => ({ name, version, archive, sha256 })

export const manifestFile = (root) => join(root, "vendor/control-media/sources.json")
export const downloadsDirectory = (root) => join(root, "vendor/control-media/downloads")

export async function readManifest(root) {
  const manifest = JSON.parse(await readFile(manifestFile(root), "utf8"))
  for (const source of manifest.sources) {
    assert.match(source.sha256, /^[0-9a-f]{64}$/, `${source.name} pins no sha256`)
    assert.ok(Array.isArray(source.urls) && source.urls.length > 0, `${source.name} lists no URLs`)
    for (const url of source.urls) assert.equal(new URL(url).protocol, "https:", `${source.name} is fetched over HTTPS: ${url}`)
  }
  return manifest
}

const execute = promisify(execFile)

/** One attempt at one URL. Unreachable hosts fail within seconds, so the next URL is tried promptly. */
async function curl(url, file) {
  await execute("curl", ["--fail", "--silent", "--show-error", "--location", "--connect-timeout", "20", "--max-time", "120", url, "--output", file])
    .catch((error) => {
      throw new Error(error.stderr?.trim() || error.message)
    })
}

/**
 * Every archive the manifest pins, in `directory`, each with the bytes its hash names. One already there is kept when
 * its hash matches. Otherwise each URL is tried in order: bytes are written beside the archive and take its name only
 * once their hash matches, so a failed, partial or altered download never stands in for the source.
 *
 * Returns, per archive, where it came from: `held` for one already in the directory, else the URL that served it.
 */
export async function fetchSources(manifest, directory, download = curl) {
  await mkdir(directory, { recursive: true })
  const fetched = []
  for (const source of manifest.sources) {
    const archive = join(directory, source.archive)
    const held = await readFile(archive).catch((error) => {
      if (error.code !== "ENOENT") throw error
      return undefined
    })
    if (held && sha256(held) === source.sha256) {
      console.log(`[control-media] ${source.archive}: held, sha256 ${source.sha256}`)
      fetched.push({ archive: source.archive, from: "held" })
      continue
    }
    const failures = held ? [`the held copy: sha256 ${sha256(held)}`] : []
    const partial = `${archive}.${process.pid}.partial`
    let served
    for (const url of source.urls) {
      try {
        await download(url, partial)
        const got = sha256(await readFile(partial))
        if (got === source.sha256) {
          await rename(partial, archive)
          served = url
          break
        }
        failures.push(`${url}: sha256 ${got}`)
      } catch (error) {
        failures.push(`${url}: ${error instanceof Error ? error.message.trim() : String(error)}`)
      } finally {
        await rm(partial, { force: true })
      }
    }
    for (const failure of failures) console.log(`[control-media] ${source.archive}: ${failure}`)
    if (!served) throw new Error(`No URL served ${source.archive} with sha256 ${source.sha256}:\n${failures.join("\n")}`)
    console.log(`[control-media] ${source.archive}: from ${served}, sha256 ${source.sha256}`)
    fetched.push({ archive: source.archive, from: served })
  }
  return fetched
}
