import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { CloudFollow, type FollowState } from "@mako/host/conversations/cloud-follow"
import { CloudWorktrees } from "@mako/host/conversations/cloud-worktrees"
import { encodeRuntimeValue } from "@mako/host/contracts/runtime-value"
import { applyMoveCheckpoint, captureMoveCheckpoint } from "@mako/host/workspaces/move-checkpoint"

/**
 * The Mac's worktree of a Thread running in the cloud follows it (`CloudFollow`), on real repositories: at a cloud
 * turn's end the machine's checkout is laid into the worktree here, its commit, staged and unstaged work alike; a turn
 * that changed nothing lays nothing; once the person changes the worktree here, following stops before the cloud is
 * asked, nothing of theirs is written over, and the windows hear it once; the checkout last laid is what a way back
 * merges from. Nothing follows a Thread coming back, nor one no move took there. The races, with the machine's answer
 * held: an edit the person makes while the machine answers stops the follow before anything is laid, and a way back
 * that begins meanwhile owns the worktree, so the follow lays nothing. The worktree's writes run one at a time.
 */
const root = mkdtempSync(join(tmpdir(), "mako-cloud-follow-"))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

/** A promise the test settles: what a held answer waits on. */
function gate() {
  let open = () => {}
  const opened = new Promise<void>((resolve) => (open = resolve))
  return { opened, open }
}

try {
  const remote = join(root, "remote.git")
  sh(root, "init", "--bare", "--quiet", remote)
  const seed = join(root, "seed")
  sh(root, "clone", "--quiet", remote, seed)
  writeFileSync(join(seed, "a.txt"), "one\n")
  sh(seed, "add", ".")
  sh(seed, "commit", "--quiet", "-m", "base")
  sh(seed, "push", "--quiet", "origin", "main")

  const bundles = new Map<string, string>()
  const moves = join(root, "moves")
  mkdirSync(moves)
  const worktrees = new CloudWorktrees()
  let returning = false
  let asked = 0
  /** Set to hold the machine's answer until the test opens it; `heard` opens as it's asked. */
  let hold: { opened: Promise<void>; heard: () => void } | undefined
  const stopped: FollowState[] = []
  /** By cloud Thread: the worktree here and the machine's clone. */
  const threads = new Map<string, { mac: string; machine: string }>()

  /** A Thread moved to the cloud: the worktree here, the machine's clone, and the move's plan that took it there. */
  async function moved(name: string) {
    const mac = join(root, `${name}-mac`)
    const machine = join(root, `${name}-machine`)
    sh(root, "clone", "--quiet", remote, mac)
    sh(mac, "checkout", "--quiet", "-b", "mako/fix")
    writeFileSync(join(mac, "a.txt"), "one, as it left\n")
    // The move that took it there: its checkpoint, as the plan keeps it and the cloud has it.
    const sent = await captureMoveCheckpoint(git, mac, mkdtempSync(join(root, "sent-")))
    bundles.set(sent.checkpoint.sha256, sent.file)
    const cloudThread = `t-${name.padEnd(16, "0").slice(0, 16).replace(/[^0-9a-f]/g, "a")}`
    writeFileSync(join(moves, `${name}.json`), JSON.stringify({
      move: randomUUID(), thread: randomUUID(), asked: randomUUID(), cloudThread, folder: mac, repository: { url: "https://github.com/octocat/Hello-World" },
      sessions: [{ session: randomUUID(), conversationId: randomUUID(), harness: "codex", nativeId: "n-1", path: "/codex/n-1.jsonl" }],
      phase: "started", checkpoint: sent.checkpoint, began: 1, timings: {},
    }))
    sh(root, "clone", "--quiet", remote, machine)
    await applyMoveCheckpoint(git, machine, sent.file, sent.checkpoint)
    threads.set(cloudThread, { mac, machine })
    return { mac, machine, cloudThread, sent }
  }

  const follow = new CloudFollow({
    folder: join(root, "follow"),
    moves,
    git,
    readCheckpoint: async (_cloudThread, sha256, file) => copyFileSync(bundles.get(sha256) ?? "/missing", file),
    // The machine's `mako:move-follow`: its checkout as it stands, kept by its hash; held while the test holds it.
    callThread: async (cloudThread, channel) => {
      assert.equal(channel, "mako:move-follow")
      asked += 1
      const { mac, machine } = threads.get(cloudThread) ?? { mac: "/missing", machine: "/missing" }
      const { checkpoint, file } = await captureMoveCheckpoint(git, machine, mkdtempSync(join(root, "there-")))
      bundles.set(checkpoint.sha256, file)
      const held = hold
      if (held) {
        held.heard()
        await held.opened
      }
      return encodeRuntimeValue({ repositories: [{ path: mac, checkpoint }] })
    },
    returning: () => returning,
    stopped: (_cloudThread, state) => void stopped.push(state),
    worktrees,
  })
  /** A follow whose machine answers only once opened: resolves `asked` when the machine has been asked. */
  const heldFollow = (cloudThread: string) => {
    const answer = gate()
    const heard = gate()
    hold = { opened: answer.opened, heard: heard.open }
    const following = follow.follow(cloudThread)
    return { following, asked: heard.opened, answer: () => { hold = undefined; answer.open() } }
  }

  {
    const { mac, machine, cloudThread, sent } = await moved("plain")
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

    // A way back begins while the machine answers: from its first write the worktree is the way back's, and the follow
    // that started before it lays nothing.
    writeFileSync(join(machine, "a.txt"), "one, a turn the way back overtook\n")
    const overtaken = heldFollow(cloudThread)
    await overtaken.asked
    const kept = worktrees.returnWrite(cloudThread, async () => readFileSync(join(mac, "a.txt"), "utf8"))
    overtaken.answer()
    assert.equal(await overtaken.following, "not-followed")
    assert.equal(await kept, "one, changed in the cloud\n", "the way back kept the worktree as last laid")
    assert.equal(readFileSync(join(mac, "a.txt"), "utf8"), "one, changed in the cloud\n", "nothing laid after the way back began")
    assert.deepEqual(await follow.laid(cloudThread, mac), laid)

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
  }

  // The person edits while the machine answers: the worktree is read again right before anything is laid, so the
  // follow stops there and their edit, and their new file, stand.
  {
    const { mac, machine, cloudThread } = await moved("meanwhile")
    writeFileSync(join(machine, "a.txt"), "one, the cloud's turn\n")
    const following = heldFollow(cloudThread)
    await following.asked
    writeFileSync(join(mac, "a.txt"), "one, the person's, as the machine answered\n")
    writeFileSync(join(mac, "new.txt"), "the person's new file\n")
    following.answer()
    assert.equal(await following.following, "stopped")
    assert.equal(readFileSync(join(mac, "a.txt"), "utf8"), "one, the person's, as the machine answered\n", "their edit isn't written over")
    assert.equal(readFileSync(join(mac, "new.txt"), "utf8"), "the person's new file\n", "their new file isn't cleared")
    assert.deepEqual(stopped.at(-1)?.edited?.folders, [mac], "following stops, said to the windows")
    assert.equal(await follow.laid(cloudThread, mac), undefined, "nothing was laid")
  }

  // The worktree's writes run one at a time, in the order asked, whoever asks.
  {
    const order: string[] = []
    const first = gate()
    const one = worktrees.write("t-order0000000000", async () => {
      order.push("one starts")
      await first.opened
      order.push("one ends")
    })
    const two = worktrees.returnWrite("t-order0000000000", async () => void order.push("two"))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(order, ["one starts"], "the second waits for the first")
    first.open()
    await Promise.all([one, two])
    assert.deepEqual(order, ["one starts", "one ends", "two"])
    await assert.rejects(worktrees.write("t-order0000000000", async () => { throw new Error("a failed write") }))
    assert.equal(await worktrees.write("t-order0000000000", async () => "after"), "after", "a failure doesn't stop the next")
  }

  console.log("cloud follow: the machine's checkout laid here at a turn's end, nothing for a turn that changed nothing, stopped before the cloud is asked once the person edits here, their edit kept, said once, the last laid kept for the way back; an edit made while the machine answered stops it before anything is laid; a way back begun meanwhile owns the worktree and nothing is laid; the worktree's writes one at a time: ok")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
