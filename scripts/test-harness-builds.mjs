import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, readlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fetchBuilds, readBuilds, sha256 } from "./lib/harness-builds.mjs"
import { testScratch } from "./lib/test-scratch.mjs"

/**
 * The harness builds Mako keeps (scripts/lib/harness-builds.mjs): a kept copy whose checksum matches is used as
 * is, else the vendor's bytes are fetched and checked; bytes that aren't the pinned build are refused, and a build
 * in neither place fails saying the vendor withdrew it and to move the pin. Then seed-harnesses.mjs lays one out
 * under a home as the vendor's installer does. The repository's own pins name every field.
 *
 *   node scripts/test-harness-builds.mjs
 */
const root = testScratch("mako-harness-builds-")
{
  for (const build of await readBuilds(".")) assert.match(build.sha256, /^[0-9a-f]{64}$/, `${build.archive} is pinned by a sha256`)

  // A build: a tarball holding bin/devin, as Devin's archives do.
  const staged = join(root, "staged")
  await mkdir(join(staged, "bin"), { recursive: true })
  await writeFile(join(staged, "bin", "devin"), "#!/bin/sh\necho devin 9.9.9\n", { mode: 0o755 })
  const archive = join(root, "devin-9.9.9-target.tar.gz")
  execFileSync("tar", ["czf", archive, "-C", staged, "bin"])
  const bytes = await readFile(archive)
  const target = { x64: "x86_64-unknown-linux", arm64: "aarch64-unknown-linux" }[process.arch]
  const build = {
    harness: "devin", version: "9.9.9", target, archive: "devin-9.9.9-target.tar.gz", url: "https://example.invalid/devin.tar.gz", sha256: sha256(bytes),
    unpack: ".local/share/devin/cli/_versions/9.9.9",
    links: { ".local/share/devin/cli/_versions/current": "9.9.9", ".local/bin/devin": "~/.local/share/devin/cli/_versions/current/bin/devin" },
    files: { ".local/share/devin/cli/_versions/9.9.9/distribution": "curl-bash\n" },
  }

  // Fetched from its URL and checked; a kept copy is then used without a download.
  const downloads = join(root, "downloads")
  let fetched = 0
  await fetchBuilds([build], downloads, async (_url, file) => { fetched++; await writeFile(file, bytes) })
  await fetchBuilds([build], downloads, async () => { throw new Error("a kept copy is used without a download") })
  assert.equal(fetched, 1)
  // Other bytes than the pinned build are refused, and a build in neither place says to move the pin.
  await assert.rejects(fetchBuilds([build], join(root, "other"), async (_url, file) => writeFile(file, "not the build")), /served other bytes than its pinned sha256/)
  await assert.rejects(fetchBuilds([build], join(root, "gone"), async () => { throw new Error("curl: (22) The requested URL returned error: 403") }),
    /devin 9\.9\.9 \(devin-9\.9\.9-target\.tar\.gz\) is in no kept copy, and https:\/\/example\.invalid\/devin\.tar\.gz didn't serve it \(curl: \(22\) The requested URL returned error: 403\)\. The vendor has withdrawn it: move the pin/)

  // Laid out as Devin's installer lays it: the build, `current`, the link on PATH and its distribution marker.
  await writeFile(join(downloads, "sources.json"), JSON.stringify({ builds: [build, { ...build, target: "another-target", archive: "absent.tar.gz" }] }))
  const home = join(root, "home")
  await mkdir(home)
  execFileSync(process.execPath, ["scripts/linux-host/seed-harnesses.mjs", downloads], { env: { ...process.env, HOME: home } })
  assert.equal(execFileSync(join(home, ".local/bin/devin"), { encoding: "utf8" }).trim(), "devin 9.9.9")
  assert.equal(await readlink(join(home, ".local/share/devin/cli/_versions/current")), "9.9.9")
  assert.equal(await readFile(join(home, ".local/share/devin/cli/_versions/9.9.9/distribution"), "utf8"), "curl-bash\n")
  // A harness the image isn't given is left out.
  const without = join(root, "without")
  await mkdir(without)
  execFileSync(process.execPath, ["scripts/linux-host/seed-harnesses.mjs", downloads, "opencode"], { env: { ...process.env, HOME: without } })
  await assert.rejects(readFile(join(without, ".local/bin/devin")))
  console.log("PASS: kept harness builds come from a checked copy or the vendor's checked bytes, say when the vendor withdrew them, and lay out as the vendor's installer does")
}
