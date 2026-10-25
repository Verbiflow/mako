import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { copyGitIndex } from "@mako/host/workspaces/index-copy"
import { applyMoveCheckpoint, captureMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"

/**
 * An edit made in the second a checkout's index was written, at the same size, is one Git sees only by its racy
 * check: the entry is no older than the index file, so Git reads the file again. A copy of the index made a second
 * later took that away, and the edit read as unchanged. A move's checkpoint carried the old file (seen as 4 of 40
 * runs of `test-move-checkpoint.ts` under load; every time when made so, below), and a rewind's snapshot and a move's
 * backup copy the index the same way. `copyGitIndex` keeps the original's time.
 */
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()
const second = (ms: number) => Math.floor(ms / 1000)
const tick = () => new Promise((resolve) => setTimeout(resolve, 10))
const root = await mkdtemp(join(tmpdir(), "mako-git-index-copy-"))
const git = new Git()
try {
  const remote = join(root, "remote.git")
  const seed = join(root, "seed")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, seed)
  await writeFile(join(seed, "a.txt"), "one\ntwo\nthree\n")
  sh(seed, "add", ".")
  sh(seed, "commit", "--quiet", "-m", "base")
  sh(seed, "push", "--quiet", "origin", "main")

  const edited = "edited, as lo"
  assert.equal(`${edited}\n`.length, "one\ntwo\nthree\n".length, "the edit is the same size")

  /** A fresh clone with `a.txt` edited in the second its index was written, the same size; returned once that second has passed. */
  let made = 0
  const editedAsCloned = async (): Promise<string> => {
    for (;;) {
      // Early in a second, so the clone and the edit fit in it.
      while (Date.now() % 1000 > 500) await tick()
      const checkout = join(root, `clone-${made++}`)
      sh(root, "clone", "--quiet", remote, checkout)
      await writeFile(join(checkout, "a.txt"), `${edited}\n`)
      const [file, index] = await Promise.all([stat(join(checkout, "a.txt")), stat(join(checkout, ".git", "index"))])
      if (second(file.mtimeMs) === second(index.mtimeMs) && second(file.ctimeMs) === second(index.mtimeMs)) {
        while (second(Date.now()) <= second(index.mtimeMs)) await tick()
        return checkout
      }
      await rm(checkout, { recursive: true, force: true })
    }
  }

  /** What `git add --all` stages for `a.txt` through a copy of the index made by `copy`. */
  const staged = async (copy: (from: string, to: string) => Promise<void>) => {
    const checkout = await editedAsCloned()
    const index = join(root, `index-${made}`)
    await copy(join(checkout, ".git", "index"), index)
    execFileSync("git", ["-c", "core.fsmonitor=false", "add", "--all", "--", "."], { cwd: checkout, env: { ...process.env, GIT_INDEX_FILE: index } })
    return execFileSync("git", ["show", ":a.txt"], { cwd: checkout, env: { ...process.env, GIT_INDEX_FILE: index }, encoding: "utf8" })
  }
  // Shown first, so the test proves its own setup: a plain copy misses the edit.
  assert.equal(await staged(copyFile), "one\ntwo\nthree\n", "a plain copy of the index reads the same-second edit as unchanged")
  assert.equal(await staged(copyGitIndex), `${edited}\n`, "a copy that keeps the index's time sees it")

  // A move's checkpoint carries it.
  const checkout = await editedAsCloned()
  const out = await mkdtemp(join(root, "out-"))
  const { checkpoint, file } = await captureMoveCheckpoint(git, checkout, out)
  const machine = join(root, "machine")
  sh(root, "clone", "--quiet", remote, machine)
  await applyMoveCheckpoint(git, machine, file, checkpoint)
  assert.equal(await readFile(join(machine, "a.txt"), "utf8"), `${edited}\n`, "the checkpoint carries an edit made in the second the index was written")
  console.log("PASS: a copy of a Git index keeps its time, so an edit made in the second the index was written, at the same size, is seen: by a move's checkpoint, and by every capture that copies the index")
} finally {
  git.close()
  await rm(root, { recursive: true, force: true })
}
