import assert from "node:assert/strict"
import { mkdir, mkdtemp, realpath, rm, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const scratch = await realpath(await mkdtemp(join(tmpdir(), "mako-git-test-")))
// Tests read no person's Git config (signing, hooks, aliases) and name their own author.
await writeFile(join(scratch, "gitconfig"), "[init]\n\tdefaultBranch = main\n")
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: join(scratch, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
})

const git = await import("../dist/index.js")
const { parseStatus, openRepository, closeRepositories, run, text, remote, push, log, commitFiles, listFiles, grep, draftCommit, commitDraft, draftPullRequest, GitError, COMMIT_STYLE, sensitivePath } = git

let passed = 0
async function test(name, body) {
  await body()
  passed += 1
  console.log(`PASS: ${name}`)
}

async function repository(name) {
  const root = join(scratch, name)
  await mkdir(root, { recursive: true })
  await text({ cwd: root, args: ["init", "-q", "-b", "main"] })
  return root
}

const sh = (cwd, ...args) => text({ cwd, args })

/** The entries a fresh full read gives, for comparing with what a kept status says. */
async function fullEntries(root) {
  const result = await run({ cwd: root, args: ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--no-renames"] })
  return parseStatus(result.stdout).entries
}

try {
  await test("porcelain v2 parses headers, changes, conflicts, untracked files and non-UTF-8 names", () => {
    const records = [
      "# branch.oid 0123456789012345678901234567890123456789",
      "# branch.head feature",
      "# branch.upstream origin/feature",
      "# branch.ab +2 -3",
      "1 .M N... 100644 100644 100644 aaaa aaaa src/a b.ts",
      "1 A. N... 000000 100644 100644 0000 bbbb new.ts",
      "1 D. S..M 160000 000000 000000 cccc 0000 vendor/sub",
      "u UU N... 100644 100644 100644 100644 a b c conflicted.ts",
      "? notes.md",
    ]
    const bytes = Buffer.concat([Buffer.from(records.join("\0") + "\0"), Buffer.from("? caf"), Buffer.from([0xe9, 0]), Buffer.from("")])
    const { head, entries } = parseStatus(bytes)
    assert.deepEqual(head, { oid: "0123456789012345678901234567890123456789", branch: "feature", upstream: "origin/feature", ahead: 2, behind: 3 })
    assert.deepEqual(entries.map((entry) => [entry.path, entry.index, entry.worktree, entry.untracked, entry.conflicted, entry.submodule]), [
      ["src/a b.ts", null, "modified", false, false, false],
      ["new.ts", "added", null, false, false, false],
      ["vendor/sub", "deleted", null, false, false, true],
      ["conflicted.ts", "modified", "modified", false, true, false],
      ["notes.md", null, "added", true, false, false],
      ["caf\ufffd", null, "added", true, false, false],
    ])
    assert.deepEqual(entries.at(-1).raw, Buffer.from([0x63, 0x61, 0x66, 0xe9]), "a name that isn't UTF-8 keeps its bytes")
    assert.deepEqual(parseStatus(Buffer.from("# branch.oid (initial)\0# branch.head (detached)\0")).head, { oid: null, branch: null, upstream: null, ahead: 0, behind: 0 })
  })

  await test("a watched repository reads only changed paths, and always agrees with a full read", async () => {
    const root = await repository("incremental")
    await writeFile(join(root, "keep.txt"), "keep\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const repo = await openRepository(root)
    assert.equal(repo.root, root)
    const release = repo.watch()
    let seed = 7
    const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n }
    const names = ["a.txt", "b.txt", "dir/c.txt", "dir/deep/d.txt", "keep.txt", "ignored.log", "e f.txt"]
    let partial = 0
    const counted = []
    git.configureGit({ trace: (trace) => { if (trace.command === "status") counted.push(trace.args.includes("--") ? "partial" : "full") } })
    for (let step = 0; step < 120; step += 1) {
      const name = names[random(names.length)]
      const path = join(root, name)
      const touched = [name]
      switch (random(7)) {
        case 0:
        case 1:
          await mkdir(join(path, ".."), { recursive: true })
          await writeFile(path, `step ${step}\n`)
          break
        case 2:
          await unlink(path).catch(() => {})
          break
        case 3:
          await sh(root, "add", "-A", "--", name).catch(() => {})
          touched.push(".git/index")
          break
        case 4:
          await sh(root, "reset", "-q", "--", name).catch(() => {})
          touched.push(".git/index")
          break
        case 5:
          await writeFile(join(root, ".gitignore"), random(2) ? "*.log\n" : "")
          touched.splice(0, 1, ".gitignore")
          break
        case 6:
          await sh(root, "commit", "-qam", `step ${step}`).catch(() => {})
          touched.push(".git/index", ".git/refs/heads/main")
          break
      }
      repo.changed(touched)
      const kept = (await repo.status()).entries.map(({ raw: _raw, ...entry }) => entry)
      const fresh = (await fullEntries(root)).map(({ raw: _raw, ...entry }) => entry)
      assert.deepEqual(kept, fresh, `step ${step}: kept status matches a full read`)
    }
    partial = counted.filter((kind) => kind === "partial").length
    assert.ok(partial > 30, `most reads were limited to the changed paths (${partial} of ${counted.length})`)
    const before = counted.length
    await repo.status()
    await repo.status()
    assert.equal(counted.length, before, "with no change, status is answered from memory")
    git.configureGit({})
    release()
  })

  await test("Git's own folder: objects and locks are noise, the index and HEAD are not", async () => {
    const repo = await openRepository(join(scratch, "incremental"))
    const release = repo.watch()
    await repo.status()
    assert.equal(repo.changed([".git/objects/ab/cdef", ".git/index.lock", ".git/mako-index-1", ".git/FETCH_HEAD"]), false)
    assert.equal(repo.changed([".git/index"]), true)
    assert.equal(repo.changed([".git/refs/remotes/origin/main"]), true)
    release()
  })

  await test("a folder the watcher never hears is re-read on every status while Git sees files there", async () => {
    const root = await repository("unheard")
    await writeFile(join(root, "a.txt"), "a\n")
    await mkdir(join(root, "dist"))
    await writeFile(join(root, "dist", "out.js"), "1\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const repo = await openRepository(root)
    const release = repo.watch(["dist", "node_modules"])
    await repo.status()
    await writeFile(join(root, "dist", "out.js"), "2\n")
    assert.deepEqual((await repo.status()).entries.map((entry) => entry.path), ["dist/out.js"], "a tracked file in dist is read though nothing reported it")
    await sh(root, "rm", "-rq", "--cached", "dist")
    await writeFile(join(root, ".gitignore"), "dist/\n")
    await sh(root, "add", ".gitignore")
    await sh(root, "commit", "-qm", "ignore dist")
    repo.changed([".git/index"])
    await repo.status()
    await writeFile(join(root, "dist", "out.js"), "3\n")
    await writeFile(join(root, "a.txt"), "unreported\n")
    assert.deepEqual((await repo.status()).entries, [], "with dist ignored and untracked, the kept status is trusted again")
    release()
  })

  await test("a tracked build folder is re-read alone; the rest stays incremental", async () => {
    const root = await repository("tracked-build")
    await mkdir(join(root, "build"))
    await mkdir(join(root, "src"))
    await writeFile(join(root, "build", "icon.txt"), "1\n")
    await writeFile(join(root, "src", "a.ts"), "a\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const repo = await openRepository(root)
    const release = repo.watch(["build", "node_modules"])
    await repo.status()
    const reads = []
    git.configureGit({ trace: (trace) => { if (trace.command === "status") reads.push(trace.args.includes("--") ? trace.args.slice(trace.args.indexOf("--") + 1).join(" ") : "full") } })
    await writeFile(join(root, "build", "icon.txt"), "2\n")
    assert.deepEqual((await repo.status()).entries.map((entry) => entry.path), ["build/icon.txt"], "an unreported change in build is found")
    await writeFile(join(root, "src", "a.ts"), "b\n")
    repo.changed(["src/a.ts"])
    assert.deepEqual((await repo.status()).entries.map((entry) => entry.path), ["build/icon.txt", "src/a.ts"])
    assert.deepEqual(reads, [":(literal)build", ":(literal)src/a.ts :(literal)build"], "no full reads")
    assert.deepEqual((await repo.diagnose()).rereads, ["build"])
    git.configureGit({})
    release()
  })

  await test("diagnose shows a change no watcher reported, and nothing once it is", async () => {
    const root = await repository("doctor")
    await writeFile(join(root, "a.txt"), "a\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const repo = await openRepository(root)
    const release = repo.watch()
    await repo.status()
    await writeFile(join(root, "a.txt"), "changed\n")
    await writeFile(join(root, "new.txt"), "new\n")
    const drifted = await repo.diagnose()
    assert.equal(drifted.watchers, 1)
    assert.equal(drifted.pending, 0)
    assert.equal(drifted.heardAgoMs, null)
    assert.deepEqual(drifted.mismatches, [{ path: "a.txt", held: null, fresh: ".M" }, { path: "new.txt", held: null, fresh: "??" }])
    repo.changed(["a.txt", "new.txt"])
    const healed = await repo.diagnose()
    assert.equal(healed.pending, 2)
    assert.ok(healed.heardAgoMs !== null && healed.heardAgoMs < 5_000)
    assert.deepEqual(healed.mismatches, [])
    assert.equal(healed.held.head, healed.fresh.head)
    release()
  })

  await test("staging a staged deletion changes nothing; a path Git never knew still fails", async () => {
    const root = await repository("deletions")
    await writeFile(join(root, "gone.txt"), "x\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await sh(root, "rm", "-q", "gone.txt")
    const repo = await openRepository(root)
    await repo.stage(["gone.txt"])
    assert.equal(await sh(root, "diff", "--cached", "--name-status"), "D\tgone.txt")
    await assert.rejects(repo.stage(["never.txt"]), /did not match/)
  })

  await test("a repository is found once per folder, by any name for it, and a caller's abort is its own", async () => {
    const root = await repository("lookup")
    await mkdir(join(root, "sub"))
    const alias = join(scratch, "lookup-link")
    await (await import("node:fs/promises")).symlink(root, alias)
    const spawned = []
    git.configureGit({ trace: (trace) => spawned.push(trace.command) })
    const [aborted, ...found] = await Promise.allSettled([openRepository(join(alias, "sub"), AbortSignal.abort()), ...Array.from({ length: 10 }, () => openRepository(join(alias, "sub")))])
    assert.equal(aborted.status, "rejected")
    assert.ok(found.every((result) => result.status === "fulfilled" && result.value?.root === root))
    assert.equal(git.knownRepository(join(alias, "sub")), found[0].value, "once found, a folder resolves without waiting")
    assert.equal(git.knownRepository(alias), undefined, "another folder is looked up on its own")
    assert.equal(spawned.filter((command) => command === "rev-parse").length, 1, "ten callers share one lookup")
    git.configureGit({})
  })

  await test("previews: whole small files, patches for long ones, binary, untracked and commits", async () => {
    const root = await repository("previews")
    await writeFile(join(root, "small.txt"), "one\ntwo\n")
    await writeFile(join(root, "long.txt"), Array.from({ length: 3_000 }, (_, i) => `line ${i}`).join("\n") + "\n")
    await writeFile(join(root, "image.bin"), Buffer.from([0, 1, 2, 3]))
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await writeFile(join(root, "small.txt"), "one\nTWO\n")
    await writeFile(join(root, "long.txt"), Array.from({ length: 3_000 }, (_, i) => (i === 1500 ? "changed" : `line ${i}`)).join("\n") + "\n")
    await writeFile(join(root, "image.bin"), Buffer.from([0, 9, 9]))
    await writeFile(join(root, "untracked.txt"), Array.from({ length: 2_500 }, (_, i) => `u ${i}`).join("\n"))
    const repo = await openRepository(root)
    assert.deepEqual(await repo.preview("small.txt", { kind: "worktree" }), { kind: "files", before: "one\ntwo\n", after: "one\nTWO\n" })
    const long = await repo.preview("long.txt", { kind: "worktree" })
    assert.equal(long.kind, "patch")
    assert.match(long.patch, /^-line 1500\n\+changed$/m)
    assert.equal(long.limited, false)
    assert.deepEqual(await repo.preview("image.bin", { kind: "worktree" }), { kind: "binary", mime: null, before: { bytes: 4 }, after: { bytes: 3 } }, "a binary file shows each side's size")
    const untracked = await repo.preview("untracked.txt", { kind: "worktree" })
    assert.equal(untracked.kind, "patch")
    assert.equal(untracked.limited, true, "a patch past 1,000 lines is cut and says so")
    assert.equal(untracked.patch.split("\n").length - 1, 1_000)
    const [head] = await log(root, 1)
    assert.deepEqual(await repo.preview("small.txt", { kind: "commit", oid: head.oid }), { kind: "files", before: null, after: "one\ntwo\n" })
    assert.deepEqual(await commitFiles(root, head.oid), [{ path: "image.bin", change: "added", lines: null }, { path: "long.txt", change: "added", lines: { insertions: 3_000, deletions: 0 } }, { path: "small.txt", change: "added", lines: { insertions: 2, deletions: 0 } }])
    const many = await Promise.all(Array.from({ length: 40 }, () => repo.preview("small.txt", { kind: "commit", oid: head.oid })))
    assert.ok(many.every((preview) => preview.kind === "files"), "one object reader answers concurrent previews")
    assert.throws(() => repo.path("../outside"), GitError)
    assert.deepEqual((await listFiles(root)).sort(), ["image.bin", "long.txt", "small.txt", "untracked.txt"])
    assert.ok((await grep(root, "TWO", { caseSensitive: true })).includes("small.txt:2:TWO"))
  })

  await test("images carry both sides to show; a scope compares any commit with the working tree", async () => {
    const root = await repository("images")
    const pixel = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")
    await writeFile(join(root, "logo.png"), pixel)
    await writeFile(join(root, "notes.txt"), "first\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "first")
    const [first] = await log(root, 1)
    await writeFile(join(root, "notes.txt"), "second\n")
    await sh(root, "commit", "-qam", "second")
    await writeFile(join(root, "notes.txt"), "third\n")
    await writeFile(join(root, "logo.png"), Buffer.concat([pixel, Buffer.from([1])]))
    await writeFile(join(root, "big.png"), Buffer.alloc(5 * 1024 * 1024, 1))
    const repo = await openRepository(root)
    const logo = await repo.preview("logo.png", { kind: "worktree" })
    assert.equal(logo.kind, "binary")
    assert.equal(logo.mime, "image/png")
    assert.deepEqual([logo.before.bytes, logo.after.bytes], [pixel.length, pixel.length + 1])
    assert.ok(logo.before.image.equals(pixel) && logo.after.image.length === pixel.length + 1, "both images are read whole")
    assert.deepEqual(await repo.preview("big.png", { kind: "worktree" }), { kind: "binary", mime: "image/png", before: null, after: { bytes: 5 * 1024 * 1024 } }, "an image past 4 MB shows its size alone")
    assert.deepEqual(await repo.preview("notes.txt", { kind: "worktree" }), { kind: "files", before: "second\n", after: "third\n" })
    assert.deepEqual(await repo.preview("notes.txt", { kind: "since", oid: first.oid }), { kind: "files", before: "first\n", after: "third\n" }, "since a commit spans every commit after it and what isn't committed")
  })

  await test("a renamed file reads its earlier side where it was, whole or as one patch", async () => {
    const root = await repository("renamed")
    const long = Array.from({ length: 3_000 }, (_, line) => `line ${line}`).join("\n") + "\n"
    await writeFile(join(root, "old.txt"), "kept\n")
    await writeFile(join(root, "old-long.txt"), long)
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "first")
    const [first] = await log(root, 1)
    await sh(root, "mv", "old.txt", "new.txt")
    await sh(root, "mv", "old-long.txt", "new-long.txt")
    await writeFile(join(root, "new.txt"), "kept\nmoved\n")
    await writeFile(join(root, "new-long.txt"), long.replace("line 1500\n", "line 1500 moved\n"))
    const repo = await openRepository(root)
    const since = { kind: "since", oid: first.oid }
    assert.deepEqual(await repo.preview("new.txt", since), { kind: "files", before: null, after: "kept\nmoved\n" }, "without its old path a rename reads as new")
    assert.deepEqual(await repo.preview("new.txt", since, "old.txt"), { kind: "files", before: "kept\n", after: "kept\nmoved\n" })
    const patch = await repo.preview("new-long.txt", since, "old-long.txt")
    assert.equal(patch.kind, "patch")
    assert.match(patch.patch, /^rename from old-long\.txt$/m)
    assert.match(patch.patch, /^\+line 1500 moved$/m)
    assert.doesNotMatch(patch.patch, /^\+line 0$/m, "a large rename patches only what changed")
    await assert.rejects(repo.preview("new.txt", since, "../outside"), GitError)
  })

  await test("previews share one cache; a repository nobody uses is closed", async () => {
    const root = await repository("idle")
    await writeFile(join(root, "a.txt"), "a\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "a")
    const before = git.openRepositories()
    const repo = await openRepository(root)
    assert.equal(git.openRepositories(), before + 1)
    const [head] = await log(root, 1)
    await repo.preview("a.txt", { kind: "commit", oid: head.oid })
    const diagnosis = await repo.diagnose()
    assert.equal(diagnosis.previews.count, 1)
    assert.ok(diagnosis.previews.allBytes >= diagnosis.previews.bytes, "the shared budget counts every repository")
    const release = repo.watch()
    git.sweep(Date.now() + 10 * 60_000)
    assert.equal(await openRepository(root), repo, "a watched repository stays open")
    release()
    git.sweep(Date.now() + 10 * 60_000)
    const reopened = await openRepository(root)
    assert.notEqual(reopened, repo, "an idle one is closed and opened afresh")
    assert.equal((await reopened.diagnose()).previews.count, 0, "with nothing cached")
  })

  await test("discard puts files back as HEAD has them and keeps what it took in the stash", async () => {
    const root = await repository("discard")
    await writeFile(join(root, "edited.txt"), "original\n")
    await writeFile(join(root, "kept.txt"), "original\n")
    await writeFile(join(root, "removed.txt"), "original\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const repo = await openRepository(root)
    await assert.rejects(repo.discard(["edited.txt"], "Mako discarded edited.txt"), /no changes/, "a clean file has nothing to discard")
    await writeFile(join(root, "edited.txt"), "edited\n")
    await writeFile(join(root, "kept.txt"), "kept edit\n")
    await unlink(join(root, "removed.txt"))
    await writeFile(join(root, "staged.txt"), "staged new\n")
    await sh(root, "add", "staged.txt")
    await writeFile(join(root, "untracked.txt"), "untracked\n")
    const { stash } = await repo.discard(["edited.txt", "removed.txt", "staged.txt", "untracked.txt"], "Mako discarded 4 files")
    assert.match(stash, /^[0-9a-f]{40}$/)
    assert.deepEqual((await repo.status()).entries.map((entry) => entry.path), ["kept.txt"], "only the file left alone still shows a change")
    assert.equal(await sh(root, "show", ":edited.txt"), "original")
    assert.match(await sh(root, "stash", "list"), /Mako discarded 4 files/)
    await writeFile(join(root, "other.txt"), "made after\n")
    await sh(root, "stash", "push", "--quiet", "--include-untracked", "--", "other.txt")
    await repo.restoreDiscarded(stash)
    assert.equal(await sh(root, "stash", "list"), "stash@{0}: WIP on main: " + (await sh(root, "log", "-1", "--format=%h %s")), "undo pops its own entry, not the newest")
    assert.equal(await sh(root, "diff", "--cached", "--name-only"), "staged.txt", "and what was staged is staged again")
    assert.deepEqual((await repo.status()).entries.map((entry) => entry.path).sort(), ["edited.txt", "kept.txt", "removed.txt", "staged.txt", "untracked.txt"], "popping the stash brings every change back")
  })

  await test("changed since a branch: commits after it, uncommitted and untracked files", async () => {
    const root = await repository("since")
    await writeFile(join(root, "base.txt"), "base\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "base")
    await sh(root, "checkout", "-qb", "feature")
    await writeFile(join(root, "committed.txt"), "committed\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "feature")
    await writeFile(join(root, "base.txt"), "edited\n")
    await writeFile(join(root, "new.txt"), "new\n")
    const since = await git.changedSince(root, "main")
    assert.deepEqual(since.files, [
      { path: "base.txt", change: "modified", lines: { insertions: 1, deletions: 1 } },
      { path: "committed.txt", change: "added", lines: { insertions: 1, deletions: 0 } },
      { path: "new.txt", change: "added", lines: { insertions: 1, deletions: 0 } },
    ])
    assert.equal(since.base, (await sh(root, "rev-parse", "main")).trim())
    assert.equal(await git.changedSince(root, "no-such-branch"), null)
    assert.equal(await git.changedSince(root, "--output=x"), null, "a ref can't be an option")
  })

  await test("staging, unstaging and committing, before and after the first commit", async () => {
    const root = await repository("staging")
    const repo = await openRepository(root)
    await writeFile(join(root, "a.txt"), "a\n")
    await writeFile(join(root, "b.txt"), "b\n")
    await repo.stage(["a.txt"])
    assert.deepEqual((await repo.status()).entries.map((entry) => [entry.path, entry.index]), [["a.txt", "added"], ["b.txt", null]])
    await repo.unstage(["a.txt"])
    assert.ok((await repo.status()).entries.every((entry) => entry.untracked), "unstaging before the first commit leaves the file untracked")
    await repo.commit({ message: "Add both files\n" })
    assert.equal((await repo.status()).entries.length, 0, "a commit with nothing staged commits everything")
    await writeFile(join(root, "a.txt"), "a2\n")
    await repo.stageAll()
    await repo.unstageAll()
    assert.deepEqual((await repo.status()).entries.map((entry) => [entry.index, entry.worktree]), [[null, "modified"]])
    await repo.stage(["a.txt"])
    await repo.commit({ message: "Amend", amend: true })
    assert.equal((await log(root, 5)).length, 1, "amend rewrites the last commit")
    await assert.rejects(repo.commit({ message: "  " }), /Write a commit message/)
    await assert.rejects(repo.commit({ message: "bad\u0007" }), /control characters/)
    let finished = false
    const slow = repo.write(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); finished = true })
    await repo.settled()
    assert.ok(finished, "settled waits for queued writes")
    await slow
  })

  await test("remotes: fetch, fast-forward pull, publishing and pushing", async () => {
    const origin = join(scratch, "origin.git")
    await text({ cwd: scratch, args: ["init", "-q", "--bare", "-b", "main", origin] })
    const root = await repository("local")
    await writeFile(join(root, "a.txt"), "a\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await sh(root, "remote", "add", "origin", origin)
    const repo = await openRepository(root)
    await push(repo, "main")
    assert.equal((await repo.status()).head.upstream, "origin/main", "publishing sets the upstream")
    const peer = join(scratch, "peer")
    await text({ cwd: scratch, args: ["clone", "-q", origin, peer] })
    await writeFile(join(peer, "b.txt"), "b\n")
    await sh(peer, "add", ".")
    await sh(peer, "commit", "-qm", "peer")
    await sh(peer, "push", "-q")
    await remote(repo, "fetch", null)
    const status = await repo.status()
    assert.equal(status.head.behind, 1)
    await assert.rejects(remote(repo, "pull", { branch: "main", head: "0".repeat(40) }), /HEAD or branch changed/)
    await remote(repo, "pull", { branch: "main", head: status.head.oid })
    assert.equal((await repo.status()).head.behind, 0)
    await writeFile(join(root, "c.txt"), "c\n")
    await repo.commit({ message: "Add c" })
    await push(repo, "main")
    assert.equal((await repo.status()).head.ahead, 0)
    await assert.rejects(remote(repo, "abort", { branch: "main", head: (await repo.head()).oid }), /no operation to abort/)
  })

  /** A model that answers from the request, as a real one would, counting what it was asked. */
  function fakeModel(options = {}) {
    const calls = []
    return {
      calls,
      identity: options.identity ?? "fake",
      contextTokens: options.contextTokens ?? 16_000,
      async complete(request) {
        calls.push(request)
        if (options.tooLong && request.prompt.length > options.tooLong) throw Object.assign(new Error("too long"), { tooLong: true })
        const schema = JSON.stringify(request.schema)
        if (schema.includes('"summary"')) return JSON.stringify({ summary: `summary of ${request.prompt.length} bytes` })
        if (options.inspect && schema.includes('"inspect"') && !calls.some((call) => call.prompt.includes('"id":"inventory"'))) {
          return JSON.stringify({ action: "inspect", result: null, requests: [{ kind: "inventory", offset: 0, limit: 200 }], notes: "read the file list" })
        }
        if (schema.includes('"title"')) return JSON.stringify({ action: "finish", result: { title: "Add the greeting\nextra", body: "## Summary\n- Says hello" }, requests: [], notes: "" })
        return JSON.stringify({ action: "finish", result: { message: "Add the greeting" }, requests: [], notes: "" })
      },
    }
  }
  const tooLong = (error) => Boolean(error?.tooLong)

  await test("a commit draft describes exactly what is staged, and committing it commits that", async () => {
    const root = await repository("draft-staged")
    await writeFile(join(root, "base.txt"), "base\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await writeFile(join(root, "hello.txt"), "hello\n")
    await writeFile(join(root, "other.txt"), "not staged\n")
    await writeFile(join(root, ".env"), "SECRET=1\n")
    await sh(root, "add", "hello.txt", ".env")
    const repo = await openRepository(root)
    const model = fakeModel()
    const draft = await draftCommit(repo, { model, signal: AbortSignal.timeout(30_000) })
    assert.equal(draft.snapshot.scope, "staged")
    assert.equal(draft.message, "Add the greeting")
    assert.equal(draft.files, 2)
    assert.deepEqual(draft.warnings, ["1 sensitive file: metadata included, content withheld."])
    assert.equal(model.calls.length, 1, "evidence that fits one request takes one request")
    assert.ok(!model.calls[0].prompt.includes("SECRET"), "a sensitive file's content never reaches the model")
    assert.ok(model.calls[0].instructions.includes(COMMIT_STYLE), "the default style is the text Settings shows")
    const styled = fakeModel()
    await draftCommit(repo, { model: styled, style: "Use the past tense.", signal: AbortSignal.timeout(30_000) })
    assert.ok(styled.calls[0].instructions.includes("Use the past tense.") && !styled.calls[0].instructions.includes(COMMIT_STYLE), "a person's style replaces the default")
    await writeFile(join(root, "hello.txt"), "edited after the draft\n")
    await sh(root, "add", "hello.txt")
    await assert.rejects(commitDraft(repo, draft, "Add the greeting"), /Staged changes changed since this draft/)
    assert.equal((await log(root, 5)).length, 1, "nothing was committed")
    await writeFile(join(root, "hello.txt"), "hello\n")
    await sh(root, "add", "hello.txt")
    const fresh = await draftCommit(repo, { model: fakeModel(), signal: AbortSignal.timeout(30_000) })
    const oid = await commitDraft(repo, fresh, "Add the greeting")
    assert.equal(await sh(root, "show", "-s", "--format=%s", oid), "Add the greeting")
    assert.deepEqual((await repo.status()).entries.map((entry) => entry.path), ["other.txt"], "what wasn't staged stays out")
  })

  await test("a working-tree draft commits the files as drafted, or nothing once they change", async () => {
    const root = await repository("draft-worktree")
    await writeFile(join(root, "base.txt"), "base\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await writeFile(join(root, "base.txt"), "base 2\n")
    await writeFile(join(root, "new.txt"), "new\n")
    const repo = await openRepository(root)
    const draft = await draftCommit(repo, { model: fakeModel(), signal: AbortSignal.timeout(30_000) })
    assert.equal(draft.snapshot.scope, "working-tree")
    assert.equal((await repo.status()).entries.filter((entry) => entry.index).length, 0, "drafting stages nothing")
    await writeFile(join(root, "new.txt"), "changed since\n")
    await assert.rejects(commitDraft(repo, draft, "Update"), /changed since this draft/)
    assert.equal((await log(root, 5)).length, 1, "nothing was committed")
    const again = await draftCommit(repo, { model: fakeModel(), signal: AbortSignal.timeout(30_000) })
    await commitDraft(repo, again, "Update base and add new")
    assert.equal((await repo.status()).entries.length, 0)
    assert.equal((await log(root, 5))[0].subject, "Update base and add new")
  })

  await test("large evidence is summarized in pieces, retried smaller when too long, and inspected when deep", async () => {
    const root = await repository("draft-large")
    await writeFile(join(root, "seed.txt"), "seed\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    for (let file = 0; file < 30; file += 1) await writeFile(join(root, `file-${file}.txt`), Array.from({ length: 200 }, (_, line) => `file ${file} line ${line} ${"x".repeat(40)}`).join("\n"))
    await sh(root, "add", ".")
    const repo = await openRepository(root)
    const model = fakeModel({ contextTokens: 16_000 })
    const draft = await draftCommit(repo, { model, signal: AbortSignal.timeout(60_000) })
    const summaries = model.calls.filter((call) => JSON.stringify(call.schema).includes('"summary"')).length
    assert.ok(summaries > 1, `the evidence was summarized in ${summaries} requests`)
    assert.equal(draft.calls, model.calls.length)
    const cached = fakeModel({ contextTokens: 16_000 })
    await draftCommit(repo, { model: cached, signal: AbortSignal.timeout(60_000) })
    assert.equal(cached.calls.length, 1, "a second draft of the same evidence reuses every summary")
    const shrinking = fakeModel({ contextTokens: 16_000, identity: "shrinking", tooLong: 20_000 })
    await draftCommit(repo, { model: shrinking, tooLong, signal: AbortSignal.timeout(60_000) })
    assert.ok(shrinking.calls.some((call) => call.prompt.length > 20_000) && shrinking.calls.at(-1).prompt.length <= 20_000, "a too-long request halves the pieces and starts again")
    const deep = fakeModel({ identity: "deep", inspect: true })
    await draftCommit(repo, { model: deep, mode: "deep", signal: AbortSignal.timeout(60_000) })
    assert.ok(deep.calls.some((call) => call.prompt.includes('"id":"inventory"')), "a deep draft reads the inventory it asked for")
    assert.equal(deep.calls.at(-1).reasoning, "high")
  })

  await test("a pull request draft describes the branch's commits since its base", async () => {
    const root = await repository("draft-pull")
    await writeFile(join(root, "base.txt"), "base\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await sh(root, "switch", "-q", "-c", "feature")
    await writeFile(join(root, "hello.txt"), "hello\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "Add hello")
    await writeFile(join(root, "uncommitted.txt"), "not in the pull request\n")
    const repo = await openRepository(root)
    const model = fakeModel()
    const draft = await draftPullRequest(repo, "main", { model, style: "Use the template.", signal: AbortSignal.timeout(30_000) })
    assert.deepEqual([draft.title, draft.body, draft.commits, draft.files], ["Add the greeting", "## Summary\n- Says hello", 1, 1])
    assert.ok(model.calls[0].prompt.includes("Add hello") && !model.calls[0].prompt.includes("uncommitted"))
    assert.ok(model.calls[0].instructions.includes("Use the template."))
    await assert.rejects(draftPullRequest(repo, "nowhere", { model, signal: AbortSignal.timeout(30_000) }), /nowhere isn't here/)
    await sh(root, "switch", "-q", "main")
    await assert.rejects(draftPullRequest(repo, "main", { model, signal: AbortSignal.timeout(30_000) }), /no commits beyond main/)
  })

  await test("line counts cover staged, unstaged and untracked files, and count again only what changed", async () => {
    const root = await repository("lines")
    await writeFile(join(root, "a.txt"), "one\ntwo\nthree\n")
    await writeFile(join(root, "gone.txt"), "x\ny\n")
    await writeFile(join(root, "logo.bin"), Buffer.from([1, 0, 2]))
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const repo = await openRepository(root)
    const release = repo.watch()
    await writeFile(join(root, "a.txt"), "one\n2\nthree\nfour\n")
    await sh(root, "add", "a.txt")
    await writeFile(join(root, "a.txt"), "one\n2\nthree\nfour\nfive")
    await unlink(join(root, "gone.txt"))
    await writeFile(join(root, "logo.bin"), Buffer.from([1, 0, 3]))
    await writeFile(join(root, "new.md"), "# Title\n\nbody")
    repo.changed(["a.txt", "gone.txt", "logo.bin", "new.md", ".git/index"])
    const counted = []
    git.configureGit({ trace: (trace) => { if (trace.command === "diff") counted.push(trace.args.filter((arg) => arg.startsWith(":(literal)"))) } })
    let counts = await repo.lineCounts(await repo.status())
    assert.deepEqual(Object.fromEntries(counts), {
      "a.txt": { insertions: 3, deletions: 1 },
      "gone.txt": { insertions: 0, deletions: 2 },
      "logo.bin": null,
      "new.md": { insertions: 3, deletions: 0 },
    })
    await sh(root, "add", "-A")
    repo.changed([".git/index"])
    counts = await repo.lineCounts(await repo.status())
    assert.equal(counted.length, 1, "staging changes no file, so nothing is counted again")
    assert.deepEqual(counts.get("new.md"), { insertions: 3, deletions: 0 })
    await writeFile(join(root, "new.md"), "# Title\n")
    repo.changed(["new.md"])
    counts = await repo.lineCounts(await repo.status())
    assert.deepEqual(counted.at(-1), [":(literal)new.md"], "only the changed file is counted again")
    assert.deepEqual(counts.get("new.md"), { insertions: 1, deletions: 0 })
    await sh(root, "commit", "-qam", "next")
    repo.changed([".git/HEAD", ".git/index"])
    counts = await repo.lineCounts(await repo.status())
    assert.equal(counts.size, 0, "a new HEAD counts against itself")
    const files = await commitFiles(root, "HEAD")
    assert.deepEqual(files.map((file) => [file.path, file.lines]), [["a.txt", { insertions: 3, deletions: 1 }], ["gone.txt", { insertions: 0, deletions: 2 }], ["logo.bin", null], ["new.md", { insertions: 1, deletions: 0 }]])
    git.configureGit({})
    release()
  })

  await test("two trees compare through object stores outside the repository", async () => {
    const root = await repository("trees")
    await writeFile(join(root, "a.txt"), "one\n")
    await writeFile(join(root, "gone.txt"), "x\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    const from = await sh(root, "rev-parse", "HEAD^{tree}")
    // A tree written only to a private store, as a checkpoint is.
    const store = join(scratch, "trees-store")
    await mkdir(store, { recursive: true })
    const env = { GIT_OBJECT_DIRECTORY: store, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, ".git/objects"), GIT_INDEX_FILE: join(scratch, "trees-index") }
    await writeFile(join(root, "a.txt"), "one\ntwo\n")
    await writeFile(join(root, "new.md"), "# New\n")
    await unlink(join(root, "gone.txt"))
    await text({ cwd: root, args: ["read-tree", "HEAD"], env })
    await text({ cwd: root, args: ["add", "-A"], env })
    const to = await text({ cwd: root, args: ["write-tree"], env })
    await assert.rejects(new git.TreeComparison({ root, from, to }).files(), "without the store, the tree isn't there")
    const compared = new git.TreeComparison({ root, from, to, stores: [store] })
    assert.deepEqual(await compared.files(), [
      { path: "a.txt", change: "modified", lines: { insertions: 1, deletions: 0 } },
      { path: "gone.txt", change: "deleted", lines: { insertions: 0, deletions: 1 } },
      { path: "new.md", change: "added", lines: { insertions: 1, deletions: 0 } },
    ])
    assert.deepEqual(await compared.preview("a.txt"), { kind: "files", before: "one\n", after: "one\ntwo\n" })
    assert.deepEqual(await compared.preview("new.md"), { kind: "files", before: null, after: "# New\n" })
    assert.throws(() => compared.preview("../outside"), GitError)
    compared.close()
  })

  await test("the default branch is read from the repository when no host names it", async () => {
    const root = await repository("default-branch")
    await writeFile(join(root, "a.txt"), "a\n")
    await sh(root, "add", ".")
    await sh(root, "commit", "-qm", "init")
    await sh(root, "branch", "-M", "trunk")
    assert.equal(await git.defaultBranch(root), null, "trunk is no name Git suggests")
    await sh(root, "config", "init.defaultBranch", "trunk")
    assert.equal(await git.defaultBranch(root), "trunk")
    await sh(root, "branch", "main")
    await sh(root, "config", "--unset", "init.defaultBranch")
    assert.equal(await git.defaultBranch(root), "main")
    await sh(root, "update-ref", "refs/remotes/origin/develop", "HEAD")
    await sh(root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop")
    assert.equal(await git.defaultBranch(root), "develop", "origin's HEAD wins")
  })

  await test("sensitive names", () => {
    for (const path of [".env", "app/.env.local", "id_rsa", "keys/server.pem", "tls.key", "credentials.json"]) assert.ok(sensitivePath(path), path)
    for (const path of ["env.ts", "src/key.ts", "docs/secrets.md"]) assert.ok(!sensitivePath(path), path)
  })
} finally {
  closeRepositories()
  await rm(scratch, { recursive: true, force: true })
}
console.log(`${passed} @mako/git tests passed`)
