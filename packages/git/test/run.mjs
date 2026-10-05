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
    assert.deepEqual(await repo.preview("image.bin", { kind: "worktree" }), { kind: "binary" })
    const untracked = await repo.preview("untracked.txt", { kind: "worktree" })
    assert.equal(untracked.kind, "patch")
    assert.equal(untracked.limited, true, "a patch past 1,000 lines is cut and says so")
    assert.equal(untracked.patch.split("\n").length - 1, 1_000)
    const [head] = await log(root, 1)
    assert.deepEqual(await repo.preview("small.txt", { kind: "commit", oid: head.oid }), { kind: "files", before: null, after: "one\ntwo\n" })
    assert.deepEqual(await commitFiles(root, head.oid), [{ path: "image.bin", change: "added" }, { path: "long.txt", change: "added" }, { path: "small.txt", change: "added" }])
    const many = await Promise.all(Array.from({ length: 40 }, () => repo.preview("small.txt", { kind: "commit", oid: head.oid })))
    assert.ok(many.every((preview) => preview.kind === "files"), "one object reader answers concurrent previews")
    assert.throws(() => repo.path("../outside"), GitError)
    assert.deepEqual((await listFiles(root)).sort(), ["image.bin", "long.txt", "small.txt", "untracked.txt"])
    assert.ok((await grep(root, "TWO", { caseSensitive: true })).includes("small.txt:2:TWO"))
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

  await test("sensitive names", () => {
    for (const path of [".env", "app/.env.local", "id_rsa", "keys/server.pem", "tls.key", "credentials.json"]) assert.ok(sensitivePath(path), path)
    for (const path of ["env.ts", "src/key.ts", "docs/secrets.md"]) assert.ok(!sensitivePath(path), path)
  })
} finally {
  closeRepositories()
  await rm(scratch, { recursive: true, force: true })
}
console.log(`${passed} @mako/git tests passed`)
