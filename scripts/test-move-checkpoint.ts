import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { Git } from "@mako/git"
import { applyMoveCheckpoint, captureMoveCheckpoint, verifyMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"

/**
 * A checkout carried to another computer (`move-checkpoint.ts`), on real repositories: a Mac's checkout with commits
 * the remote lacks, staged and unstaged edits to one file, a staged and an unstaged deletion, a rename, an untracked
 * file, an executable bit, a symlink and a binary file, and an ignored file that must stay behind. A partial clone of
 * the remote takes the checkpoint and reads back the same: HEAD, the branch, the index, every file and its mode.
 * Capture writes nothing into the checkout's repository and makes the same bundle twice; a detached HEAD, a clone
 * missing the base, conflicts and a bundle past the limit each say so.
 */
const root = await mkdtemp(join(tmpdir(), "mako-move-checkpoint-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

/** Every file Git doesn't ignore, with its mode and bytes, and the index and HEAD, as one comparable value. */
type Reading = { files: Record<string, string>; head: string; branch: string; index: string; status: string }
async function reading(checkout: string): Promise<Reading> {
  const files: Record<string, string> = {}
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const name = relative(checkout, path)
      if (name === ".git") continue
      if (entry.isDirectory()) await walk(path)
      else if (entry.isSymbolicLink()) files[name] = `link:${await readlink(path)}`
      else files[name] = `${((await stat(path)).mode & 0o111) ? "x" : "-"}:${(await readFile(path)).toString("base64")}`
    }
  }
  await walk(checkout)
  for (const name of sh(checkout, "ls-files", "--others", "--ignored", "--exclude-standard").split("\n").filter(Boolean)) delete files[name]
  return {
    files,
    head: sh(checkout, "rev-parse", "HEAD"),
    branch: sh(checkout, "rev-parse", "--abbrev-ref", "HEAD"),
    index: sh(checkout, "ls-files", "--stage"),
    status: sh(checkout, "status", "--porcelain=v1", "--untracked-files=all"),
  }
}

try {
  // The remote, and the Mac's checkout of it.
  const remote = join(root, "remote.git")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(remote, "config", "uploadpack.allowFilter", "true")
  const mac = join(root, "mac")
  sh(root, "clone", "--quiet", remote, mac)
  await writeFile(join(mac, ".gitignore"), "ignored.env\nbuild/\n")
  await writeFile(join(mac, "a.txt"), "one\ntwo\nthree\n")
  await writeFile(join(mac, "gone-staged.txt"), "x\n")
  await writeFile(join(mac, "gone-unstaged.txt"), "y\n")
  await writeFile(join(mac, "renamed-from.txt"), "moving\n")
  await writeFile(join(mac, "run.sh"), "#!/bin/sh\necho hi\n")
  sh(mac, "add", ".")
  sh(mac, "commit", "--quiet", "-m", "base")
  sh(mac, "push", "--quiet", "origin", "main")

  // The Thread's branch: two commits the remote doesn't have, then work in progress of every kind.
  sh(mac, "checkout", "--quiet", "-b", "mako/thread")
  await writeFile(join(mac, "b.txt"), "local commit\n")
  sh(mac, "add", "b.txt")
  sh(mac, "commit", "--quiet", "-m", "local one")
  await writeFile(join(mac, "b.txt"), "local commit, again\n")
  sh(mac, "commit", "--quiet", "-am", "local two")
  await writeFile(join(mac, "a.txt"), "one\nTWO staged\nthree\n")
  sh(mac, "add", "a.txt")
  await writeFile(join(mac, "a.txt"), "one\nTWO staged\nthree, then edited\n")
  sh(mac, "rm", "--quiet", "gone-staged.txt")
  await rm(join(mac, "gone-unstaged.txt"))
  sh(mac, "mv", "renamed-from.txt", "renamed-to.txt")
  await chmod(join(mac, "run.sh"), 0o644)
  await symlink("a.txt", join(mac, "link-to-a"))
  await writeFile(join(mac, "image.bin"), Buffer.from([0, 255, 1, 254, 0, 0, 7]))
  await mkdir(join(mac, "new-dir"))
  await writeFile(join(mac, "new-dir", "untracked.txt"), "untracked\n")
  await writeFile(join(mac, "ignored.env"), "SECRET=never-carried\n")
  await mkdir(join(mac, "build"))
  await writeFile(join(mac, "build", "out.o"), "build output\n")

  const objectsBefore = sh(mac, "count-objects", "-v")
  const refsBefore = sh(mac, "for-each-ref")
  // Read first: its `git status` may refresh the index's stat data (files changed within the second it was written),
  // which is Git's write, not capture's.
  const macReading = await reading(mac)
  const indexBefore = await readFile(join(mac, ".git", "index"))

  const out = await mkdtemp(join(root, "out-"))
  const { checkpoint, file } = await captureMoveCheckpoint(git, mac, out)
  assert.equal(checkpoint.branch, "mako/thread")
  assert.equal(sh(mac, "count-objects", "-v"), objectsBefore, "capture adds no objects to the checkout's repository")
  assert.equal(sh(mac, "for-each-ref"), refsBefore, "nor refs")
  assert.deepEqual(await readFile(join(mac, ".git", "index")), indexBefore, "nor touches its index")
  assert.deepEqual(await reading(mac), macReading, "nor its files")
  assert.ok(!sh(root, "bundle", "list-heads", file).includes("main"), "only Mako's three refs")
  const bundleText = await readFile(file, "latin1")
  assert.ok(!bundleText.includes("never-carried"), "an ignored file stays behind")

  const again = await mkdtemp(join(root, "out-"))
  assert.equal((await captureMoveCheckpoint(git, mac, again)).checkpoint.sha256, checkpoint.sha256, "the same checkout, the same bundle")

  // The machine: a partial clone of the remote, then the checkpoint.
  const machine = join(root, "machine", "Users", "someone", "project")
  await mkdir(join(machine, ".."), { recursive: true })
  sh(root, "clone", "--quiet", "--filter=blob:none", `file://${remote}`, machine)
  await applyMoveCheckpoint(git, machine, file, checkpoint)
  const arrived = await reading(machine)
  assert.deepEqual(arrived, macReading, "the clone reads as the Mac's checkout")
  assert.equal(sh(machine, "for-each-ref", "refs/mako"), "", "no Mako refs left behind")
  await verifyMoveCheckpoint(git, machine, checkpoint)

  // Something changes after arrival: it no longer reads as the checkpoint.
  await writeFile(join(machine, "a.txt"), "changed on the machine\n")
  await assert.rejects(verifyMoveCheckpoint(git, machine, checkpoint), { name: "MoveCheckpointError", kind: "mismatch", message: /the files/ })

  // The way back: the machine goes on (a commit, a staged file, an untracked file made and one removed) on top of a
  // remote that moved meanwhile, and its checkout replaces the Mac's own, which is kept first and can be put back.
  {
    const other = join(root, "other")
    sh(root, "clone", "--quiet", remote, other)
    await writeFile(join(other, "upstream.txt"), "pushed by someone else\n")
    sh(other, "add", "upstream.txt")
    sh(other, "commit", "--quiet", "-m", "upstream")
    sh(other, "push", "--quiet", "origin", "main")
    sh(machine, "fetch", "--quiet", "origin")
    // Its branch takes the remote's new commit, which the Mac has never fetched.
    sh(machine, "stash", "--quiet", "--include-untracked")
    sh(machine, "merge", "--quiet", "--no-edit", "origin/main")
    sh(machine, "stash", "pop", "--quiet", "--index")
    await writeFile(join(machine, "cloud.txt"), "committed in the cloud\n")
    sh(machine, "add", "cloud.txt")
    sh(machine, "commit", "--quiet", "-m", "cloud commit")
    await writeFile(join(machine, "staged-in-cloud.txt"), "staged\n")
    sh(machine, "add", "staged-in-cloud.txt")
    await rm(join(machine, "new-dir"), { recursive: true })
    await writeFile(join(machine, "cloud-untracked.txt"), "left untracked\n")
    const cloudReading = await reading(machine)
    const backOut = await mkdtemp(join(root, "out-"))
    const back = await captureMoveCheckpoint(git, machine, backOut)

    const keptOut = await mkdtemp(join(root, "out-"))
    const kept = await captureMoveCheckpoint(git, mac, keptOut)
    // A plain apply refuses the Mac's checkout: its base is newer than anything the Mac has fetched.
    await assert.rejects(applyMoveCheckpoint(git, mac, back.file, back.checkpoint), { kind: "missing-base" })
    await applyMoveCheckpoint(git, mac, back.file, back.checkpoint, { replace: true })
    assert.deepEqual(await reading(mac), cloudReading, "the Mac's worktree reads as the machine's: the commit, what's staged, the untracked file made and the one removed")
    assert.equal(await readFile(join(mac, "ignored.env"), "utf8"), "SECRET=never-carried\n", "ignored files on the Mac stay")
    assert.equal(sh(mac, "for-each-ref", "refs/mako"), "", "no Mako refs left behind")
    // And put back as it was, from the copy kept first.
    await applyMoveCheckpoint(git, mac, kept.file, kept.checkpoint, { replace: true })
    assert.deepEqual(await reading(mac), macReading, "the Mac's own checkout, exactly as kept")
  }

  // A detached HEAD arrives detached.
  const detached = join(root, "detached")
  sh(root, "clone", "--quiet", remote, detached)
  sh(detached, "checkout", "--quiet", "--detach", "HEAD")
  await writeFile(join(detached, "a.txt"), "detached edit\n")
  const detachedOut = await mkdtemp(join(root, "out-"))
  const detachedCheckpoint = await captureMoveCheckpoint(git, detached, detachedOut)
  assert.equal(detachedCheckpoint.checkpoint.branch, undefined)
  const detachedMachine = join(root, "detached-machine")
  sh(root, "clone", "--quiet", remote, detachedMachine)
  await applyMoveCheckpoint(git, detachedMachine, detachedCheckpoint.file, detachedCheckpoint.checkpoint)
  assert.deepEqual(await reading(detachedMachine), await reading(detached))

  // A base the remote lost: refused before the clone changes.
  sh(mac, "stash", "push", "--quiet", "--include-untracked")
  sh(mac, "checkout", "--quiet", "main")
  await writeFile(join(mac, "c.txt"), "pushed, then deleted from the remote\n")
  sh(mac, "add", "c.txt")
  sh(mac, "commit", "--quiet", "-m", "lost")
  sh(mac, "push", "--quiet", "origin", "main:lost")
  sh(remote, "update-ref", "-d", "refs/heads/lost")
  const lostOut = await mkdtemp(join(root, "out-"))
  const lost = await captureMoveCheckpoint(git, mac, lostOut)
  const lostMachine = join(root, "lost-machine")
  sh(root, "clone", "--quiet", `file://${remote}`, lostMachine)
  const lostBefore = await reading(lostMachine)
  await assert.rejects(applyMoveCheckpoint(git, lostMachine, lost.file, lost.checkpoint), { name: "MoveCheckpointError", kind: "missing-base" })
  assert.deepEqual(await reading(lostMachine), lostBefore, "nothing changed")

  // Bytes that aren't the ones named.
  await assert.rejects(applyMoveCheckpoint(git, lostMachine, file, { ...checkpoint, sha256: "0".repeat(64) }), { name: "MoveCheckpointError", kind: "mismatch" })

  // Conflicts, and a bundle past the limit.
  sh(mac, "checkout", "--quiet", "-b", "conflicted", "HEAD~1")
  await writeFile(join(mac, "c.txt"), "the other side\n")
  sh(mac, "add", "c.txt")
  sh(mac, "commit", "--quiet", "-m", "other side")
  try {
    sh(mac, "merge", "--quiet", "main")
  } catch {
    // The conflict is what this case is for.
  }
  await assert.rejects(captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "out-"))), { name: "MoveCheckpointError", kind: "conflicts" })
  sh(mac, "merge", "--abort")
  await assert.rejects(captureMoveCheckpoint(git, mac, await mkdtemp(join(root, "out-")), 64), { name: "MoveCheckpointError", kind: "too-large", message: /past the 0 MB/ })

  // A repository with no commits.
  const empty = join(root, "empty")
  sh(root, "init", "--quiet", empty)
  await assert.rejects(captureMoveCheckpoint(git, empty, await mkdtemp(join(root, "out-"))), { name: "MoveCheckpointError", kind: "no-commits" })
  console.log(`PASS: a checkout carried to a partial clone reads back the same (HEAD, branch, index, ${Object.keys(arrived.files).length} files with modes and links; ignored files stay behind) in a ${checkpoint.bytes}-byte bundle; capture writes nothing into the repository and repeats byte for byte; detached HEAD, a lost base, wrong bytes, conflicts, the limit and no commits each say so; the way back replaces a person's worktree over a remote that moved, and the copy kept first puts it back exactly`)
} finally {
  git.close()
  await rm(root, { recursive: true, force: true })
}
