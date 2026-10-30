import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { ThreadFileHistorySchema } from "@mako/protocol"
import { MOVE_OUTSIDE_FILE_BYTES } from "@mako/protocol/moves"
import {
  captureCarry, carriable, carriedPath, currentSha256, homeOf, openCarry, placeOutside, planOutsideReturn, readOutside, returnOutside,
} from "@mako/host/workspaces/move-carry"

/**
 * A move's carry (`move-carry.ts`) on real files: what may go (under the person's home or /tmp, never the Thread's own
 * folder, Mako's data, a Git folder or a secret), read with the per-file limit; captured into one bundle twice the
 * same; opened where it lands with its manifest, history and every file's bytes and kind; placed at the same paths;
 * and on the way back, each file put in place only when this side's copy is the one that left, the person's newer
 * one kept and the cloud's waiting beside, a removal taken only where nothing changed.
 */
const root = await mkdtemp(join(tmpdir(), "mako-move-carry-"))
const git = new Git()

try {
  // The rule: the person's home is the folder's first two parts, as a machine makes it.
  assert.equal(homeOf("/Users/ada/work/app"), "/Users/ada")
  assert.equal(homeOf("/home/ada/work/app"), "/home/ada")
  assert.equal(carriedPath("/private/tmp/x"), "/tmp/x")
  assert.equal(carriable("/Users/ada/notes.md", "/Users/ada/work/app"), undefined)
  assert.equal(carriable("/private/tmp/build.sh", "/Users/ada/work/app"), undefined)
  assert.equal(carriable("/Users/ada/work/app/src/a.ts", "/Users/ada/work/app"), "folder")
  assert.equal(carriable("/Users/ada/.mako/x", "/Users/ada/work/app"), "elsewhere")
  assert.equal(carriable("/Users/ada/other/.git/config", "/Users/ada/work/app"), "elsewhere")
  assert.equal(carriable("/Users/bob/x", "/Users/ada/work/app"), "elsewhere")
  assert.equal(carriable("/var/folders/x/T/y", "/Users/ada/work/app"), "elsewhere")

  // The carry itself, on files under /tmp: the one place the rule takes that a test may write.
  const tmp = await mkdtemp("/tmp/mako-move-carry-")
  try {
    const thread = "/Users/ada/work/app"
    const t = (name: string) => join(tmp, name)
    await writeFile(t("state.json"), '{"n":1}\n')
    await writeFile(t("spec.md"), "# Spec\n")
    await writeFile(t("run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 })
    await symlink("run.sh", t("latest"))
    await writeFile(t("big.bin"), Buffer.alloc(MOVE_OUTSIDE_FILE_BYTES + 1))
    await writeFile(t("credentials"), "[default]\n")
    const outside = await readOutside([
      { path: t("state.json"), access: "read" },
      { path: t("state.json"), access: "write" },
      { path: t("spec.md"), access: "read" },
      { path: t("run.sh"), access: "write" },
      { path: t("latest"), access: "write" },
      { path: t("big.bin"), access: "write" },
      { path: t("credentials"), access: "write", secret: true },
      { path: t("never.txt"), access: "write" },
    ], thread)
    assert.deepEqual(outside.read.map((each) => [each.entry.path.replace(tmp, ""), each.entry.kind, each.entry.access]), [
      ["/latest", "symlink", "write"],
      ["/run.sh", "executable", "write"],
      ["/spec.md", "file", "read"],
      ["/state.json", "file", "write"],
    ])
    assert.deepEqual(outside.left.map((each) => [each.path.replace(tmp, ""), each.why]), [["/big.bin", "too-large"], ["/credentials", "secret"]])

    const history = ThreadFileHistorySchema.parse({ format: 1, thread: "00000000-0000-4000-8000-000000000001", from: "00000000-0000-4000-8000-000000000002", parts: [], choices: [] })
    const repositories = [{ path: thread, checkpoint: { version: 1 as const, sha256: "a".repeat(64), bytes: 10, head: "b".repeat(40), index: "c".repeat(40), work: "d".repeat(40) } }]
    const scratch = await mkdtemp(join(root, "scratch-"))
    const first = await captureCarry(git, { folder: thread, repositories, outside: outside.read, left: outside.left, history }, scratch)
    const again = await captureCarry(git, { folder: thread, repositories, outside: outside.read, left: outside.left, history }, await mkdtemp(join(root, "scratch-")))
    assert.equal(first.ref.sha256, again.ref.sha256, "the same carry makes the same bundle")
    assert.equal(first.ref.bytes, (await stat(first.file)).size)

    // Where it lands: everything read back, then placed at the same paths over a machine that has none of them.
    const opened = await openCarry(git, first.file, first.ref, await mkdtemp(join(root, "open-")))
    assert.deepEqual(opened.carry, first.carry)
    assert.deepEqual(opened.history, history)
    assert.equal((await opened.bytes(t("spec.md"))).toString(), "# Spec\n")
    await assert.rejects(openCarry(git, first.file, { ...first.ref, sha256: "0".repeat(64) }, root), /aren't the ones it names/)
    for (const name of ["state.json", "spec.md", "run.sh", "latest"]) await rm(t(name))
    const placed = await placeOutside(opened)
    assert.equal(placed.failed.length, 0, JSON.stringify(placed.failed))
    assert.equal(await readFile(t("state.json"), "utf8"), '{"n":1}\n')
    assert.equal((await stat(t("run.sh"))).mode & 0o777, 0o755)
    assert.equal(await readlink(t("latest")), "run.sh")
    assert.ok((await lstat(t("latest"))).isSymbolicLink())

    // The way back. What left, by path: the Mac's copies as they were.
    const leftHere = new Map(opened.carry.outside.map((entry) => [entry.path, entry.sha256]))
    // In the cloud: state.json changed, spec.md changed, a new notes.txt, run.sh removed.
    // Meanwhile on the Mac: the person changed spec.md too.
    await writeFile(t("state.json"), '{"n":2}\n')
    await writeFile(t("notes.txt"), "made in the cloud\n")
    const cloudSide = await readOutside([
      { path: t("state.json"), access: "write" },
      { path: t("spec.md"), access: "write" },
      { path: t("notes.txt"), access: "write" },
    ], thread)
    // spec.md's cloud copy: written now, then the Mac's own edit put in its place for the plan.
    await writeFile(t("spec.md"), "# Spec, from the cloud\n")
    const cloudSpec = await readOutside([{ path: t("spec.md"), access: "write" }], thread)
    const back = await captureCarry(git, {
      folder: thread, repositories,
      outside: [...cloudSide.read.filter((each) => !each.entry.path.endsWith("spec.md")), ...cloudSpec.read],
      left: [], gone: [t("run.sh")],
    }, await mkdtemp(join(root, "scratch-")))
    // The Mac as it stands when the Thread comes back: state.json as it left, spec.md changed by the person, run.sh as it left, no notes.txt.
    await writeFile(t("state.json"), '{"n":1}\n')
    await writeFile(t("spec.md"), "# Spec, the person's\n")
    await rm(t("notes.txt"))
    const home2 = await openCarry(git, back.file, back.ref, await mkdtemp(join(root, "open-")))
    const plan = await planOutsideReturn(home2.carry, leftHere)
    assert.deepEqual(Object.fromEntries(plan.map((step) => [step.path.replace(tmp, ""), step.action])), {
      "/state.json": "place",
      "/spec.md": "wait",
      // Never sent from here: the cloud has no word over that path, whatever it says.
      "/notes.txt": "unsent",
      "/run.sh": "remove",
    })
    const waiting = join(root, "waiting")
    const done = await returnOutside(home2, plan, waiting)
    assert.equal(await readFile(t("state.json"), "utf8"), '{"n":2}\n')
    assert.equal(await currentSha256(t("notes.txt")), undefined, "a file this side never sent isn't put in place")
    assert.equal(await readFile(join(waiting, t("notes.txt")), "utf8"), "made in the cloud\n", "it waits beside")
    assert.equal(await currentSha256(t("run.sh")), undefined)
    assert.equal(await readFile(t("spec.md"), "utf8"), "# Spec, the person's\n", "the person's newer file is never written over")
    assert.equal(await readFile(join(waiting, t("spec.md")), "utf8"), "# Spec, from the cloud\n", "the cloud's waits beside")
    assert.deepEqual([done.waiting, done.unsent].map((paths) => paths.map((path) => path.replace(tmp, ""))), [["/spec.md"], ["/notes.txt"]])
    assert.deepEqual(done.failed, [])

    // A forged carry: a launch agent and a removal at paths this side never sent, beside one it did. Nothing it never
    // sent is written in place or removed.
    const agents = t("Library/LaunchAgents")
    await mkdir(agents, { recursive: true })
    await writeFile(t("keep.txt"), "the person's\n")
    const forged = await captureCarry(git, {
      folder: thread, repositories,
      outside: [{ entry: { path: join(agents, "x.plist"), kind: "file", sha256: "0".repeat(64), bytes: 4, access: "write" }, bytes: Buffer.from("evil") }],
      left: [], gone: [t("keep.txt")],
    }, await mkdtemp(join(root, "scratch-")))
    const forgedOpened = await openCarry(git, forged.file, forged.ref, await mkdtemp(join(root, "open-")))
    const forgedPlan = await planOutsideReturn(forgedOpened.carry, leftHere)
    assert.deepEqual(forgedPlan.map((step) => [step.path.replace(tmp, ""), step.action]), [["/Library/LaunchAgents/x.plist", "unsent"]])
    const forgedDone = await returnOutside(forgedOpened, forgedPlan, waiting)
    assert.equal(await currentSha256(join(agents, "x.plist")), undefined, "never written where the cloud named it")
    assert.equal(await readFile(t("keep.txt"), "utf8"), "the person's\n", "never removed")
    assert.deepEqual(forgedDone.unsent.map((path) => path.replace(tmp, "")), ["/Library/LaunchAgents/x.plist"])

    // Kept apart stays apart: a link one way back left beneath the waiting folder can't lead a later one's file out of it.
    const carried = async (outside: Parameters<typeof captureCarry>[1]["outside"]) => {
      const captured = await captureCarry(git, { folder: thread, repositories, outside, left: [] }, await mkdtemp(join(root, "scratch-")))
      return openCarry(git, captured.file, captured.ref, await mkdtemp(join(root, "open-")))
    }
    const door = await carried([{ entry: { path: t("door"), kind: "symlink", sha256: "1".repeat(64), bytes: agents.length, access: "write" }, bytes: Buffer.from(agents) }])
    assert.deepEqual((await returnOutside(door, await planOutsideReturn(door.carry, leftHere), waiting)).unsent, [t("door")])
    const through = await carried([{ entry: { path: t("door/y.plist"), kind: "file", sha256: "2".repeat(64), bytes: 4, access: "write" }, bytes: Buffer.from("evil") }])
    const escapeDone = await returnOutside(through, await planOutsideReturn(through.carry, leftHere), waiting)
    assert.equal(await currentSha256(join(agents, "y.plist")), undefined, "nothing written through the link")
    assert.deepEqual(escapeDone.failed.map((each) => [each.path.replace(tmp, ""), each.why]), [["/door/y.plist", "a link in its path leads outside the folder it's kept in"]])

    // One file that can't be written doesn't stop the rest, and says why: each file on its own.
    await writeFile(t("state.json"), '{"n":1}\n')
    await writeFile(t("blocked"), "a file where a folder would be\n")
    const blocked = new Map([...leftHere, [t("blocked/inner.txt"), "3".repeat(64)]])
    const partial = await captureCarry(git, {
      folder: thread, repositories,
      outside: [
        { entry: { path: t("blocked/inner.txt"), kind: "file", sha256: "4".repeat(64), bytes: 5, access: "write" }, bytes: Buffer.from("inner") },
        ...cloudSide.read.filter((each) => each.entry.path.endsWith("state.json")),
      ],
      left: [],
    }, await mkdtemp(join(root, "scratch-")))
    const partialOpened = await openCarry(git, partial.file, partial.ref, await mkdtemp(join(root, "open-")))
    // `blocked/inner.txt` reads as not-a-file-here (its folder is a file), which isn't what left: it waits, and its
    // folder in the waiting place is made; force a place by saying nothing was there when it left.
    const partialPlan = (await planOutsideReturn(partialOpened.carry, blocked)).map((step) => (step.path.endsWith("inner.txt") ? { ...step, action: "place" as const } : step))
    const partialDone = await returnOutside(partialOpened, partialPlan, waiting)
    assert.deepEqual(partialDone.failed.map((each) => each.path.replace(tmp, "")), ["/blocked/inner.txt"])
    assert.equal(partialDone.failed[0]?.why, "a file is where its folder would be", "said in words, not a code")
    assert.equal(await readFile(t("state.json"), "utf8"), '{"n":2}\n', "the rest still came")
    assert.deepEqual(partialDone.placed.map((path) => path.replace(tmp, "")), ["/state.json"])
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
  console.log("move carry: what may go, captured the same twice, opened and placed, and the way back keeps the person's newer files, writes only what this side sent, keeps the rest apart through no link, and writes each file on its own: ok")
} finally {
  await rm(root, { recursive: true, force: true })
}
