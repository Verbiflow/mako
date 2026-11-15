import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Git, type RunOptions } from "@mako/git"
import { z } from "zod"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"

class CaptureGit extends Git {
  gate?: { command: string; cwd?: string; entered: ReturnType<typeof Promise.withResolvers<string>>; resume: ReturnType<typeof Promise.withResolvers<void>> }
  crash?: "update-index" | "add" | "pack-objects"
  readonly writing = new Set<string>()
  readonly stores = new Set<string>()

  override async run(options: RunOptions) {
    const command = options.args.find((arg) => ["add", "write-tree", "update-index", "commit-tree", "pack-objects", "update-ref"].includes(arg))
    const store = options.env?.GIT_OBJECT_DIRECTORY
    const index = options.env?.GIT_INDEX_FILE
    const keys = command ? [store, index].filter((key): key is string => Boolean(key)) : []
    for (const key of keys) {
      assert(!this.writing.has(key), "two captures cannot write the same private index or object store")
      this.writing.add(key)
    }
    if (store) this.stores.add(store)
    try {
      if (command && command === this.crash) process.exit(74)
      if (command === this.gate?.command && this.gate && (!this.gate.cwd || this.gate.cwd === options.cwd)) {
        const gate = this.gate
        this.gate = undefined
        assert(store)
        gate.entered.resolve(store)
        await gate.resume.promise
      }
      return await super.run(options)
    } finally {
      for (const key of keys) this.writing.delete(key)
    }
  }

  pause(command = "pack-objects", cwd?: string) {
    const gate = { command, cwd, entered: Promise.withResolvers<string>(), resume: Promise.withResolvers<void>() }
    this.gate = gate
    return gate
  }
}

if (process.argv[2] === "--crash") {
  const git = new CaptureGit()
  const command = process.argv[5]
  assert(command === "update-index" || command === "add" || command === "pack-objects")
  git.crash = command
  const store = new WorkspaceSnapshots(git, process.argv[4])
  await store.capture(process.argv[3])
  throw new Error("The capture did not reach its crash boundary")
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkpoint-order-")))
function fixture(name: string) {
  const cwd = join(root, name), storage = join(root, name + "-store")
  mkdirSync(cwd)
  const git = (...args: string[]) => execFileSync("git", args, {
    cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@localhost", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@localhost" },
  }).trim()
  git("init", "-q", "-b", "main")
  writeFileSync(join(cwd, "file"), "committed\n")
  git("add", "."); git("commit", "-qm", "initial")
  writeFileSync(join(cwd, "file"), "staged\n"); git("add", ".")
  writeFileSync(join(cwd, "file"), "before\n")
  return { cwd, storage, git, index: readFileSync(join(cwd, ".git/index")) }
}
function checkpoint(storage: string, id: string) {
  const db = new DatabaseSync(join(storage, "snapshots.sqlite"), { readOnly: true })
  try {
    const row = z.object({ value: z.string() }).parse(db.prepare("SELECT value FROM snapshots WHERE id=?").get(id))
    return z.object({ commit: z.string() }).parse(JSON.parse(row.value)).commit
  } finally { db.close() }
}
async function promptly<T>(value: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([value, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("a before checkpoint waited behind another capture's private pack")), 5000) })])
  } finally { clearTimeout(timer) }
}

try {
  const f = fixture("interleaved"), git = new CaptureGit()
  const store = new WorkspaceSnapshots(git, f.storage, { maxSnapshots: 1 })
  const first = randomUUID(), second = randomUUID()
  const gates: ReturnType<CaptureGit["pause"]>[] = []
  const pending: Promise<unknown>[] = []
  try {
    const baseline = await store.beginRun(first, f.cwd)
    const oldCommit = checkpoint(f.storage, baseline.id)
    writeFileSync(join(f.cwd, "file"), "closing\n")
    const closingGate = git.pause(); gates.push(closingGate)
    const closing = store.endRun(first); pending.push(closing)
    const closingStore = await closingGate.entered.promise
    assert(!existsSync(join(f.cwd, ".git/index.lock")), "sealing no longer reserves the real index")

    const beforeGate = git.pause(); gates.push(beforeGate)
    let frozen = 0
    const before = store.beginRun(second, f.cwd, () => {
      assert(!existsSync(join(f.cwd, ".git/index.lock")), "the agent may stage as soon as frozen is delivered")
      frozen++
    }); pending.push(before)
    const beforeStore = await promptly(beforeGate.entered.promise)
    assert(frozen, "the next turn holds its baseline while closing publication remains paused")
    const heldAt = Date.now()
    assert.notEqual(beforeStore, closingStore, "each overlapping seal owns a different store")
    assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), f.index)
    store.abandonRun(first)

    // The two paused seals still borrow the seed, even after the old run releases it.
    writeFileSync(join(f.cwd, "file"), "later\n")
    const later = await promptly(store.capture(f.cwd))
    assert(existsSync(join(f.storage, baseline.id)), "retention cannot remove a borrowed pack while sealing")
    assert.equal(f.git("--git-dir=" + join(f.storage, baseline.id, "git"), "show", oldCommit + ":file"), "before")
    assert.notEqual(later.id, baseline.id)
    await promptly(store.prune(f.cwd))
    assert(existsSync(join(f.storage, baseline.id)), "explicit prune also honors live borrowers without waiting on sealing")

    closingGate.resume.resolve()
    const closed = await closing
    const closedCommit = checkpoint(f.storage, closed.id)
    assert.equal(f.git("--git-dir=" + join(f.storage, closed.id, "git"), "show", closedCommit + ":file"), "closing", "a delayed seal never reads the next turn's files")
    assert(existsSync(join(f.storage, baseline.id)), "the second borrower retains its own lease")
    beforeGate.resume.resolve()
    const started = await before
    assert.equal(frozen, 1, "the frozen callback is delivered once")
    assert(started.createdAt <= heldAt, "the checkpoint timestamp precedes its provider's writes, not pack publication")
    const startCommit = checkpoint(f.storage, started.id)
    assert.equal(f.git("--git-dir=" + join(f.storage, started.id, "git"), "show", startCommit + ":file"), "closing")
    assert.equal(f.git("--git-dir=" + join(f.storage, started.id, "git"), "show", startCommit + "^:file"), "staged", "staged-only content stays reachable")
    await store.capture(f.cwd)
    assert(existsSync(join(f.storage, started.id)), "the published baseline lease transfers to the active turn")
    store.abandonRun(second)
    await store.prune(f.cwd)
    assert(!existsSync(join(f.storage, baseline.id)), "borrow leases are released after publication")
    assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), f.index)
    assert.equal(f.git("for-each-ref", "--format=%(refname)", "refs/mako/checkpoints"), "")
    console.log("PASS: before capture overtakes closing sealing, with independent indexes, immutable contents and retention leases")
  } finally {
    for (const gate of gates) gate.resume.resolve()
    await Promise.allSettled(pending)
    store.abandonRun(first); store.abandonRun(second)
    store.close(); await git.close()
  }

  {
    const f = fixture("read-order"), git = new CaptureGit()
    const store = new WorkspaceSnapshots(git, f.storage)
    const id = randomUUID(), next = randomUUID()
    const pending: Promise<unknown>[] = [], gates: ReturnType<CaptureGit["pause"]>[] = []
    try {
      await store.beginRun(id, f.cwd)
      writeFileSync(join(f.cwd, "file"), "closing\n")
      const reading = git.pause("add"); gates.push(reading)
      const closing = store.endRun(id); pending.push(closing)
      await reading.entered.promise
      const readingAt = Date.now()
      const packing = git.pause(); gates.push(packing)
      let dispatched = false
      const before = store.beginRun(next, f.cwd, () => {
        dispatched = true
        writeFileSync(join(f.cwd, "file"), "next provider's write\n")
      }); pending.push(before)
      await promptly(packing.entered.promise)
      assert(!dispatched, "a later provider waits for earlier closing reads, even when its own inputs are fixed")
      assert(!existsSync(join(f.cwd, ".git/index.lock")), "parallel private reads do not reserve the real index")
      f.git("add", "file")
      const externalIndex = readFileSync(join(f.cwd, ".git/index"))
      reading.resume.resolve()
      const closed = await promptly(closing)
      assert(dispatched, "the later provider starts after the earlier read is fixed")
      assert(closed.createdAt <= readingAt, "writer lookup includes the whole input-read interval")
      packing.resume.resolve()
      const started = await before
      assert.equal(f.git("--git-dir=" + join(f.storage, closed.id, "git"), "show", checkpoint(f.storage, closed.id) + ":file"), "closing", "the closing point excludes the later provider's write")
      assert.equal(f.git("--git-dir=" + join(f.storage, started.id, "git"), "show", checkpoint(f.storage, started.id) + ":file"), "closing")
      assert.equal(f.git("--git-dir=" + join(f.storage, started.id, "git"), "show", checkpoint(f.storage, started.id) + "^:file"), "staged", "concurrent staging cannot change either saved index")
      assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), externalIndex, "capture leaves the external staging change intact")
      console.log("PASS: input reads overlap, staging stays free, and later providers wait for earlier closing reads")
    } finally {
      for (const gate of gates) gate.resume.resolve()
      await Promise.allSettled(pending)
      store.abandonRun(id); store.abandonRun(next)
      store.close(); await git.close()
    }
  }

  for (const phase of ["add", "pack-objects"] as const) {
    const f = fixture("failure-" + phase), git = new CaptureGit()
    const store = new WorkspaceSnapshots(git, f.storage, { maxSnapshots: 1 })
    const seed = await store.capture(f.cwd), id = randomUUID(), gate = git.pause(phase)
    const failed = store.beginRun(id, f.cwd)
    const rejected = assert.rejects(failed, /sealing failed/)
    await gate.entered.promise
    store.abandonRun(id)
    gate.resume.reject(new Error("sealing failed"))
    try {
      await rejected
      const next = await promptly(store.capture(f.cwd))
      assert.notEqual(next.id, seed.id)
      assert(!existsSync(join(f.storage, seed.id)), "failed and abandoned captures release their borrow and result leases")
      assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), f.index)
      console.log("PASS: failure during " + phase + " releases ownership and cannot poison the next capture")
    } finally { store.close(); await git.close() }
  }

  for (const mode of ["public", "ended"] as const) {
    const folder = "group-" + mode
    mkdirSync(join(root, folder))
    const one = fixture(folder + "/one"), two = fixture(folder + "/two"), git = new CaptureGit()
    const storage = join(root, folder + "-store"), store = new WorkspaceSnapshots(git, storage, { maxSnapshots: 1 })
    const gate = git.pause("pack-objects", two.cwd)
    const turn = randomUUID()
    const whole = mode === "public" ? store.capture(join(root, folder)) : store.beginRun(turn, join(root, folder))
    const observed = whole.catch(() => undefined)
    const catalog = new DatabaseSync(join(storage, "snapshots.sqlite"), { readOnly: true })
    try {
      await gate.entered.promise
      let first: string | undefined
      const deadline = Date.now() + 5000
      while (!first) {
        const row = z.object({ id: z.string() }).optional().parse(catalog.prepare("SELECT id FROM snapshots WHERE json_extract(value, '$.scope')=?").get(one.cwd))
        first = row?.id
        assert(Date.now() < deadline, "the group's first part did not publish")
        if (!first) await new Promise((resolve) => setTimeout(resolve, 5))
      }
      const heldAt = Date.now()
      if (mode === "ended") await store.endRun(turn)
      await store.capture(one.cwd)
      assert(existsSync(join(storage, first)), "a group retains completed parts while another part is sealing, even after its run ends")
      gate.resume.resolve()
      const group = await whole
      assert(group.createdAt <= heldAt, "the group timestamp covers its earliest fixed inputs")
      assert("parts" in store.trees(group.id, group.id), "the completed group still reads every part")
      console.log("PASS: a partially published " + mode + " group leases its completed repository parts")
    } finally {
      gate.resume.resolve(); await observed
      catalog.close(); store.close(); await git.close()
    }
  }

  {
    const f = fixture("history-wave"), git = new Git(), store = new WorkspaceSnapshots(git, f.storage)
    const mark = Promise.withResolvers<{ id: string; at: string }>()
    let asks = 0
    store.followHistory({
      mark: () => { asks++; return mark.promise },
      since: async (_mark, roots) => ({ paths: [], lost: [...roots], ignored: [] }),
    })
    try {
      const captures = await Promise.all(Array.from({ length: 20 }, () => store.capture(f.cwd)))
      assert.equal(asks, 1, "a wave of captures shares one bounded history watermark instead of queueing twenty native replays")
      assert.equal(new Set(captures.map((part) => part.id)).size, 20)
      assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), f.index)
      console.log("PASS: a capture wave shares one bounded history read and falls back to fresh independent inputs")
    } finally {
      mark.resolve({ id: "0", at: "0" })
      store.close(); await git.close()
    }
  }

  {
    const cwd = join(root, "unborn"), storage = join(root, "unborn-store"), git = new Git()
    mkdirSync(cwd)
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd })
    writeFileSync(join(cwd, "file"), "first\n")
    const store = new WorkspaceSnapshots(git, storage)
    store.followHistory({
      mark: async () => ({ id: "0", at: "0" }),
      since: async () => ({ paths: [join(cwd, "file")], lost: [], ignored: [] }),
    })
    const id = randomUUID()
    try {
      await store.beginRun(id, cwd, () => {})
      await store.endRun(id)
      writeFileSync(join(cwd, "file"), "edited\n")
      const next = randomUUID(), before = await store.beginRun(next, cwd, () => {})
      const content = execFileSync("git", ["--git-dir=" + join(storage, before.id, "git"), "show", checkpoint(storage, before.id) + ":file"], { cwd, encoding: "utf8" })
      assert.equal(content, "edited\n", "an empty live index is initialized before applying an unborn increment, never over it")
      store.abandonRun(next)
      console.log("PASS: an unborn incremental checkpoint keeps its read-only captured content")
    } finally { store.abandonRun(id); store.close(); await git.close() }
  }

  for (const phase of ["update-index", "add", "pack-objects"] as const) {
    const f = fixture("crash-" + phase), git = new Git()
    let store = new WorkspaceSnapshots(git, f.storage)
    const baseline = await store.capture(f.cwd)
    store.close()
    const before = new Set(readdirSync(f.storage))
    const child = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "--crash", f.cwd, f.storage, phase], { encoding: "utf8" })
    assert.equal(child.status, 74, child.stderr)
    const orphan = readdirSync(f.storage).filter((id) => /^[a-f0-9-]{36}$/.test(id) && !before.has(id))
    assert.equal(orphan.length, 1, "a crash leaves exactly its unpublished payload")
    assert.equal(existsSync(join(f.cwd, ".git/index.lock")), phase === "update-index", "only a crash during the protected index copy leaves a reservation")
    store = new WorkspaceSnapshots(git, f.storage)
    try {
      const recovered = await store.capture(f.cwd)
      assert(!existsSync(join(f.storage, orphan[0]!)), "restart reclaims only the dead capture's private orphan")
      assert(existsSync(join(f.storage, baseline.id)), "a crash does not remove an earlier completed checkpoint")
      assert.notEqual(recovered.id, baseline.id)
      assert.deepEqual(readFileSync(join(f.cwd, ".git/index")), f.index)
      assert(!existsSync(join(f.cwd, ".git/index.lock")), "restart releases an abandoned index reservation")
      console.log("PASS: crash during " + phase + " recovers without losing committed checkpoints or staging")
    } finally { store.close(); await git.close() }
  }
} finally { rmSync(root, { recursive: true, force: true }) }
