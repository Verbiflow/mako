import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { lutimes, mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { after, test } from "node:test"
import { controlArtifactsDirectory, controlArtifactsRoot, controlRecordingsRoot } from "@mako/control/program"
import { HostJobs } from "@mako/host/base/host-jobs"
import { ARTIFACTS_JOB, MachineArtifacts, machineArtifactPlaces, type ArtifactPlace } from "@mako/host/media/machine-artifacts"
import { TurnMedia } from "@mako/host/media/turn-media"

/**
 * A cloud machine's recordings and artifacts under caps of their own (`machine-artifacts.ts`): each kind keeps its
 * newest under its cap and loses its oldest first; nothing changed within the grace goes, however far over; a
 * recording goes whole, a task's screenshots one by one; the media database stays; a place inside another is counted
 * once; links are never followed out. The places are the ones control and the host write to.
 */
const scratch = await mkdtemp(join(tmpdir(), "mako-machine-artifacts-"))
after(() => rm(scratch, { recursive: true, force: true }))

const NOW = Date.parse("2026-10-30T20:00:00.000Z")
const MINUTE = 60_000
const GRACE = 15 * MINUTE

/** A file of `bytes` changed `minutesAgo` before the sweep. */
async function file(path: string, bytes: number, minutesAgo: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, Buffer.alloc(bytes, 1))
  const at = new Date(NOW - minutesAgo * MINUTE)
  await utimes(path, at, at)
}

/** The folder's own time too, as a recording's is when its last file was written. */
async function aged(path: string, minutesAgo: number): Promise<void> {
  const at = new Date(NOW - minutesAgo * MINUTE)
  await utimes(path, at, at)
}

function places(root: string, caps: { recordings: number; artifacts: number; media: number }): ArtifactPlace[] {
  return machineArtifactPlaces({ recordings: join(root, "recordings"), artifacts: join(root, "artifacts"), media: join(root, "media") }).map((place) => ({ ...place, capBytes: caps[place.kind] }))
}

test("each kind keeps its newest under its cap, the oldest going first: a recording whole, a task's screenshots one by one", async () => {
  const root = join(scratch, "caps")
  // Recordings, 300 bytes each across two files, the oldest first: the cap of 700 keeps the newest two.
  for (const [name, minutesAgo] of [["recording-a", 300], ["recording-b", 200], ["recording-c", 100], ["recording-d", 30]] as const) {
    await file(join(root, "recordings", name, "frames.bin"), 200, minutesAgo + 1)
    await file(join(root, "recordings", name, "recording.mp4"), 100, minutesAgo)
    await aged(join(root, "recordings", name), minutesAgo)
  }
  // One task's screenshots, 100 bytes each, an hour apart: the cap of 250 keeps the newest two of five.
  for (let n = 0; n < 5; n++) await file(join(root, "artifacts", "task-1", "control", `shot-${n}.png`), 100, 300 - n * 60)
  // Media as `TurnMedia` keeps it: copies of 400 bytes at its top, each page in a folder of its own under `pages`, the
  // database never counted or removed.
  await file(join(root, "media", "aaa.png"), 400, 500)
  await file(join(root, "media", "pages", "bbb-1", "index.html"), 300, 400)
  await file(join(root, "media", "pages", "bbb-1", "style.css"), 100, 400)
  await aged(join(root, "media", "pages", "bbb-1"), 400)
  await file(join(root, "media", "pages", "ddd-2", "index.html"), 300, 10)
  await aged(join(root, "media", "pages", "ddd-2"), 10)
  await file(join(root, "media", "ccc.mp4"), 400, 20)
  await file(join(root, "media", "media.db"), 5_000, 600)
  await file(join(root, "media", "media.db-wal"), 1_000, 600)

  const cap = new MachineArtifacts({ places: places(root, { recordings: 700, artifacts: 250, media: 1_100 }), graceMs: GRACE, now: () => NOW })
  const state = await cap.sweep()

  assert.deepEqual(state.kinds.map(({ kind, bytes, items, removed, removedBytes }) => ({ kind, bytes, items, removed, removedBytes })), [
    { kind: "recordings", bytes: 600, items: 2, removed: 2, removedBytes: 600 },
    { kind: "artifacts", bytes: 200, items: 2, removed: 3, removedBytes: 300 },
    { kind: "media", bytes: 1_100, items: 3, removed: 1, removedBytes: 400 },
  ])
  assert.equal(existsSync(join(root, "recordings", "recording-a")), false, "the oldest recording went whole")
  assert.equal(existsSync(join(root, "recordings", "recording-b")), false)
  assert.equal(existsSync(join(root, "recordings", "recording-c", "frames.bin")), true, "the newer ones stayed whole")
  assert.equal(existsSync(join(root, "artifacts", "task-1", "control", "shot-2.png")), false, "the task lost its oldest screenshots")
  assert.equal(existsSync(join(root, "artifacts", "task-1", "control", "shot-3.png")), true, "and kept its newest")
  assert.equal(existsSync(join(root, "media", "aaa.png")), false, "the oldest copy went")
  assert.equal(existsSync(join(root, "media", "pages", "bbb-1", "style.css")), true, "a page's folder is one thing, kept whole")
  assert.equal(existsSync(join(root, "media", "pages", "ddd-2", "index.html")), true, "and each page is one, not all of them together")
  assert.equal(existsSync(join(root, "media", "media.db")), true, "the media's database is never touched")
  assert.equal(existsSync(join(root, "media", "media.db-wal")), true)
  assert.deepEqual(state.lastRemoved, { at: state.at, kind: "media", path: "aaa.png", bytes: 400, ageMs: 500 * MINUTE })
  assert.deepEqual(cap.state(), state, "the last sweep is the state shown")

  // Under its cap now: a second sweep removes nothing more, and keeps the counts of what went.
  const again = await cap.sweep()
  assert.deepEqual(again.kinds.map(({ kind, removed }) => ({ kind, removed })), [{ kind: "recordings", removed: 2 }, { kind: "artifacts", removed: 3 }, { kind: "media", removed: 1 }])
  assert.equal(again.lastRemoved?.path, "aaa.png", "the last removal is still the one shown")
})

test("nothing changed within the grace goes, however far over its cap", async () => {
  const root = join(scratch, "grace")
  await file(join(root, "recordings", "recording-old", "recording.mp4"), 500, 60)
  await aged(join(root, "recordings", "recording-old"), 60)
  // A recording still being written: its folder old, its newest frame a minute ago.
  await file(join(root, "recordings", "recording-live", "frames.bin"), 900, 120)
  await file(join(root, "recordings", "recording-live", "frame-new.bin"), 100, 1)
  await aged(join(root, "recordings", "recording-live"), 120)
  const cap = new MachineArtifacts({ places: places(root, { recordings: 100, artifacts: 100, media: 100 }), graceMs: GRACE, now: () => NOW })
  const state = await cap.sweep()
  assert.equal(existsSync(join(root, "recordings", "recording-old")), false, "the one past its grace went")
  assert.equal(existsSync(join(root, "recordings", "recording-live", "frames.bin")), true, "the one being written stayed, its old frames too")
  assert.deepEqual(state.kinds[0], { kind: "recordings", bytes: 1_000, items: 1, capBytes: 100, removed: 1, removedBytes: 500 })
  assert.equal(state.failing, undefined)
})

test("places that aren't there yet count nothing; one inside another is counted once; a link is never followed", async () => {
  const root = join(scratch, "inner")
  const outside = join(scratch, "outside")
  await file(join(outside, "precious.bin"), 1_000, 600)
  // As with `MAKO_CONTROL_ARTIFACTS`: recordings inside the artifacts' folder.
  const artifacts = join(root, "artifacts")
  const recordings = join(artifacts, "recordings")
  await file(join(recordings, "recording-a", "recording.mp4"), 500, 600)
  await file(join(artifacts, "control", "shot.png"), 50, 600)
  await symlink(outside, join(artifacts, "control", "elsewhere"))
  const old = new Date(NOW - 600 * MINUTE)
  await lutimes(join(artifacts, "control", "elsewhere"), old, old)
  await aged(join(recordings, "recording-a"), 600)
  const cap = new MachineArtifacts({
    places: [
      { kind: "recordings", root: recordings, capBytes: 10_000, entry: () => "one" },
      { kind: "artifacts", root: artifacts, capBytes: 10, entry: () => "files" },
      { kind: "media", root: join(root, "never-made"), capBytes: 10, entry: () => "one" },
    ],
    graceMs: GRACE,
    now: () => NOW,
  })
  const state = await cap.sweep()
  assert.equal(existsSync(join(recordings, "recording-a", "recording.mp4")), true, "the recordings weren't taken for artifacts")
  assert.equal(existsSync(join(outside, "precious.bin")), true, "what a link points at is never removed")
  assert.equal(existsSync(join(artifacts, "control", "shot.png")), false)
  assert.deepEqual(state.kinds.map(({ kind, bytes, items }) => ({ kind, items, zero: bytes === 0 })), [
    { kind: "recordings", items: 1, zero: false },
    { kind: "artifacts", items: 0, zero: true },
    { kind: "media", items: 0, zero: true },
  ])
  assert.equal(state.failing, undefined)
})

test("a media copy the cap removed is decided again from its original: kept again while it's unchanged, else dropped", async () => {
  const root = join(scratch, "turn-media")
  const store = join(root, "media")
  const media = new TurnMedia(store)
  try {
    const shot = join(root, "shots", "home.png")
    const gone = join(root, "shots", "gone.png")
    await mkdir(dirname(shot), { recursive: true })
    await writeFile(shot, Buffer.alloc(300, 1))
    await writeFile(gone, Buffer.alloc(300, 2))
    const madeAt = Date.now()
    const call = (callId: string, path: string) => ({ callId, path, evidence: "wrote" as const, startedAt: madeAt - 60_000, endedAt: madeAt + 1_000 })
    const [first, second] = await media.confirm([call("c1", shot), call("c2", gone)])
    assert.ok(first?.kind === "kept" && second?.kind === "kept")
    assert.notEqual(first.media.file, shot, "kept as a copy in the media's folder")
    // The copies, old enough to go, removed by the machine's cap down to nothing; the database stays.
    const cap = new MachineArtifacts({ places: machineArtifactPlaces({ recordings: join(root, "r"), artifacts: join(root, "a"), media: store }).map((place) => ({ ...place, capBytes: 0 })), graceMs: 0, now: () => Date.now() + 1 })
    assert.equal((await cap.sweep()).kinds.find((kind) => kind.kind === "media")?.removed, 2)
    assert.equal(existsSync(first.media.file), false)
    assert.equal(existsSync(join(store, "media.db")), true)
    await rm(gone)
    const [again, dropped] = await media.confirm([call("c1", shot), call("c2", gone)])
    assert.ok(again?.kind === "kept", "its original unchanged: kept again")
    assert.equal(existsSync(again.media.file), true, "with a copy that's there")
    assert.deepEqual(dropped, { kind: "dropped", reason: `No file at ${gone}` }, "its original gone too: dropped, as on a fresh machine")
  } finally {
    media.close()
  }
})

test("the places are the ones control writes to, and the sweep is one of the host's jobs", async () => {
  const saved = process.env.MAKO_CONTROL_ARTIFACTS
  delete process.env.MAKO_CONTROL_ARTIFACTS
  try {
    assert.equal(controlRecordingsRoot(), join(tmpdir(), "mako-recordings"))
    assert.equal(dirname(dirname(controlArtifactsDirectory("control", "task-1"))), controlArtifactsRoot(), "a task's artifacts are in a folder of its own under the root")
    process.env.MAKO_CONTROL_ARTIFACTS = join(scratch, "one-task")
    assert.equal(controlArtifactsDirectory("control"), join(scratch, "one-task", "control"))
    assert.equal(controlRecordingsRoot(), join(scratch, "one-task", "recordings"))
  } finally {
    if (saved === undefined) delete process.env.MAKO_CONTROL_ARTIFACTS
    else process.env.MAKO_CONTROL_ARTIFACTS = saved
  }
  const jobs = new HostJobs()
  const stop = new MachineArtifacts({ places: [] }).schedule(jobs)
  assert.ok(jobs.list().some((job) => job.name === ARTIFACTS_JOB))
  stop()
  assert.ok(!jobs.list().some((job) => job.name === ARTIFACTS_JOB))
  jobs.stop()
})
