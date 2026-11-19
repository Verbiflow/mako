import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, stat, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { Git, type RunOptions } from "@mako/git"
import type { HistoryMark } from "@mako/host/contracts/watcher-child"
import type { FileHistory, HistoryOptions } from "@mako/host/workspaces/watch-backend"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"

/**
 * A turn's checkpoint, which its agent waits for, is the last one taken of its workspace when nothing it holds can
 * have changed since: the watcher's history names no path there and lost none, HEAD is where it was and the index
 * stages the same. Anything else is a capture. On 2026-11-12 every message waited 1.2-3.9 s on its checkpoint at the
 * scale of the person's day, and twice that on their 12,661-file checkout.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkpoint-reuse-")))
const cwd = join(root, "workspace")
mkdirSync(cwd)
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
git("init", "-q", "-b", "main")
git("config", "user.email", "test@localhost")
git("config", "user.name", "Test")
writeFileSync(join(cwd, "a.txt"), "a\n")
git("add", ".")
git("commit", "-qm", "first")

// The watcher's history as a script: each change it heard is numbered, and a mark is the number reached.
const heard: { at: number; path: string }[] = []
let count = 0
let lost = false
let reads = 0
const history: FileHistory = {
  mark: async (): Promise<HistoryMark> => ({ id: String(count), at: String(BigInt(Date.now()) * 1_000_000n) }),
  since: async (mark: HistoryMark, roots: readonly string[], options?: HistoryOptions) => {
    reads++
    const inside = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`)
    const paths = heard.filter((change) => change.at > Number(mark.id) && roots.some((root) => inside(change.path, root)) && !options?.exclude?.some((folder) => inside(change.path, folder))).map((change) => change.path)
    return { paths, lost: lost ? [...roots] : [], ignored: [] }
  },
}
const edit = (path: string, content: string, told = true) => {
  writeFileSync(join(cwd, path), content)
  if (told) heard.push({ at: ++count, path: join(cwd, path) })
}

/** What a checkpoint's record says it holds, as the store saved it. */
const SavedCheckpoint = z.object({ tree: z.string(), head: z.string(), files: z.number(), indexDigest: z.string() })
const SavedRow = z.object({ value: z.string() })

// Every Git command the store runs, to tell a capture from the last checkpoint (it lists nothing whole) from a whole one.
const commands: (readonly string[])[] = []
const runner = new Git()
const run = runner.run.bind(runner)
runner.run = (options: RunOptions) => {
  commands.push(options.args)
  return run(options)
}
const store = new WorkspaceSnapshots(runner, join(root, "store"))
store.followHistory(history)
const turn = async () => {
  const id = randomUUID()
  const began = performance.now()
  const before = await store.beginRun(id, cwd)
  const ms = performance.now() - began
  const after = await store.endRun(id)
  return { before, after, ms }
}

try {
  const first = await turn()
  assert.notEqual(first.before.id, first.after.id, "the first turn takes its own checkpoint")

  // Nothing changed since the last turn ended: the next goes on that checkpoint, without a capture.
  const quiet = await turn()
  assert.equal(quiet.before.id, first.after.id, "a turn after a quiet wait starts from the last checkpoint")
  assert.notEqual(quiet.after.id, quiet.before.id, "its end is checkpointed as ever")

  // A file the watcher heard change: a capture, holding the change.
  edit("a.txt", "edited\n")
  const edited = await turn()
  assert.notEqual(edited.before.id, quiet.after.id, "a change in the working tree is captured")

  // Changes in Git's own folder are HEAD's and the index's to say, not the history's.
  heard.push({ at: ++count, path: join(cwd, ".git", "index") })
  const gitFolder = await turn()
  assert.equal(gitFolder.before.id, edited.after.id, "a write in .git alone (a status refreshing the index) changes nothing")

  // The index stages something new and the history never said so: the staged digest does.
  edit("b.txt", "b\n", false)
  git("add", "b.txt")
  const staged = await turn()
  assert.notEqual(staged.before.id, gitFolder.after.id, "what the index stages is compared, whatever the history said")

  // HEAD moved: a commit changes nothing in the working tree.
  git("commit", "-qm", "second")
  const committed = await turn()
  assert.notEqual(committed.before.id, staged.after.id, "a moved HEAD is captured")

  // The history lost events there: nothing it says can be trusted.
  lost = true
  const unsure = await turn()
  assert.notEqual(unsure.before.id, committed.after.id, "a history that lost events is a capture")
  lost = false

  // History that can't be read is a capture too.
  const reading = history.since
  history.since = async () => { throw new Error("watcher gone") }
  const unread = await turn()
  assert.notEqual(unread.before.id, unsure.after.id, "a history that can't be read is a capture")
  history.since = reading

  // An ignore rule outside the working tree changed: the history can't see it, its file's stamp does.
  writeFileSync(join(cwd, ".git", "info", "exclude"), "*.log\n")
  const excluded = await turn()
  assert.notEqual(excluded.before.id, unread.after.id, "a changed info/exclude is captured")

  // Another turn in the same workspace: its checkpoint names the runs that share it, so it's always its own.
  const other = randomUUID()
  await store.beginRun(other, cwd)
  const sharing = randomUUID()
  const shared = await store.beginRun(sharing, cwd)
  assert.ok(shared.shared?.includes(other), "a shared workspace's checkpoint names the other run")
  const sharedEnd = await store.endRun(sharing)
  assert.ok(sharedEnd.shared?.includes(other), "and so does its end")
  await store.endRun(other)
  // The last one taken there named the other run (`other`'s end shares nothing now): a turn alone next never reuses
  // one that names others.
  const sharingAgain = randomUUID()
  await store.beginRun(sharingAgain, cwd)
  const third = randomUUID()
  await store.beginRun(third, cwd)
  await store.endRun(third)
  await store.endRun(sharingAgain)
  const alone = await turn()
  assert.equal(alone.before.shared, undefined, "a turn alone never starts on a checkpoint that names other runs")

  // From the last checkpoint: the turn is told once what changed is read, and the agent writes at once. The checkpoint
  // still holds the workspace as the turn started, tree for tree what a whole capture of that moment takes.
  const treeOf = (storeRoot: string, id: string) => {
    const db = new DatabaseSync(join(storeRoot, "snapshots.sqlite"), { readOnly: true })
    try {
      const row = z.object({ value: z.string() }).optional().parse(db.prepare("SELECT value FROM snapshots WHERE id = ?").get(id))
      return row ? z.object({ tree: z.string() }).loose().parse(JSON.parse(row.value)).tree : undefined
    } finally {
      db.close()
    }
  }
  await turn()
  edit("a.txt", "the person's edit\n")
  mkdirSync(join(cwd, "dir"), { recursive: true })
  edit("dir/new.txt", "new in a new folder\n")
  mkdirSync(join(cwd, "gone"), { recursive: true })
  rmSync(join(cwd, "b.txt"))
  heard.push({ at: ++count, path: join(cwd, "b.txt") })
  edit("ignored.log", "an ignored file\n")
  const whole = new WorkspaceSnapshots(new Git(), join(root, "whole"))
  const expected = treeOf(join(root, "whole"), (await whole.capture(cwd)).id)
  whole.close()
  const saved = () => {
    const db = new DatabaseSync(join(root, "store", "snapshots.sqlite"), { readOnly: true })
    try {
      return z.object({ n: z.number() }).parse(db.prepare("SELECT count(*) AS n FROM snapshots").get()).n
    } finally {
      db.close()
    }
  }
  const savedBefore = saved()
  let savedWhenTold = -1
  const racing = randomUUID()
  let toldAt = -1
  const began = performance.now()
  const raced = store.beginRun(racing, cwd, () => {
    toldAt = performance.now() - began
    savedWhenTold = saved()
    // The agent's first writes, the moment it's told: a changed file again, a new one, one deleted.
    edit("a.txt", "the agent's write\n")
    edit("agent.txt", "the agent's new file\n")
    rmSync(join(cwd, "dir", "new.txt"))
    heard.push({ at: ++count, path: join(cwd, "dir", "new.txt") })
  })
  const startedOn = await raced
  const savedAt = performance.now() - began
  assert.equal(savedWhenTold, savedBefore, "the turn was told before its checkpoint was saved")
  assert.equal(treeOf(join(root, "store"), startedOn.id), expected, "the checkpoint is the workspace as the turn started, the agent's writes left out")
  // Its end follows on from its start too: only what the watcher heard change during the turn is read, and the
  // checkpoint is tree for tree a whole capture of the workspace as the turn ended.
  commands.length = 0
  // As the host ends a turn: told once the closing files are read (`LiveCheckpoints.settle`).
  const ended = await store.endRun(racing, () => {})
  const listedWhole = commands.some((args) => args.includes("--others"))
  const added = commands.filter((args) => args.includes("add"))
  const atEnd = new WorkspaceSnapshots(new Git(), join(root, "whole-end"))
  const expectedEnd = treeOf(join(root, "whole-end"), (await atEnd.capture(cwd)).id)
  atEnd.close()
  assert.equal(listedWhole, false, "a turn's end alone in its workspace reads only what changed since its start")
  assert.ok(added.length === 1 && added[0]!.includes("--pathspec-from-file=-"), "its add takes the paths the watcher heard, not the whole working tree")
  assert.equal(treeOf(join(root, "store"), ended.id), expectedEnd, "the end checkpoint is the workspace as the turn ended")
  // A turn that changed nothing still has its own end, read from its start with nothing to add.
  const still = randomUUID()
  const stillStart = await store.beginRun(still, cwd)
  commands.length = 0
  const stillEnd = await store.endRun(still, () => {})
  assert.notEqual(stillEnd.id, stillStart.id, "a quiet turn's end is its own checkpoint")
  assert.equal(commands.some((args) => args.includes("add") || args.includes("--others")), false, "and costs no read of the working tree")
  assert.equal(treeOf(join(root, "store"), stillEnd.id), treeOf(join(root, "store"), stillStart.id), "holding what its start held")

  // Two turns at once in one checkout (two Threads in the main checkout): each checkpoint, start and end, still follows
  // on from the last one, names the runs it shared the workspace with, and is tree for tree a whole capture.
  const wholeNow = async (name: string) => {
    const whole = new WorkspaceSnapshots(new Git(), join(root, name))
    try {
      return treeOf(join(root, name), (await whole.capture(cwd)).id)
    } finally {
      whole.close()
    }
  }
  const followed = () => !commands.some((args) => args.includes("--others"))
  const one = randomUUID(), two = randomUUID()
  edit("a.txt", "before both\n")
  commands.length = 0
  const firstStart = await store.beginRun(one, cwd, () => {})
  assert.ok(followed(), "the first turn's start follows on")
  assert.equal(firstStart.shared, undefined, "alone so far, it names no other run")
  edit("one.txt", "the first turn's file\n")
  commands.length = 0
  const secondStart = await store.beginRun(two, cwd, () => {})
  assert.ok(followed(), "a turn starting beside another follows on too, rather than reading the whole working tree")
  assert.deepEqual(secondStart.shared, [one], "and names the run it shares the workspace with")
  assert.equal(treeOf(join(root, "store"), secondStart.id), await wholeNow("whole-shared-start"), "holding what a whole capture of that moment holds")
  edit("two.txt", "the second turn's file\n")
  edit("a.txt", "the first turn's edit\n")
  commands.length = 0
  const firstEnd = await store.endRun(one, () => {})
  assert.ok(followed(), "the first turn's end follows on")
  assert.deepEqual(firstEnd.shared, [two], "naming the run that shared it")
  assert.equal(treeOf(join(root, "store"), firstEnd.id), await wholeNow("whole-shared-one-end"), "and holds the workspace as that turn ended")
  edit("two.txt", "the second turn's last edit\n")
  commands.length = 0
  const secondEnd = await store.endRun(two, () => {})
  assert.ok(followed(), "the second turn's end follows on")
  assert.deepEqual(secondEnd.shared, [one], "naming the run that shared it")
  assert.equal(treeOf(join(root, "store"), secondEnd.id), await wholeNow("whole-shared-two-end"), "and holds the workspace as it ended")
  // A turn alone after them starts on what they left without naming them.
  const later = await turn()
  assert.equal(later.before.shared, undefined, "a turn alone afterwards names neither")
  assert.notEqual(later.before.id, secondEnd.id, "and never takes as its own a checkpoint that names other runs")
  assert.equal(treeOf(join(root, "store"), later.before.id), treeOf(join(root, "store"), secondEnd.id), "though it holds the same workspace")
  console.log(JSON.stringify({ toldMs: Math.round(toldAt), savedMs: Math.round(savedAt) }))

  // Reused, the wait is the history's read and two Git reads, not a capture.
  const settled = await turn()
  const again = await turn()
  assert.equal(again.before.id, settled.after.id)
  // History is only a shortcut. A reader stuck in native FSEvents must not hold a checkpoint's index lock.
  for (const phase of ["since", "mark"] as const) {
    const markPending = Promise.withResolvers<HistoryMark>()
    const readPending = Promise.withResolvers<Awaited<ReturnType<FileHistory["since"]>>>()
    const entered = Promise.withResolvers<void>()
    const originalMark = history.mark, originalRead = history.since
    let asks = 0
    if (phase === "since") history.since = () => { asks++; entered.resolve(); return readPending.promise }
    else history.mark = () => { asks++; entered.resolve(); return markPending.promise }
    const id = randomUUID()
    const began = performance.now()
    const taking = store.beginRun(id, cwd)
    await entered.promise
    const queued = store.capture(cwd)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`stuck ${phase} blocked the checkpoint and the next capture past the turn's deadline`)), 10_000) })
    try {
      const [captured, next] = await Promise.race([Promise.all([taking, queued]), deadline])
      const heldAndQueuedMs = performance.now() - began
      assert.match(treeOf(join(root, "store"), captured.id) ?? "", /^[a-f0-9]{40,64}$/, "the fallback is a saved checkpoint")
      assert.equal(treeOf(join(root, "store"), captured.id), treeOf(join(root, "store"), next.id), "both fresh checkpoints hold the actual workspace while history has not answered")
      assert.equal(asks, 1, "a timed-out native reader is not piled up with more history asks")
      const beforeLate = treeOf(join(root, "store"), captured.id)
      edit("a.txt", `changed after the ${phase} fallback\n`)
      readPending.resolve({ paths: [], lost: [], ignored: [] })
      markPending.resolve({ id: String(count), at: String(BigInt(Date.now()) * 1_000_000n) })
      await Promise.all([readPending.promise, markPending.promise])
      history.mark = originalMark
      history.since = originalRead
      await store.endRun(id)
      const following = await turn()
      assert.notEqual(treeOf(join(root, "store"), following.before.id), beforeLate, "a late history reply cannot publish or reuse the old workspace")
      console.log(JSON.stringify({ stuckHistory: phase, checkpointAndQueuedMs: Math.round(heldAndQueuedMs) }))
    } finally {
      clearTimeout(timer)
      history.mark = originalMark
      history.since = originalRead
      readPending.resolve({ paths: [], lost: [], ignored: [] })
      markPending.resolve({ id: String(count), at: String(BigInt(Date.now()) * 1_000_000n) })
      await Promise.allSettled([taking, queued])
      store.abandonRun(id)
    }
  }
  console.log(JSON.stringify({ captureMs: Math.round(settled.ms), reusedMs: Math.round(again.ms), historyReads: reads }))
  // The host's loop was busy past the history's deadline with the reply already delivered: the late timer runs first,
  // and must give the reply its turn rather than throw it away ("slow file history bypassed", with history on time).
  {
    const prompt = history.mark
    let stalls = 0
    history.mark = () => new Promise<HistoryMark>((resolve, reject) => {
      // Held outside the loop's timers, as a long message handler holds it: once it's free, the timers that came due
      // run before the I/O that arrived meanwhile is read.
      setImmediate(() => {
        stalls++
        // The reply arrives as I/O while the loop is held.
        stat(cwd, () => { prompt().then(resolve, reject) })
        const until = performance.now() + 700
        while (performance.now() < until);
      })
    })
    try {
      const held = await turn()
      history.mark = prompt
      const next = await turn()
      assert.ok(stalls >= 1)
      assert.equal(next.before.id, held.after.id, "a reply that arrived while the host was busy is used, however late the deadline's timer ran")
    } finally {
      history.mark = prompt
    }
    console.log("PASS: a history reply already delivered is never discarded by a late timer")
  }
  // The listing a reuse check reads fails (Git killed, a read slot's timeout): the check says nothing, and the turn
  // falls through to a whole capture, which lists the index itself. Only that capture's own failure fails a turn's
  // checkpoint, since a turn without one has nothing to rewind to.
  {
    const settledBefore = await turn()
    const listings = () => commands.filter((args) => args.includes("ls-files") && args.includes("-v")).length
    const underneath = runner.run
    let failed = 0
    runner.run = (options: RunOptions) => {
      if (!failed && options.args.includes("ls-files") && options.args.includes("-v")) {
        failed++
        commands.push(options.args)
        return Promise.reject(new Error("the listing failed"))
      }
      return underneath(options)
    }
    try {
      commands.length = 0
      const id = randomUUID()
      const before = await store.beginRun(id, cwd)
      assert.equal(failed, 1, "the reuse check's listing was the one that failed")
      assert.notEqual(before.id, settledBefore.after.id, "nothing is reused on a check that couldn't read the index")
      assert.equal(listings(), 2, "the whole capture listed the index again itself")
      assert.ok(commands.some((args) => args.includes("--others")), "and read the whole working tree")
      const whole = new WorkspaceSnapshots(new Git(), join(root, "whole-after-failed-listing"))
      try {
        assert.equal(treeOf(join(root, "store"), before.id), treeOf(join(root, "whole-after-failed-listing"), (await whole.capture(cwd)).id), "holding the workspace as it is")
      } finally {
        whole.close()
      }
      await store.endRun(id)
    } finally {
      runner.run = underneath
    }
    console.log("PASS: a listing that fails in the reuse check falls through to a whole capture")
  }
  // What a capture costs in Git processes, and that it holds what the path before held. Before: 24 for a whole
  // capture (28 with history), 27 to 29 from the last checkpoint, 8 to find nothing changed.
  {
    const folder = join(root, "cost")
    mkdirSync(folder)
    const at = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8" }).trim()
    at("init", "-q", "-b", "main")
    at("config", "user.email", "test@localhost")
    at("config", "user.name", "Test")
    for (const name of ["kept", "skipped"]) mkdirSync(join(folder, name))
    writeFileSync(join(folder, "kept/a"), "a\n")
    writeFileSync(join(folder, "skipped/b"), "b\n")
    writeFileSync(join(folder, "tracked"), "c\n")
    writeFileSync(join(folder, ".gitignore"), "ignored\n")
    at("add", ".")
    at("commit", "-qm", "first")
    at("sparse-checkout", "set", "--no-cone", "/*", "!/skipped/")
    writeFileSync(join(folder, "tracked"), "staged\n")
    at("add", "tracked")
    writeFileSync(join(folder, "tracked"), "unstaged\n")
    writeFileSync(join(folder, "untracked"), "u\n")
    writeFileSync(join(folder, "ignored"), "i\n")
    const ran: (readonly string[])[] = []
    const counted = new Git()
    const underneath = counted.run.bind(counted)
    counted.run = (options: RunOptions) => {
      ran.push(options.args)
      return underneath(options)
    }
    const storeRoot = join(root, "cost-store")
    const costs = new WorkspaceSnapshots(counted, storeRoot)
    const record = (id: string) => {
      const db = new DatabaseSync(join(storeRoot, "snapshots.sqlite"), { readOnly: true })
      try {
        return SavedCheckpoint.parse(JSON.parse(SavedRow.parse(db.prepare("SELECT value FROM snapshots WHERE id = ?").get(id)).value))
      } finally {
        db.close()
      }
    }
    // What Git itself takes of the checkout now, with nothing of Mako's: the same add into a copy of the index.
    const expected = (sparse: boolean) => {
      const scratch = join(root, "cost-index")
      copyFileSync(join(folder, ".git/index"), scratch)
      const env = { ...process.env, GIT_INDEX_FILE: scratch }
      execFileSync("git", ["add", "-A", ...(sparse ? ["--sparse"] : []), "--", "."], { cwd: folder, env })
      return {
        tree: execFileSync("git", ["write-tree"], { cwd: folder, env, encoding: "utf8" }).trim(),
        head: `refs/heads/main:${at("rev-parse", "HEAD")}`,
        files: at("ls-files", "-z").split("\0").filter(Boolean).length + at("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean).length,
      }
    }
    // The index a checkpoint keeps is the checkout's, entry for entry and flag for flag (Git rewrites the copy whole,
    // so its bytes are its own), and the record's digest is of the file kept.
    const holds = (id: string, sparse: boolean, message?: string) => {
      const { indexDigest, ...saved } = record(id)
      assert.deepEqual(saved, expected(sparse), message)
      const kept = join(storeRoot, id, "index")
      assert.equal(indexDigest, createHash("sha256").update(readFileSync(kept)).digest("hex"))
      const listing = (index?: string) => execFileSync("git", ["ls-files", "--stage", "-v", "-z"], { cwd: folder, encoding: "utf8", env: { ...process.env, ...(index && { GIT_INDEX_FILE: index }) } })
      assert.equal(listing(kept), listing(), "the kept index stages what the checkout's does")
    }
    const spent = (label: string, most: number, never: readonly string[] = ["symbolic-ref", "--show-toplevel", "--show-object-format", "config", "--verify"]) => {
      const names = ran.map((args) => args.filter((arg) => arg !== "-c" && !arg.includes("=")).slice(0, 2).join(" "))
      assert.ok(ran.length <= most, `${label} ran ${ran.length} Git processes, more than ${most}: ${names.join(", ")}`)
      for (const word of never) assert.ok(!ran.some((args) => args.includes(word)), `${label} asked Git again for what it knew: ${word}`)
      const count = ran.length
      ran.length = 0
      return count
    }
    let changes = 0
    const changed: { at: number; path: string }[] = []
    const one = randomUUID(), two = randomUUID()
    try {
      // Opening the repository and the checkout's facts are asked once a checkout; every capture after is what is counted.
      const first = await costs.capture(folder)
      assert.ok(ran.length <= 20, `the first capture of a checkout ran ${ran.length} Git processes`)
      ran.length = 0
      // The tree the path before this one took of this fixture: staged, unstaged, untracked, ignored and sparse.
      assert.equal(record(first.id).tree, "94bf6774cf9b051a52e62feea899689248c2314e")
      holds(first.id, true, "a whole capture holds what Git takes of the checkout: tree, HEAD and files")
      const whole = await costs.capture(folder)
      holds(whole.id, true)
      const wholeCost = spent("a whole capture", 15)
      costs.followHistory({
        mark: async () => ({ id: String(changes), at: "0" }),
        since: async (mark) => ({ paths: changed.filter((change) => change.at > Number(mark.id)).map((change) => change.path), lost: [], ignored: [] }),
      })
      // Sparse off is the checkout's own configuration changing: its facts are read again, once.
      at("sparse-checkout", "disable")
      const begun = await costs.beginRun(one, folder, () => {})
      holds(begun.id, false, "a changed configuration is seen by the next capture")
      assert.ok(ran.some((args) => args.includes("core.sparseCheckout")) && !ran.some((args) => args.includes("--sparse")))
      spent("a whole capture after its configuration changed", 18, [])
      const quietEnd = await costs.endRun(one, () => {})
      holds(quietEnd.id, false)
      const quietCost = spent("a turn's end with nothing changed", 14)
      const same = await costs.beginRun(two, folder, () => {})
      assert.equal(same.id, quietEnd.id)
      const sameCost = spent("finding nothing changed", 1)
      writeFileSync(join(folder, "untracked"), "u2\n")
      changed.push({ at: ++changes, path: join(folder, "untracked") })
      const followed = await costs.endRun(two, () => {})
      assert.equal(record(followed.id).tree, "dca395edcc8a1ad0e3d40dd8c297ab3ee2704e1b")
      holds(followed.id, false, "a capture from the last checkpoint holds what a whole one would")
      const followCost = spent("a capture from the last checkpoint", 16)
      // HEAD read from Git's files says what Git says: a packed branch, a detached HEAD, a linked worktree's own.
      at("pack-refs", "--all")
      assert.ok(!existsSync(join(folder, ".git/refs/heads/main")))
      assert.equal(record((await costs.capture(folder)).id).head, `refs/heads/main:${at("rev-parse", "HEAD")}`, "a packed branch")
      at("commit", "-qm", "second", "--allow-empty")
      assert.equal(record((await costs.capture(folder)).id).head, `refs/heads/main:${at("rev-parse", "HEAD")}`, "a commit after packing")
      at("checkout", "-q", "--detach")
      assert.equal(record((await costs.capture(folder)).id).head, `detached:${at("rev-parse", "HEAD")}`, "a detached HEAD")
      at("checkout", "-q", "main")
      const linked = join(root, "cost-linked")
      at("worktree", "add", "-q", "-b", "linked", linked)
      assert.equal(record((await costs.capture(linked)).id).head, `refs/heads/linked:${at("rev-parse", "linked")}`, "a linked worktree's branch")
      assert.ok(!ran.some((args) => args.includes("symbolic-ref")), "none of them asked Git where HEAD is")
      console.log(JSON.stringify({ gitProcesses: { whole: wholeCost, fromLast: followCost, fromLastQuiet: quietCost, unchanged: sameCost } }))
      console.log("PASS: a capture asks Git once for each thing it needs, and holds what the longer path held")
    } finally {
      costs.abandonRun(one)
      costs.abandonRun(two)
      costs.close()
      await counted.close()
    }
  }
  // Without a user index, an incremental capture must retain its updated private index.
  {
    const folder = join(root, "unborn")
    mkdirSync(folder)
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: folder })
    const file = join(folder, "changed.txt")
    writeFileSync(file, "first\n")
    writeFileSync(join(folder, "unchanged.txt"), "keep me\n")
    const storeRoot = join(root, "unborn-store")
    const unborn = new WorkspaceSnapshots(new Git(), storeRoot)
    unborn.followHistory(history)
    const wholeRoot = join(root, "unborn-whole")
    const whole = new WorkspaceSnapshots(new Git(), wholeRoot)
    const first = randomUUID()
    const second = randomUUID()
    try {
      await unborn.beginRun(first, folder)
      unborn.abandonRun(first)
      writeFileSync(file, "second\n")
      heard.push({ at: ++count, path: file })
      const incremental = await unborn.beginRun(second, folder)
      const expected = await whole.capture(folder)
      assert.equal(treeOf(storeRoot, incremental.id), treeOf(wholeRoot, expected.id), "an unborn incremental checkpoint retains both changed and unchanged content")
      assert.equal(existsSync(join(folder, ".git", "index")), false, "checkpointing leaves the unborn repository's user index absent")
    } finally {
      unborn.abandonRun(first)
      unborn.abandonRun(second)
      unborn.close()
      whole.close()
    }
  }
  console.log("checkpoint reuse: a quiet workspace's turn starts on its last checkpoint; a change, a staged path, a moved HEAD, or a lost or unread history is captured; a turn beside another follows on too, naming the runs it shares the workspace with")
} finally {
  store.close()
  rmSync(root, { recursive: true, force: true })
}
