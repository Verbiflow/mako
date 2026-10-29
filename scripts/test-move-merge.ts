import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { applyMoveCheckpoint, captureMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"
import { mergeReturned, unchangedSince } from "@mako/host/workspaces/move-merge"

/**
 * A Thread's worktree coming back from the cloud after the person changed it here meanwhile (`move-merge.ts`), on real
 * repositories. The Mac sends its worktree; the machine edits, stages and commits; the person, here, edits a file the
 * cloud didn't touch, one it did, and adds one. Laid back: the person's untouched-by-the-cloud edit and new file stay,
 * the cloud's work is all there with its commit and staged file, and the one file both changed holds Git's markers
 * naming both sides. A worktree nobody touched reads as unchanged, so the plain lay-over stands. Commits the person
 * made here are kept on a branch of their own.
 */
const root = await mkdtemp(join(tmpdir(), "mako-move-merge-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
const read = (path: string) => readFile(path, "utf8")

try {
  const remote = join(root, "remote.git")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(remote, "config", "uploadpack.allowFilter", "true")
  const mac = join(root, "mac")
  sh(root, "clone", "--quiet", remote, mac)
  await writeFile(join(mac, "shared.txt"), "one\ntwo\nthree\n")
  await writeFile(join(mac, "mine.txt"), "mine\n")
  await writeFile(join(mac, "theirs.txt"), "theirs\n")
  sh(mac, "add", ".")
  sh(mac, "commit", "--quiet", "-m", "base")
  sh(mac, "push", "--quiet", "origin", "main")
  sh(mac, "checkout", "--quiet", "-b", "mako/thread")
  await writeFile(join(mac, "wip.txt"), "work in progress\n")

  // The move: the Mac's worktree as it left.
  const sent = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "sent-")))
  const untouched = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "kept-")))
  assert.ok(unchangedSince(sent.checkpoint, untouched.checkpoint), "a worktree nobody touched reads as what was sent")

  // The machine takes it, then works: a commit, a staged file, an edit to shared.txt and to theirs.txt.
  const machine = join(root, "machine")
  sh(root, "clone", "--quiet", "--filter=blob:none", `file://${remote}`, machine)
  await applyMoveCheckpoint(git, machine, sent.file, sent.checkpoint)
  await writeFile(join(machine, "committed.txt"), "the cloud's commit\n")
  sh(machine, "add", "committed.txt")
  sh(machine, "commit", "--quiet", "-m", "in the cloud")
  await writeFile(join(machine, "staged.txt"), "staged in the cloud\n")
  sh(machine, "add", "staged.txt")
  await writeFile(join(machine, "shared.txt"), "one\ntwo, the cloud's\nthree\n")
  await writeFile(join(machine, "theirs.txt"), "theirs, changed in the cloud\n")
  const departed = await captureMoveCheckpoint(git, machine, await mkdtemp(join(root, "departed-")))

  // Meanwhile, here: the person edits shared.txt the other way, mine.txt, and adds a note.
  await writeFile(join(mac, "shared.txt"), "one\ntwo, the person's\nthree\n")
  await writeFile(join(mac, "mine.txt"), "mine, changed on the Mac\n")
  await mkdir(join(mac, "notes"))
  await writeFile(join(mac, "notes", "todo.md"), "- a note\n")
  const kept = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "kept-")))
  assert.ok(!unchangedSince(sent.checkpoint, kept.checkpoint), "the person's edits read as a change")

  // The way back: the machine's laid over it, then merged with what the person did.
  await applyMoveCheckpoint(git, mac, departed.file, departed.checkpoint, { replace: true })
  const result = await mergeReturned(git, mac, { base: sent.checkpoint, mine: kept.checkpoint, theirs: departed.checkpoint, bundles: { base: sent.file, mine: kept.file } })
  assert.deepEqual(result.conflicts, ["shared.txt"])
  assert.deepEqual([...result.merged].sort(), ["mine.txt", "notes/todo.md", "shared.txt"])
  assert.equal(result.mine, undefined, "no commits of the person's to keep")
  assert.equal(await read(join(mac, "mine.txt")), "mine, changed on the Mac\n", "the person's edit stays")
  assert.equal(await read(join(mac, "notes", "todo.md")), "- a note\n", "and the file they added")
  assert.equal(await read(join(mac, "theirs.txt")), "theirs, changed in the cloud\n", "the cloud's edit came")
  assert.equal(await read(join(mac, "committed.txt")), "the cloud's commit\n")
  assert.equal(await read(join(mac, "wip.txt")), "work in progress\n", "what went and nobody touched")
  const shared = await read(join(mac, "shared.txt"))
  assert.match(shared, /<<<<<<< mako\/merge\/this-mac\ntwo, the person's\n=======\ntwo, the cloud's\n>>>>>>> mako\/merge\/cloud\n/, shared)
  assert.equal(sh(mac, "rev-parse", "HEAD"), departed.checkpoint.head, "HEAD is the cloud's")
  assert.equal(sh(mac, "log", "-1", "--format=%s"), "in the cloud")
  assert.equal(sh(mac, "diff", "--cached", "--name-only"), "staged.txt", "its staged file is still staged")
  assert.equal(sh(mac, "for-each-ref", "refs/mako"), "", "no refs of the merge's left")

  // The person committed on the Thread's branch here meanwhile: kept on a branch of their own.
  const again = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "sent-")))
  await applyMoveCheckpoint(git, machine, again.file, again.checkpoint, { replace: true })
  await writeFile(join(machine, "later.txt"), "later in the cloud\n")
  const departedAgain = await captureMoveCheckpoint(git, machine, await mkdtemp(join(root, "departed-")))
  await writeFile(join(mac, "mine.txt"), "committed by the person\n")
  sh(mac, "commit", "--quiet", "-am", "the person's own")
  const personHead = sh(mac, "rev-parse", "HEAD")
  const keptAgain = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "kept-")))
  await applyMoveCheckpoint(git, mac, departedAgain.file, departedAgain.checkpoint, { replace: true })
  const second = await mergeReturned(git, mac, { base: again.checkpoint, mine: keptAgain.checkpoint, theirs: departedAgain.checkpoint, bundles: { base: again.file, mine: keptAgain.file } })
  assert.equal(second.mine, "mako/thread-mac")
  assert.equal(sh(mac, "rev-parse", "mako/thread-mac"), personHead, "the person's commit is kept")
  assert.equal(await read(join(mac, "later.txt")), "later in the cloud\n")
  assert.equal(await read(join(mac, "mine.txt")), "committed by the person\n", "and its change is in the files")

  // A later way back, the person having committed again on another line: the branch an earlier way back kept is never
  // moved off its commits; theirs go on a branch beside it, which the result names. One that only moves forward reuses it.
  const third = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "sent-")))
  await applyMoveCheckpoint(git, machine, third.file, third.checkpoint, { replace: true })
  await writeFile(join(machine, "latest.txt"), "latest in the cloud\n")
  const departedThird = await captureMoveCheckpoint(git, machine, await mkdtemp(join(root, "departed-")))
  sh(mac, "reset", "--quiet", "--hard")
  await writeFile(join(mac, "mine.txt"), "committed by the person, another way\n")
  sh(mac, "commit", "--quiet", "-am", "the person's other commit")
  const otherHead = sh(mac, "rev-parse", "HEAD")
  const keptThird = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "kept-")))
  await applyMoveCheckpoint(git, mac, departedThird.file, departedThird.checkpoint, { replace: true })
  const thirdMerge = await mergeReturned(git, mac, { base: third.checkpoint, mine: keptThird.checkpoint, theirs: departedThird.checkpoint, bundles: { base: third.file, mine: keptThird.file } })
  assert.equal(thirdMerge.mine, "mako/thread-mac-2", "a branch of its own, named")
  assert.equal(sh(mac, "rev-parse", "mako/thread-mac"), personHead, "the earlier way back's commit is still kept")
  assert.equal(sh(mac, "rev-parse", "mako/thread-mac-2"), otherHead)

  // Again, the person going on from that commit: the branch that holds it moves forward to theirs.
  const fourth = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "sent-")))
  await applyMoveCheckpoint(git, machine, fourth.file, fourth.checkpoint, { replace: true })
  const departedFourth = await captureMoveCheckpoint(git, machine, await mkdtemp(join(root, "departed-")))
  sh(mac, "reset", "--quiet", "--hard", otherHead)
  await writeFile(join(mac, "mine.txt"), "committed by the person, on from there\n")
  sh(mac, "commit", "--quiet", "-am", "the person's next commit")
  const nextHead = sh(mac, "rev-parse", "HEAD")
  const keptFourth = await captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "kept-")))
  await applyMoveCheckpoint(git, mac, departedFourth.file, departedFourth.checkpoint, { replace: true })
  const fourthMerge = await mergeReturned(git, mac, { base: fourth.checkpoint, mine: keptFourth.checkpoint, theirs: departedFourth.checkpoint, bundles: { base: fourth.file, mine: keptFourth.file } })
  assert.equal(fourthMerge.mine, "mako/thread-mac-2")
  assert.deepEqual([sh(mac, "rev-parse", "mako/thread-mac"), sh(mac, "rev-parse", "mako/thread-mac-2")], [personHead, nextHead])
  console.log("move merge: the person's edits meanwhile kept, the cloud's laid over, a shared file's conflict marked, their commits kept, never over an earlier way back's: ok")
} finally {
  await rm(root, { recursive: true, force: true })
}
