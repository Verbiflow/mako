import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KEEP_RELEASE_BUILDS, pruneReleaseBuilds } from "./lib/prune-release.mjs"
import { finishRehearsal, rehearsalOptions } from "./test-local-build.mjs"

const root = await mkdtemp(join(tmpdir(), "mako-build-cleanup-"))
try {
  const project = join(root, "project")
  const release = join(project, "release")
  const hour = 60 * 60_000
  const now = Date.now()
  const build = async (name, ageHours, { app = true } = {}) => {
    const folder = join(release, name)
    await mkdir(join(folder, app ? "mac-arm64/Mako.app/Contents" : "mac-arm64"), { recursive: true })
    if (app) await writeFile(join(folder, "mac-arm64/Mako.app/Contents/payload"), "x".repeat(1000))
    const time = new Date(now - ageHours * hour)
    for (const path of app ? [join(folder, "mac-arm64/Mako.app"), join(folder, "mac-arm64"), folder] : [join(folder, "mac-arm64"), folder])
      await utimes(path, time, time)
  }
  await build("written", 30)
  for (const [index, age] of [10, 20, 40, 50, 60].entries()) await build(`old-${index}`, age)
  await build("concurrent", 0.5)
  await build("no-app", 100, { app: false })
  await build(".local-update-abc", 100)
  await mkdir(join(release, "notes"))
  await writeFile(join(release, "notes/readme.txt"), "keep")
  await writeFile(join(release, "latest-mac.yml"), "keep")
  await build("linked-target", 100)
  await symlink(join(release, "linked-target"), join(release, "linked"))
  const outside = join(root, "elsewhere")
  await mkdir(join(outside, "old/mac-arm64/Mako.app"), { recursive: true })

  const unregistered = []
  const logged = []
  const prune = (output) => pruneReleaseBuilds({
    project,
    output,
    now,
    unregister: async (app) => { unregistered.push(app) },
    log: (line) => logged.push(line),
  })
  assert.deepEqual(await prune(join(outside, "new")), [], "a package written outside release/ prunes nothing")
  const removed = await prune(join(release, "written"))
  // Kept: the folder just written and the newest two others, one of them the
  // recent build; the symlink, hidden, app-less and loose entries are not builds.
  assert.equal(KEEP_RELEASE_BUILDS, 3)
  assert.deepEqual(removed.sort(), ["old-1", "old-2", "old-3", "old-4", "linked-target"].map((name) => join(release, name)).sort())
  assert.deepEqual(unregistered.sort(), removed.map((folder) => join(folder, "mac-arm64/Mako.app")).sort())
  assert.deepEqual(
    (await readdir(release)).sort(),
    [".local-update-abc", "concurrent", "latest-mac.yml", "linked", "no-app", "notes", "old-0", "written"]
  )
  assert.ok((await readdir(join(outside, "old/mac-arm64/Mako.app"))), "nothing outside release/ is touched")
  assert.match(logged.at(-1), /^Freed 0\.00 GB from 5 older packaged builds in .*; kept the newest 3\.$/)
  assert.equal(logged.filter((line) => line.startsWith("Removed older packaged build")).length, 5)
  // Packaging into release/ itself (release/mac-arm64) keeps three others.
  await build("old-5", 70)
  assert.deepEqual(await prune(release), [join(release, "old-5")])
  // A recent build stays even past the newest three.
  await build("recent-older", 0.9)
  await utimes(join(release, "concurrent"), new Date(now), new Date(now))
  for (const name of ["old-0", "written"]) await utimes(join(release, name), new Date(now - 0.1 * hour), new Date(now - 0.1 * hour))
  assert.deepEqual(await prune(release), [], "every build here was touched within the hour")

  // A rehearsal prints its result and removes its folder unless kept.
  assert.deepEqual(rehearsalOptions([]).keep, false)
  assert.deepEqual(rehearsalOptions(["../x", "--keep", "--as-installed-updater"]), { source: join(process.cwd(), "../x"), keep: true, asInstalledUpdater: true })
  assert.throws(() => rehearsalOptions(["--other"]), /test:settings-build/)
  const rehearsal = async () => {
    const folder = await mkdtemp(join(root, "rehearsal-"))
    await mkdir(join(folder, "updates/build-a1/output/mac-arm64/Mako.app"), { recursive: true })
    await mkdir(join(folder, "updates/checkout/node_modules"), { recursive: true })
    await writeFile(join(folder, "result.json"), JSON.stringify({ phases: ["copying", "compiling"], result: { kind: "ready" } }))
    return folder
  }
  const lines = []
  const removedRehearsal = await rehearsal()
  const apps = []
  await finishRehearsal(removedRehearsal, { keep: false, log: (line) => lines.push(line), unregister: async (app) => { apps.push(app) } })
  await assert.rejects(readdir(removedRehearsal), { code: "ENOENT" })
  assert.deepEqual(apps, [join(removedRehearsal, "updates/build-a1/output/mac-arm64/Mako.app")])
  assert.match(lines[0], /"phases":\["copying","compiling"\]/)
  assert.match(lines[1], /Removed the Settings build's working folder/)
  const keptRehearsal = await rehearsal()
  await finishRehearsal(keptRehearsal, { keep: true, log: (line) => lines.push(line) })
  assert.ok((await readdir(keptRehearsal)).includes("result.json"))
  assert.match(lines.at(-1), /kept at .* \(--keep\)/)
  console.log("Build cleanup: release/ keeps the newest packaged builds, recent and foreign folders, and nothing outside it; Settings build rehearsals print their result and remove their folder unless kept")
} finally {
  await rm(root, { recursive: true, force: true })
}
