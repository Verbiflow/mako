import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import { HostJobs } from "@mako/host/base/host-jobs"
import type { LiveBatch } from "@mako/host/contracts/live-conversations"
import { openAttribution, type TreeWatcher } from "@mako/host/attribution/index"
import { resolveSpelling, type Place, type ReferenceContext, type Touch } from "@mako/host/files/resolve"
import { SuffixIndex } from "@mako/host/files/suffix-index"
import { RenameHistory } from "@mako/host/files/git-renames"
import { movedPathsNotice } from "@mako/host/workspaces/thread-worktree-moves"

/*
 * Which file a spelling in an answer means (step 17, the Thread's files):
 * one table row per cause the file-reference audit found, then the same
 * questions through a real journal. Synthetic paths and scratch repositories.
 */

test("the suffix index finds whole trailing segments, and agrees with a scan through adds, removes and folds", () => {
  const index = SuffixIndex.of(["src/index.ts", "src/myindex.ts", "packages/a/src/index.ts", "README.md"])
  assert.deepEqual(index.find("index.ts").sort(), ["packages/a/src/index.ts", "src/index.ts"])
  assert.deepEqual(index.find("a/src/index.ts"), ["packages/a/src/index.ts"])
  assert.deepEqual(index.find("nothing.ts"), [])
  assert.deepEqual(index.find("src/index.ts", 50, true), ["src/index.ts"], "exact matches only the whole path")

  // Random paths against a plain scan, through enough changes to fold more than once.
  let seed = 7
  const random = (n: number) => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648), seed % n)
  const words = ["src", "lib", "index", "app", "a", "b", "test", "utils"]
  const make = () => Array.from({ length: 1 + random(4) }, () => words[random(words.length)]).join("/") + [".ts", ".md", ".json"][random(3)]
  const live = new Set(Array.from({ length: 2_000 }, make))
  const big = SuffixIndex.of(live)
  for (let i = 0; i < 3_000; i++) {
    const path = make()
    if (random(3) === 0 && live.has(path)) {
      live.delete(path)
      big.remove(path)
    } else {
      live.add(path)
      big.add(path)
    }
  }
  assert.equal(big.size, live.size)
  for (let i = 0; i < 300; i++) {
    const parts = make().split("/")
    const suffix = parts.slice(-1 - random(parts.length)).join("/")
    const expected = [...live].filter((path) => path === suffix || path.endsWith(`/${suffix}`)).sort()
    assert.deepEqual(big.find(suffix, 10_000).sort(), expected, suffix)
  }
})

const at = (minutes: number) => 1_700_000_000_000 + minutes * 60_000
const touch = (kind: Touch["kind"], minutes: number): Touch => ({ kind, at: at(minutes) })

function context(fields: Partial<ReferenceContext> & { files?: Record<string, string[]> }): ReferenceContext {
  const places = (fields.places ?? []).map((place) => {
    const files = fields.files?.[place.root]
    return files ? { ...place, index: SuffixIndex.of(files) } : place
  })
  return { folders: [], touched: new Map(), renamed: () => undefined, home: "/home/u", ...fields, places }
}

const exists = (...paths: string[]) => (path: string) => paths.includes(path)

test("each cause the audit found resolves to the file meant, a chooser, or plain text", async (t) => {
  const repo: Place = { root: "/w/mako", name: "mako", repository: "/w/mako/.git", current: true }

  await t.test("`../` from a sub-folder a call ran in", () => {
    const answer = resolveSpelling("../host/src/index.ts", context({ folders: ["/w/mako/packages/sessions", "/w/mako"], places: [repo] }), exists("/w/mako/packages/host/src/index.ts"))
    assert.equal(answer.kind === "file" && answer.file.path, "/w/mako/packages/host/src/index.ts")
    assert.equal(answer.kind === "file" && answer.file.reason, "from-folder")
  })

  await t.test("renamed since: the file's name now", () => {
    const answer = resolveSpelling("electron/acp.ts", context({
      folders: ["/w/mako"],
      places: [repo],
      renamed: (path) => (path === "/w/mako/electron/acp.ts" ? "/w/mako/packages/host/src/harnesses/acp.ts" : undefined),
    }), exists("/w/mako/packages/host/src/harnesses/acp.ts"))
    assert.deepEqual(answer.kind === "file" && [answer.file.path, answer.file.reason, answer.file.was], ["/w/mako/packages/host/src/harnesses/acp.ts", "renamed", "/w/mako/electron/acp.ts"])
  })

  await t.test("in a worktree since removed: the same file where the Thread works now", () => {
    const gone: Place = { root: "/w/.mako/worktrees/p/t/mako", name: "mako", current: false, gone: true }
    const answer = resolveSpelling("/w/.mako/worktrees/p/t/mako/src/app.ts", context({ places: [repo, gone] }), exists("/w/mako/src/app.ts"))
    assert.deepEqual(answer.kind === "file" && [answer.file.path, answer.file.reason], ["/w/mako/src/app.ts", "twin"])
  })

  await t.test("a worktree's file, not the main checkout's copy", () => {
    const main: Place = { root: "/w/mako", name: "mako", repository: "/w/mako/.git", current: false }
    const tree: Place = { root: "/w/.mako/worktrees/p/t/mako", name: "mako", repository: "/w/mako/.git", current: true }
    const answer = resolveSpelling("/w/mako/src/app.ts", context({ places: [main, tree] }), exists("/w/mako/src/app.ts", "/w/.mako/worktrees/p/t/mako/src/app.ts"))
    assert.equal(answer.kind === "file" && answer.file.path, "/w/.mako/worktrees/p/t/mako/src/app.ts")
  })

  await t.test("several match a partial path; the one the Thread touched wins", () => {
    const answer = resolveSpelling("harnesses/index.ts", context({
      places: [repo],
      files: { "/w/mako": ["packages/sessions/src/harnesses/index.ts", "packages/host/src/harnesses/index.ts"] },
      touched: new Map([["/w/mako/packages/host/src/harnesses/index.ts", touch("read", 3)]]),
    }), exists("/w/mako/packages/sessions/src/harnesses/index.ts", "/w/mako/packages/host/src/harnesses/index.ts"))
    assert.deepEqual(answer.kind === "file" && [answer.file.path, answer.file.reason], ["/w/mako/packages/host/src/harnesses/index.ts", "touched"])
  })

  await t.test("several match and nothing tells them apart: a chooser, shortest first", () => {
    const answer = resolveSpelling("harnesses/index.ts", context({
      places: [repo],
      files: { "/w/mako": ["packages/sessions/src/harnesses/index.ts", "src/harnesses/index.ts"] },
    }), exists("/w/mako/packages/sessions/src/harnesses/index.ts", "/w/mako/src/harnesses/index.ts"))
    assert.equal(answer.kind, "choice")
    assert.deepEqual(answer.kind === "choice" && answer.candidates.map((file) => [file.path, file.place?.folder]), [
      ["/w/mako/src/harnesses/index.ts", "src/harnesses"],
      ["/w/mako/packages/sessions/src/harnesses/index.ts", "packages/sessions/src/harnesses"],
    ])
  })

  await t.test("a bare name links through the Thread's touches, or as the one file of that name where it works now", () => {
    const touched = context({ touched: new Map([["/w/mako/packages/host/src/attribution/tracker.ts", touch("wrote", 1)]]), places: [repo] })
    const linked = resolveSpelling("tracker.ts:932", touched, exists("/w/mako/packages/host/src/attribution/tracker.ts"))
    assert.equal(linked.kind === "file" && linked.file.path, "/w/mako/packages/host/src/attribution/tracker.ts")
    const only = resolveSpelling("pane-composer.tsx", context({ places: [repo], files: { "/w/mako": ["src/components/composer/pane-composer.tsx"] } }), exists("/w/mako/src/components/composer/pane-composer.tsx"))
    assert.deepEqual(only.kind === "file" && [only.file.path, only.file.reason], ["/w/mako/src/components/composer/pane-composer.tsx", "only-match"])
    const two = resolveSpelling("index.ts", context({ places: [repo], files: { "/w/mako": ["a/index.ts", "b/index.ts"] } }), exists("/w/mako/a/index.ts", "/w/mako/b/index.ts"))
    assert.equal(two.kind, "none", "a common name the Thread never touched stays text, never a chooser")
    const elsewhere = resolveSpelling("app.ts", context({ places: [{ ...repo, current: false }], files: { "/w/mako": ["app.ts"] } }), exists("/w/mako/app.ts"))
    assert.equal(elsewhere.kind, "none", "nor the one file of that name in a checkout it left")
    const fromFolder = resolveSpelling("package.json", context({
      folders: ["/w/mako/apps/gateway", "/w/mako"],
      touched: new Map([["/w/mako/package.json", touch("read", 9)], ["/w/mako/apps/gateway/package.json", touch("read", 1)]]),
    }), exists("/w/mako/package.json", "/w/mako/apps/gateway/package.json"))
    assert.equal(fromFolder.kind === "file" && fromFolder.file.path, "/w/mako/apps/gateway/package.json", "the one it touched in the folder it last worked in, over a later touch elsewhere")
  })

  await t.test("of two files touched the same way, the latest; a write over a read", () => {
    const both = context({
      places: [repo],
      touched: new Map([["/w/mako/a/notes.md", touch("read", 9)], ["/w/mako/b/notes.md", touch("wrote", 1)], ["/w/mako/c/notes.md", touch("wrote", 5)]]),
    })
    const answer = resolveSpelling("notes.md", both, exists("/w/mako/a/notes.md", "/w/mako/b/notes.md", "/w/mako/c/notes.md"))
    assert.equal(answer.kind === "file" && answer.file.path, "/w/mako/c/notes.md")
  })

  await t.test("deleted since, or never a file: plain text", () => {
    assert.equal(resolveSpelling("src/gone.ts", context({ folders: ["/w/mako"], places: [repo] }), exists()).kind, "none")
    assert.equal(resolveSpelling("~/.cursor/sdk/auth.json", context({}), exists()).kind, "none")
  })

  await t.test("a full path that exists, and `~/`", () => {
    const answer = resolveSpelling("~/notes/today.md#L3-L9", context({}), exists("/home/u/notes/today.md"))
    assert.deepEqual(answer.kind === "file" && [answer.file.path, answer.file.reason], ["/home/u/notes/today.md", "absolute"])
  })

  await t.test("a file the person picked stands, with the rest kept to pick again, and follows a later rename", () => {
    const tie = { places: [repo], files: { "/w/mako": ["packages/sessions/src/harnesses/index.ts", "src/harnesses/index.ts"] } }
    const both = exists("/w/mako/packages/sessions/src/harnesses/index.ts", "/w/mako/src/harnesses/index.ts")
    const chosen = new Map([["harnesses/index.ts", "/w/mako/packages/sessions/src/harnesses/index.ts"]])
    const answer = resolveSpelling("harnesses/index.ts:12", context({ ...tie, chosen }), both)
    assert.deepEqual(answer.kind === "file" && [answer.file.path, answer.file.reason, answer.others?.map((file) => file.path)], [
      "/w/mako/packages/sessions/src/harnesses/index.ts", "chosen", ["/w/mako/src/harnesses/index.ts"],
    ])
    const bare = resolveSpelling("notes.md", context({ chosen: new Map([["notes.md", "/w/mako/b/notes.md"]]) }), exists("/w/mako/b/notes.md"))
    assert.equal(bare.kind === "file" && bare.file.reason, "chosen", "a bare name the person picked links without a touch")
    const renamed = resolveSpelling("notes.md", context({
      chosen: new Map([["notes.md", "/w/mako/b/notes.md"]]),
      renamed: (path) => (path === "/w/mako/b/notes.md" ? "/w/mako/b/journal.md" : undefined),
    }), exists("/w/mako/b/journal.md"))
    assert.equal(renamed.kind === "file" && renamed.file.path, "/w/mako/b/journal.md")
    const gone = resolveSpelling("harnesses/index.ts", context({ ...tie, chosen: new Map([["harnesses/index.ts", "/w/mako/deleted/index.ts"]]) }), both)
    assert.equal(gone.kind, "choice", "a pick whose file is gone asks again")
  })
})

test("Git's renames: followed from a time on, through chains, each read once however often it's added", () => {
  const log = [
    "\u00002000", "", "R100\tlib/b.ts\tlib/c.ts", "R087\t\"we\\tird\"\tx.ts",
    "\u00001000", "", "R100\ta.ts\tlib/b.ts", "M\tother.ts",
  ].join("\n")
  const history = new RenameHistory().add(log).add(log)
  assert.equal(history.size, 2, "the quoted path is left out, and a second read of the same commits adds nothing")
  assert.equal(history.follow("a.ts", 0), "lib/c.ts", "a then b then c")
  assert.equal(history.follow("a.ts", 1_000_001), undefined, "renamed before the answer: the spelling meant a later file of that name")
  assert.equal(history.follow("lib/b.ts", 1_500_000), "lib/c.ts")
  assert.equal(history.follow("other.ts", 0), undefined)
  history.add("\u00003000\n\nR100\tlib/c.ts\ta.ts")
  assert.equal(history.follow("a.ts", 0), undefined, "renamed away and back: it's at its own name again")
  assert.equal(history.follow("lib/b.ts", 1_500_000), "a.ts")
  const swap = new RenameHistory().add("\u00005000\n\nR100\tx.ts\ty.ts\nR100\ty.ts\tz.ts")
  assert.equal(swap.follow("x.ts", 0), "y.ts", "two renames in one commit happen at once, so they're no chain")
})

test("through a real journal: a Thread's renamed file resolves to its name now, and a bare name it edited links", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-references-")))
  const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  run("init", "-q", "-b", "main")
  run("config", "user.email", "test@example.com")
  run("config", "user.name", "Test")
  writeFileSync(join(repo, "old.ts"), "export const a = 1\n")
  writeFileSync(join(repo, "other.ts"), "export const b = 1\n")
  run("add", "-A")
  run("commit", "-q", "-m", "base")
  const listeners = new Set<(paths: string[]) => void>()
  const watched: string[] = []
  const watch: TreeWatcher = (root, changed) => {
    watched.push(root)
    listeners.add(changed)
    return { ready: Promise.resolve(), close: () => listeners.delete(changed) }
  }
  const emit = (...paths: string[]) => { for (const changed of listeners) changed(paths) }
  const userRoot = mkdtempSync(join(tmpdir(), "mako-file-references-user-"))
  const journal = await openAttribution({
    dataRoot: userRoot,
    userRoot,
    label: "test",
    git: new Git(),
    watch,
    jobs: new HostJobs(),
    stores: () => [],
    placement: (id) => (id === "c1" ? { thread: "T1", session: "S1" } : undefined),
    session: (id) => (id === "c1" ? { cwd: repo, harness: "claude", record: join(userRoot, "c1.jsonl") } : undefined),
  })
  let revision = 0
  let checkout: string | undefined
  const batch = (fields: Partial<LiveBatch>): LiveBatch => ({ id: "c1", revision: ++revision, updates: [], ...fields })
  try {
    journal.live(batch({ sessionChanges: { status: "running" } }))
    await Promise.all([journal.track(repo), journal.track(repo)])
    await journal.settled()
    assert.equal(watched.filter((root) => root === repo).length, 1, "a folder tracked by several callers at once is watched once, so each change is journaled once")
    const before = await journal.resolveFiles({ liveId: "c1" }, ["old.ts", "other.ts", "missing.ts"])
    assert.deepEqual(before.map((answer) => answer.kind === "file" ? answer.file.reason : answer.kind), ["only-match", "only-match", "none"], "a bare name the Thread hasn't touched links as the one file of that name in its checkout")

    // The Thread edits `old.ts`, then it's renamed with an edit in the same burst.
    const old = join(repo, "old.ts")
    journal.live(batch({ updates: [{ kind: "tool", id: "t1", title: "Edit", name: "Edit", status: "in_progress", input: JSON.stringify({ file_path: old, old_string: "1", new_string: "2" }) }] }))
    writeFileSync(old, "export const a = 2\n")
    emit(old)
    journal.live(batch({ updates: [{ kind: "tool-update", id: "t1", status: "completed", output: "ok", effects: [{ kind: "modify", path: old, edits: [{ old: "1", new: "2" }] }] }] }))
    await journal.settled()
    const named = await journal.resolveFiles({ liveId: "c1" }, ["old.ts", "old.ts:1"])
    assert.deepEqual(named.map((answer) => answer.kind === "file" && answer.file.path), [old, old])

    renameSync(old, join(repo, "renamed.ts"))
    emit(old, join(repo, "renamed.ts"))
    await journal.settled()
    const [after] = await journal.resolveFiles({ liveId: "c1" }, ["old.ts"])
    assert.deepEqual(after?.kind === "file" && [after.file.path, after.file.reason], [join(repo, "renamed.ts"), "renamed"], "the name now, through the journal's rename")
    const [partial] = await journal.resolveFiles({ liveId: "c1" }, [`${repo.split("/").at(-1)}/renamed.ts`])
    assert.equal(partial?.kind === "file" && partial.file.path, join(repo, "renamed.ts"), "found by the end of its path in the journal's index")

    // Renamed again with an edit in the same burst: the content differs, so only the file's ID ties the two.
    const final = join(repo, "lib-final.ts")
    renameSync(join(repo, "renamed.ts"), final)
    writeFileSync(final, "export const a = 3\nexport const more = true\n")
    emit(join(repo, "renamed.ts"), final)
    await journal.settled()
    const [twice] = await journal.resolveFiles({ liveId: "c1" }, ["old.ts"])
    assert.deepEqual(twice?.kind === "file" && [twice.file.path, twice.file.reason], [final, "renamed"], "followed through a rename and an edit in one burst")

    // The Thread reads a file Git ignores and one in its dependencies, then moves to another checkout of the repository.
    const env = join(repo, ".env.local")
    const dependency = join(repo, "node_modules", "x", "index.js")
    writeFileSync(env, "A=1\n")
    mkdirSync(join(repo, "node_modules", "x"), { recursive: true })
    writeFileSync(dependency, "\n")
    journal.live(batch({ updates: [{ kind: "tool", id: "t2", title: "Read", name: "Read", status: "in_progress", input: JSON.stringify({ file_path: env }) }] }))
    const other = join(repo, "other.ts")
    journal.live(batch({ updates: [{ kind: "tool-update", id: "t2", status: "completed", output: "ok", effects: [{ kind: "read", path: env }, { kind: "read", path: dependency }, { kind: "read", path: other }] }] }))
    // After its turn, someone else renames a file it read.
    journal.live(batch({ sessionChanges: { status: "ready" } }))
    renameSync(other, join(repo, "lib-other.ts"))
    emit(other, join(repo, "lib-other.ts"))
    await journal.settled()
    checkout = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-references-checkout-")))
    execFileSync("git", ["clone", "-q", repo, checkout])
    for (const name of ["lib-final.ts", "lib-other.ts"]) writeFileSync(join(checkout, name), "export {}\n")
    assert.deepEqual(await journal.movedPaths("T1", repo, checkout), {
      root: { from: repo, to: checkout },
      // `renamed.ts` became `lib-final.ts` during its turn but by none of its calls, so it's told; `old.ts`, the same file, isn't told twice.
      renamed: [{ was: other, now: join(checkout, "lib-other.ts") }, { was: join(repo, "renamed.ts"), now: join(checkout, "lib-final.ts") }],
      stayed: [env],
      more: 0,
    }, "the notice names renames none of the agent's calls made, each file once by its latest spelling, and the file that stayed, never dependencies")
    assert.equal(await journal.movedPaths("T1", repo, join(repo, "node_modules")), undefined, "a folder inside the same checkout is no move")
    assert.equal(movedPathsNotice({ root: { from: "/a/mako", to: "/w/mako" }, renamed: [{ was: "/a/mako/old.ts", now: "/w/mako/new.ts" }], stayed: ["/a/mako/.env.local"], more: 2 }), [
      "Paths under /a/mako are under /w/mako now.",
      "",
      "Renamed since you last used them:",
      "- /a/mako/old.ts is /w/mako/new.ts now",
      "",
      "Still only in /a/mako, not on this branch:",
      "- /a/mako/.env.local",
      "…and 2 more.",
    ].join("\n"))
  } finally {
    await journal.close()
    if (checkout) rmSync(checkout, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
    rmSync(userRoot, { recursive: true, force: true })
  }
})

test("through a real journal: renames from before tracking come from Git, an answer means what it meant when written, and a pick holds", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "mako-file-references-history-")))
  const hour = 3_600_000
  const base = Math.floor((Date.now() - 48 * hour) / 1_000) * 1_000
  const run = (args: string[], at?: number) =>
    execFileSync("git", args, { cwd: repo, stdio: "ignore", env: { ...process.env, ...(at && { GIT_AUTHOR_DATE: `@${at / 1_000}`, GIT_COMMITTER_DATE: `@${at / 1_000}` }) } })
  run(["init", "-q", "-b", "main"])
  run(["config", "user.email", "test@example.com"])
  run(["config", "user.name", "Test"])
  mkdirSync(join(repo, "src"))
  mkdirSync(join(repo, "a", "src"), { recursive: true })
  mkdirSync(join(repo, "b", "src"), { recursive: true })
  writeFileSync(join(repo, "src", "before.ts"), "export const kept = 'a line long enough that Git sees the rename'\n")
  for (const side of ["a", "b"]) writeFileSync(join(repo, side, "src", "dup.ts"), `export const side = "${side}"\n`)
  run(["add", "-A"])
  run(["commit", "-q", "-m", "base"], base)
  run(["mv", "src/before.ts", "src/after.ts"])
  run(["commit", "-q", "-m", "rename"], base + 2 * hour)
  const userRoot = mkdtempSync(join(tmpdir(), "mako-file-references-history-user-"))
  const journal = await openAttribution({
    dataRoot: userRoot,
    userRoot,
    label: "test",
    git: new Git(),
    watch: () => ({ ready: Promise.resolve(), close: () => undefined }),
    jobs: new HostJobs(),
    stores: () => [],
    placement: (id) => (id === "c1" ? { thread: "T1", session: "S1" } : undefined),
    session: (id) => (id === "c1" ? { cwd: repo, harness: "claude", record: join(userRoot, "c1.jsonl") } : undefined),
  })
  let revision = 0
  const batch = (fields: Partial<LiveBatch>): LiveBatch => ({ id: "c1", revision: ++revision, updates: [], ...fields })
  const first = async (asOf: number | undefined, spelling: string) => (await journal.resolveFiles({ liveId: "c1", ...(asOf !== undefined && { asOf }) }, [spelling]))[0]
  try {
    journal.live(batch({ sessionChanges: { status: "running" } }))
    await journal.track(repo)
    await journal.settled()

    // Written between the commits: `src/before.ts` was that file, renamed before Mako tracked the folder.
    const written = base + hour
    assert.equal((await first(written, "src/before.ts"))?.kind, "none", "the first answer doesn't wait for Git's history")
    let then = await first(written, "src/before.ts")
    for (let i = 0; i < 50 && then?.kind !== "file"; i++) {
      await new Promise((done) => setTimeout(done, 100))
      then = await first(written, "src/before.ts")
    }
    assert.deepEqual(then?.kind === "file" && [then.file.path, then.file.reason, then.file.was], [join(repo, "src", "after.ts"), "renamed", join(repo, "src", "before.ts")])
    assert.equal((await first(undefined, "src/before.ts"))?.kind, "none", "an answer being written now means a file named that now")
    assert.equal((await first(base + 3 * hour, "src/before.ts"))?.kind, "none", "written after the rename, it meant some other file of that name")

    // The Thread reads `a/src/dup.ts` now: an answer finished an hour ago hadn't, so it can't lean on that read.
    const read = join(repo, "a", "src", "dup.ts")
    journal.live(batch({ updates: [{ kind: "tool", id: "t1", title: "Read", name: "Read", status: "in_progress", input: JSON.stringify({ file_path: read }) }] }))
    journal.live(batch({ updates: [{ kind: "tool-update", id: "t1", status: "completed", output: "ok", effects: [{ kind: "read", path: read }] }] }))
    await journal.settled()
    assert.deepEqual([(await first(undefined, "dup.ts"))?.kind, (await first(Date.now() - hour, "dup.ts"))?.kind], ["file", "none"])
    const tie = await first(Date.now() - hour, "src/dup.ts")
    assert.deepEqual(tie?.kind === "choice" && tie.candidates.map((file) => file.path).sort(), [read, join(repo, "b", "src", "dup.ts")])

    // The person picks `b`'s: it holds for that spelling in every answer of the Thread, with `a`'s kept to pick again.
    journal.chooseFile({ liveId: "c1" }, "src/dup.ts:4", join(repo, "b", "src", "dup.ts"))
    await journal.settled()
    const picked = await first(Date.now() - hour, "src/dup.ts")
    assert.deepEqual(picked?.kind === "file" && [picked.file.path, picked.file.reason, picked.others?.map((file) => file.path)], [join(repo, "b", "src", "dup.ts"), "chosen", [read]])
    const now = await first(undefined, "src/dup.ts")
    assert.equal(now?.kind === "file" && now.file.path, join(repo, "b", "src", "dup.ts"), "and now, over the Thread's own read")
  } finally {
    await journal.close()
    rmSync(repo, { recursive: true, force: true })
    rmSync(userRoot, { recursive: true, force: true })
  }
})
