import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { CloudFollow, type FollowState } from "@mako/host/conversations/cloud-follow"
import { encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { applyMoveCheckpoint, captureMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"

/**
 * The Mac's worktree of a Thread running in the cloud follows it (`CloudFollow`), on real repositories: at a cloud
 * turn's end the machine's checkout is laid into the worktree here, its commit, staged and unstaged work alike; a turn
 * that changed nothing lays nothing; once the person changes the worktree here, following stops before the cloud is
 * asked, nothing of theirs is written over, and the windows hear it once; the checkout last laid is what a way back
 * merges from. Nothing follows a Thread coming back, nor one no move took there.
 */
const root = mkdtempSync(join(tmpdir(), "mako-cloud-follow-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

try {
  const remote = join(root, "remote.git")
  const mac = join(root, "mac")
  const machine = join(root, "machine")
  sh(root, "init", "--bare", "--quiet", remote)
  sh(root, "clone", "--quiet", remote, mac)
  writeFileSync(join(mac, "a.txt"), "one\n")
  sh(mac, "add", ".")
  sh(mac, "commit", "--quiet", "-m", "base")
  sh(mac, "push", "--quiet", "origin", "main")
  sh(mac, "checkout", "--quiet", "-b", "mako/fix")
  writeFileSync(join(mac, "a.txt"), "one, as it left\n")

  // The move that took it there: its checkpoint, as the plan keeps it and the cloud has it.
  const bundles = new Map<string, string>()
  const sent = await captureMoveCheckpoint(git, mac, mkdtempSync(join(root, "sent-")))
  bundles.set(sent.checkpoint.sha256, sent.file)
  const cloudThread = "t-follow000000000"
  const moves = join(root, "moves")
  mkdirSync(moves)
  writeFileSync(join(moves, "m.json"), JSON.stringify({
    move: randomUUID(), thread: randomUUID(), asked: randomUUID(), cloudThread, folder: mac, repository: { url: "https://github.com/octocat/Hello-World" },
    sessions: [{ session: randomUUID(), conversationId: randomUUID(), harness: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }],
    phase: "started", checkpoint: sent.checkpoint, began: 1, timings: {},
  }))
  sh(root, "clone", "--quiet", remote, machine)
  await applyMoveCheckpoint(git, machine, sent.file, sent.checkpoint)

  let returning = false
  let asked = 0
  const stopped: FollowState[] = []
  const follow = new CloudFollow({
    folder: join(root, "follow"),
    moves,
    git,
    readCheckpoint: async (_cloudThread, sha256, file) => copyFileSync(bundles.get(sha256) ?? "/missing", file),
    // The machine's `mako:move-follow`: its checkout as it stands, kept by its hash.
    callThread: async (_cloudThread, channel) => {
      assert.equal(channel, "mako:move-follow")
      asked += 1
      const { checkpoint, file } = await captureMoveCheckpoint(git, machine, mkdtempSync(join(root, "there-")))
      bundles.set(checkpoint.sha256, file)
      return encodeRuntimeValue({ repositories: [{ path: mac, checkpoint }] })
    },
    returning: () => returning,
    stopped: (_cloudThread, state) => void stopped.push(state),
  })

  // A turn in the cloud: a commit, a staged file, an edit; laid here.
  writeFileSync(join(machine, "b.txt"), "committed in the cloud\n")
  sh(machine, "add", "b.txt")
  sh(machine, "commit", "--quiet", "-m", "in the cloud")
  writeFileSync(join(machine, "c.txt"), "staged in the cloud\n")
  sh(machine, "add", "c.txt")
  writeFileSync(join(machine, "a.txt"), "one, changed in the cloud\n")
  assert.equal(await follow.follow(cloudThread), "followed")
  assert.equal(readFileSync(join(mac, "a.txt"), "utf8"), "one, changed in the cloud\n")
  assert.equal(sh(mac, "log", "-1", "--format=%s"), "in the cloud")
  assert.equal(sh(mac, "diff", "--cached", "--name-only"), "c.txt")
  const laid = await follow.laid(cloudThread, mac)
  assert.ok(laid && laid.sha256 !== sent.checkpoint.sha256, "what was laid is what a way back merges from")

  // A turn that changed nothing lays nothing.
  assert.equal(await follow.follow(cloudThread), "unchanged")

  // The person edits here: following stops before the cloud is asked; their edit stands; said once.
  writeFileSync(join(machine, "a.txt"), "one, changed in the cloud again\n")
  writeFileSync(join(mac, "a.txt"), "one, the person's\n")
  const before = asked
  assert.equal(await follow.follow(cloudThread), "stopped")
  assert.equal(asked, before, "the cloud isn't asked")
  assert.equal(readFileSync(join(mac, "a.txt"), "utf8"), "one, the person's\n", "nothing of theirs is written over")
  assert.deepEqual(stopped.map((state) => state.edited?.folders), [[mac]])
  assert.equal(await follow.follow(cloudThread), "stopped")
  assert.equal(stopped.length, 1, "said once")
  assert.deepEqual((await follow.stoppedThreads()).map((state) => state.cloudThread), [cloudThread])
  assert.deepEqual(await follow.laid(cloudThread, mac), laid, "the last laid stays the way back's base")

  // Coming back, or never moved there: nothing follows.
  returning = true
  assert.equal(await follow.follow(cloudThread), "not-followed")
  returning = false
  assert.equal(await follow.follow("t-other00000000000"), "not-followed")
  await follow.forget(cloudThread)
  assert.equal(await follow.state(cloudThread), undefined, "back, its following is forgotten")

  console.log("cloud follow: the machine's checkout laid here at a turn's end, nothing for a turn that changed nothing, stopped before the cloud is asked once the person edits here, their edit kept, said once, the last laid kept for the way back: ok")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
