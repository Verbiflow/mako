import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { ActivityMark, Attribution, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import type { ChildSource, ThreadEntry } from "@mako/sessions"
import { Backfill } from "@mako/host/attribution/backfill"
import { ChildCalls } from "@mako/host/attribution/child-calls"
import { outsideFolders } from "@mako/host/attribution/index"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { readOnlyCommand } from "@mako/host/attribution/read-only"
import { partition, type JournalView } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"

/*
 * Shapes of failures found by replaying real concurrent sessions through the
 * tracker (the attribution evaluation, October 12). Each case is synthetic:
 * the same shape on a scratch repository, never a copy of anyone's work.
 *
 * A case the tracker gets wrong today is a `todo`: it runs and reports, and
 * doesn't fail the suite. Drop the `todo` once the tracker handles it.
 */

const runner = new Git()

/** A scratch project folder holding one repository, and a tracker over it on a scripted clock. */
async function world(files: Record<string, string>, options: { submodule?: boolean; uncertain?: (sessions: ReadonlySet<string>) => void; outsider?: (path: string, root: string) => string | undefined } = {}) {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-regression-")))
  const repo = join(project, "repo")
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "test@example.com")
  git(repo, "config", "user.name", "Test")
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(repo, path, ".."), { recursive: true })
    writeFileSync(join(repo, path), text)
  }
  if (options.submodule) {
    const library = join(project, "library")
    mkdirSync(library)
    git(library, "init", "-q", "-b", "main")
    git(library, "config", "user.email", "test@example.com")
    git(library, "config", "user.name", "Test")
    writeFileSync(join(library, "lib.ts"), "export const lib = 1\n")
    git(library, "add", "-A")
    git(library, "commit", "-q", "-m", "library")
    git(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", library, "vendor/library")
  }
  git(repo, "add", "-A")
  git(repo, "commit", "-q", "-m", "base")
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const storage = mkdtempSync(join(tmpdir(), "mako-attribution-regression-journal-"))
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events, clock, storage, device: "regression" }, { repository: async (path) => gitRepository(runner, path), uncertain: options.uncertain, outsider: options.outsider })
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const write = (path: string, text: string) => {
    const absolute = join(repo, path)
    mkdirSync(join(absolute, ".."), { recursive: true })
    writeFileSync(absolute, text)
    utimesSync(absolute, clock.now() / 1000, clock.now() / 1000)
    events.changed(absolute)
  }
  const mark = (kind: ActivityMark["kind"], thread: string, id: string, edge: "start" | "end", extra: Partial<ActivityMark> = {}) =>
    tracker.activity({ kind, id, edge, at: clock.now(), thread, session: `${thread}-session`, checkout: project, cwd: project, ...extra })
  const report = (thread: string, call: string, effects: ReportedEffect[], startedAt: number) =>
    tracker.reported({ thread, session: `${thread}-session`, call, status: "completed", startedAt, endedAt: clock.now(), checkout: project, effects })
  const last = () => tracker.changes(0).at(-1)!
  return { project, repo, clock, events, tracker, view, write, mark, report, last }
}

const certainty = (author: Attribution) => ("author" in author ? `${author.certainty}:${author.author.thread}` : author.certainty)

test("a command run at a repository's root names none of its files by its folder alone", async () => {
  // Two Threads work in a project folder of several repositories. T1's shell
  // is in the repository (after a `cd`) and runs a read-only command; T2
  // rewrites a file there with a script whose target nobody named.
  const w = await world({ "src/a.ts": "export const a = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(1_000)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.mark("call", "T2", "c2", "start")
  w.clock.advance(100)
  w.write("src/a.ts", "export const a = 2\n")
  await w.tracker.settled()
  w.clock.advance(100)
  w.report("T1", "c1", [{ kind: "command", command: "grep -n error /tmp/build.log", cwd: w.repo, named: ["/tmp/build.log"] }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("call", "T2", "c2", "end")
  await w.tracker.settled()
  assert.notEqual(certainty(w.last().author), "named:T1", "a folder holding the whole repository names none of its files")
  assert.equal(w.last().author.certainty, "ambiguous")
  // A move of T1 takes nothing it didn't write.
  assert.deepEqual(partition(w.view, w.project, "T1").files, [])
  await w.tracker.close()
})

test("a change an agent's reported edit already explained doesn't name the next writer of that file", async () => {
  // T1 edits a file with a reported, proven edit; one second after the call
  // ends, the person appends a line to the same file in their editor.
  const w = await world({ "notes.md": "# Notes\n\nfirst\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("notes.md", "# Notes\n\nfirst, edited\n")
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "modify", path: join(w.repo, "notes.md"), edits: [{ old: "first\n", new: "first, edited\n" }] }], started)
  w.mark("call", "T1", "c1", "end")
  await w.tracker.settled()
  assert.equal(certainty(w.last().author), "exact:T1")
  w.clock.advance(1_000)
  w.write("notes.md", "# Notes\n\nfirst, edited\nthe person's line\n")
  await w.tracker.settled()
  const author = w.last().author
  assert.ok(author.certainty !== "named" && author.certainty !== "exact", `the person's line is not T1's own: ${JSON.stringify(author)}`)
  // So a move of T1 leaves the person's line in the checkout.
  const moved = partition(w.view, w.project, "T1").files.find((file) => file.path === "notes.md")
  assert.ok(!(moved?.thread.kind === "text" && moved.thread.text.includes("the person's line")))
  await w.tracker.close()
})

test("an edit where no running Thread's checkout holds the path is the person's", async () => {
  const w = await world({ "README.md": "# App\n" })
  // T1 is running, but in another checkout entirely.
  const elsewhere = { thread: "T1", session: "T1-session", checkout: "/elsewhere/other-project", cwd: "/elsewhere/other-project" }
  w.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: w.clock.now(), ...elsewhere })
  w.tracker.activity({ kind: "call", id: "c1", edge: "start", at: w.clock.now(), turn: "t1", ...elsewhere })
  w.clock.advance(1_000)
  w.write("README.md", "# App\n\nUsage: run it.\n")
  await w.tracker.settled()
  assert.deepEqual(w.last().author, { certainty: "person", via: "no-activity" })
  await w.tracker.close()
})

test("a Thread from another checkout whose call went into this repository stays a candidate", async () => {
  const w = await world({ "README.md": "# App\n" })
  const elsewhere = { thread: "T1", session: "T1-session", checkout: "/elsewhere/other-project", cwd: "/elsewhere/other-project" }
  w.tracker.activity({ kind: "turn", id: "t1", edge: "start", at: w.clock.now(), ...elsewhere })
  // `cd ../repo && npm run docs`: the call's folder is this repository, which names none of its files.
  w.tracker.activity({ kind: "call", id: "c1", edge: "start", at: w.clock.now(), turn: "t1", ...elsewhere, cwd: w.repo })
  w.clock.advance(1_000)
  w.write("README.md", "# App\n\nUsage: run it.\n")
  await w.tracker.settled()
  const author = w.last().author
  assert.equal(author.certainty, "ambiguous")
  assert.ok(author.certainty === "ambiguous" && author.reason === "outside-checkout" && author.candidates.some((candidate) => candidate.thread === "T1"))
  await w.tracker.close()
})

test("an agent another app runs in the checkout leaves timing unable to name a Thread", async () => {
  // Another Mako on this device (or a harness in a terminal) runs an agent in
  // this repository while this Mako's T1 works there too: this journal hears
  // only T1, so timing alone would hand T1 the other agent's edit.
  let working = true
  const w = await world({ "src/a.ts": "export const a = 1\n", "README.md": "# App\n" }, { outsider: (path, root) => (working && path.startsWith(root) ? "claude session 4f2a9c1e, outside this Mako" : undefined) })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("README.md", "# App\n\nUsage: run it.\n")
  await w.tracker.settled()
  const unclaimed = w.last().author
  assert.ok(unclaimed.certainty === "ambiguous" && unclaimed.reason === "outside-mako" && unclaimed.candidates.some((candidate) => candidate.thread === "T1"), JSON.stringify(unclaimed))
  assert.deepEqual(partition(w.view, w.project, "T1").files, [], "a move of T1 leaves the other agent's edit")
  // T1's own reported edit is still proven, outside agent or not.
  w.clock.advance(100)
  w.write("src/a.ts", "export const a = 2\n")
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "modify", path: join(w.repo, "src/a.ts"), edits: [{ old: "a = 1", new: "a = 2" }] }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("turn", "T1", "t1", "end")
  await w.tracker.settled()
  assert.equal(certainty(w.last().author), "exact:T1")
  // With no Thread of this Mako running, the edit isn't taken for the person's either.
  w.clock.advance(60_000)
  w.write("README.md", "# App\n\nUsage: run it.\nAgain.\n")
  await w.tracker.settled()
  assert.deepEqual(w.last().author, { certainty: "ambiguous", candidates: [], reason: "outside-mako" })
  // Once the other agent stops, quiet is the person again.
  working = false
  w.clock.advance(1_000)
  w.write("README.md", "# App\n")
  await w.tracker.settled()
  assert.deepEqual(w.last().author, { certainty: "person", via: "no-activity" })
  await w.tracker.close()
})

test("the folders of agents outside this Mako are the running sessions', never home or the root", () => {
  const home = "/Users/someone"
  const sessions = [
    { harness: "claude", nativeId: "4f2a9c1e-aaaa", path: "/s/1.jsonl", cwd: "/work/app", worktrees: [{ path: "/work/app-wt" }] },
    { harness: "codex", nativeId: "77b0d2aa-bbbb", path: "/s/2.jsonl", cwd: home },
    { harness: "codex", nativeId: "9c1d0e2f-cccc", path: "/s/3.jsonl", cwd: "/work/idle" },
    { harness: "grok", nativeId: "0a1b2c3d-dddd", path: "/s/4.jsonl", cwd: "/" },
  ]
  const running = { "/s/1.jsonl": { status: "active" }, "/s/2.jsonl": { status: "active" }, "/s/3.jsonl": { status: "open" }, "/s/4.jsonl": { status: "active" } }
  assert.deepEqual(outsideFolders(sessions, running, home), [
    { folder: "/work/app", why: "claude session 4f2a9c1e, outside this Mako" },
    { folder: "/work/app-wt", why: "claude session 4f2a9c1e, outside this Mako" },
  ])
  assert.deepEqual(outsideFolders(sessions, {}, home), [])
})

test("a reported create over a file that exists, with the content written, is exact", async () => {
  const w = await world({ "src/b.ts": "export const b = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("src/b.ts", "export const b = 2\n")
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "create", path: join(w.repo, "src/b.ts"), content: "export const b = 2\n" }], started)
  w.mark("call", "T1", "c1", "end")
  await w.tracker.settled()
  assert.equal(certainty(w.last().author), "exact:T1")
  await w.tracker.close()
})

test("a file the harness only saw change during a command proves timing, not authorship", async () => {
  // T1 runs a script whose body names no file. While it runs, the person saves
  // the README; the harness lists that save among the files that changed
  // during the command, with the exact hunk.
  const w = await world({ "README.md": "# App\n", "src/d.ts": "export const d = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  let started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("README.md", "# App\n\nUsage: run it.\n")
  await w.tracker.settled()
  w.report("T1", "c1", [
    { kind: "command", command: "node - <<'EOF'\nconsole.log(1)\nEOF", cwd: w.repo },
    { kind: "modify", path: join(w.repo, "README.md"), patch: "@@ -1,1 +1,3 @@\n # App\n+\n+Usage: run it.\n", seen: true },
  ], started)
  w.mark("call", "T1", "c1", "end")
  await w.tracker.settled()
  assert.equal(certainty(w.last().author), "window:T1", "only T1 was running, so the window names it; nothing proves it wrote the file")
  // A command that names the file it rewrote is still named.
  w.clock.advance(5_000)
  started = w.clock.now()
  w.mark("call", "T1", "c2", "start")
  w.clock.advance(100)
  w.write("src/d.ts", "export const d = 2\n")
  await w.tracker.settled()
  w.report("T1", "c2", [
    { kind: "command", command: "sed -i '' 's/1/2/' src/d.ts", cwd: w.repo, named: [join(w.repo, "src/d.ts")] },
    { kind: "modify", path: join(w.repo, "src/d.ts"), patch: "@@ -1,1 +1,1 @@\n-export const d = 1\n+export const d = 2\n", seen: true },
  ], started)
  w.mark("call", "T1", "c2", "end")
  await w.tracker.settled()
  assert.equal(certainty(w.last().author), "named:T1")
  await w.tracker.close()
})

test("a formatter that rewrote thousands of other lines keeps another Thread's untouched lines theirs", async () => {
  const size = 6_000
  const base = Array.from({ length: size }, (_, i) => `const v${i} = "${i}"\n`).join("")
  const w = await world({ "big.ts": base })
  w.mark("turn", "T1", "t1", "start")
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(500)
  // T1 changes three lines in the middle.
  const t1Lines = [2_999, 3_000, 3_001]
  const afterT1 = base.split("\n").map((line, i) => (t1Lines.includes(i) ? `const v${i} = "edited by T1"` : line)).join("\n")
  let started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("big.ts", afterT1)
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "modify", path: join(w.repo, "big.ts"), edits: t1Lines.map((i) => ({ old: `const v${i} = "${i}"`, new: `const v${i} = "edited by T1"` })) }], started)
  w.mark("call", "T1", "c1", "end")
  await w.tracker.settled()
  // T2 runs a formatter: single quotes on every other line, none of T1's lines.
  w.clock.advance(5_000)
  started = w.clock.now()
  w.mark("call", "T2", "c2", "start")
  w.clock.advance(100)
  const formatted = afterT1.split("\n").map((line, i) => (i % 2 === 0 && !t1Lines.includes(i) ? line.replaceAll('"', "'") : line)).join("\n")
  w.write("big.ts", formatted)
  await w.tracker.settled()
  w.report("T2", "c2", [{ kind: "command", command: "npx prettier --write big.ts", cwd: w.repo, named: [join(w.repo, "big.ts")] }], started)
  w.mark("call", "T2", "c2", "end")
  await w.tracker.settled()
  const runs = w.tracker.blame("repo", "big.ts")!
  const writer = (line: number) => runs.find((run) => line >= run.start && line < run.start + run.length)?.author
  for (const line of t1Lines) assert.equal(writer(line) && certainty(writer(line)!), "exact:T1", `line ${line + 1} is still T1's`)
  await w.tracker.close()
})

for (const dirty of [false, true])
  test(`lines a commit took and a later commit dropped, still on disk, stay their writer's (${dirty ? "file changed since" : "file clean"})`, async () => {
    // T1 adds a repeated key in three places; a commit takes them. A later
    // commit is made from content without them (staged elsewhere), and the
    // working tree keeps them: they are uncommitted again, and T1's.
    const base = Array.from({ length: 40 }, (_, i) => (i % 10 === 9 ? "    }\n" : `    "field_${i}": ${i},\n`)).join("")
    const w = await world({ "api.py": base })
    const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, encoding: "utf8", input: args.includes("--stdin") ? base : undefined }).trim()
    const key = `    "approval_input_id": None,\n`
    const lines = base.split(/(?<=\n)/)
    const withKeys = lines.flatMap((line, i) => (i % 10 === 8 ? [line, key] : [line])).join("")
    w.mark("turn", "T1", "t1", "start")
    w.clock.advance(500)
    const started = w.clock.now()
    w.mark("call", "T1", "c1", "start")
    w.clock.advance(100)
    w.write("api.py", withKeys)
    await w.tracker.settled()
    w.report("T1", "c1", [{ kind: "write", path: join(w.repo, "api.py"), content: withKeys }], started)
    w.mark("call", "T1", "c1", "end")
    w.mark("turn", "T1", "t1", "end")
    await w.tracker.settled()
    w.clock.advance(15_000)
    w.tracker.sweep()
    const settle = async () => {
      w.clock.advance(1_000)
      w.events.changed(join(w.repo, ".git/index"))
      await w.tracker.settled()
    }
    git("commit", "-q", "-am", "keys")
    await settle()
    let onDisk = withKeys
    if (dirty) {
      onDisk = withKeys.replace(`"field_0": 0`, `"field_0": 100`)
      w.write("api.py", onDisk)
      await w.tracker.settled()
      assert.equal(w.last().author.certainty, "person")
    }
    const oid = git("hash-object", "-w", "--stdin")
    git("update-index", "--cacheinfo", `100644,${oid},api.py`)
    git("commit", "-q", "-m", "without the keys")
    await settle()
    const runs = w.tracker.blame("repo", "api.py")!
    const text = onDisk.split(/(?<=\n)/)
    const ofKey = text.flatMap((line, i) => (line === key ? [i] : []))
    assert.equal(ofKey.length, 4)
    for (const line of ofKey) {
      const author = runs.find((run) => line >= run.start && line < run.start + run.length)?.author
      assert.equal(author && certainty(author), "exact:T1", `line ${line + 1} is T1's again`)
    }
    const moved = partition(w.view, w.project, "T1").files.find((file) => file.path === "api.py")
    assert.ok(moved?.thread.kind === "text", "a move of T1 takes the file")
    assert.equal(moved.thread.text, withKeys, "with T1's keys on the new base, and not the person's line")
    await w.tracker.close()
  })

test("a Thread's last lines a commit didn't take stay its own after a rewrite, though the base had copies of them", async () => {
  // The base ends with two copies of a key. T1 rewrites the file: copies up
  // front, and its last lines, two more copies, at the end. A commit takes the
  // rewrite but not those last lines. Every copy reads alike, so the diff is
  // free to say the base's copies are the trailing ones.
  const key = `    "approval_input_id": None,\n`
  const base = `head\nold 1\nold 2\n${key}${key}tail\n`
  const rewrite = `head\nnew 1\n${key}${key}new 2\nnew 3\n${key}${key}tail\n`
  const committed = `head\nnew 1\n${key}${key}new 2\nnew 3\ntail\n`
  const w = await world({ "api.py": base })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("api.py", rewrite)
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "write", path: join(w.repo, "api.py"), content: rewrite }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("turn", "T1", "t1", "end")
  await w.tracker.settled()
  w.clock.advance(15_000)
  w.tracker.sweep()
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, encoding: "utf8", input: args.includes("--stdin") ? committed : undefined }).trim()
  git("update-index", "--cacheinfo", `100644,${git("hash-object", "-w", "--stdin")},api.py`)
  git("commit", "-q", "-m", "most of the rewrite")
  w.clock.advance(1_000)
  w.events.changed(join(w.repo, ".git/index"))
  await w.tracker.settled()
  const runs = w.tracker.blame("repo", "api.py")!
  for (const line of [6, 7]) {
    const author = runs.find((run) => line >= run.start && line < run.start + run.length)?.author
    assert.equal(author && certainty(author), "exact:T1", `line ${line + 1}, uncommitted, is T1's`)
  }
  const moved = partition(w.view, w.project, "T1").files.find((file) => file.path === "api.py")
  assert.ok(moved?.thread.kind === "text" && moved.thread.text === rewrite, "a move of T1 takes its last lines")
  await w.tracker.close()
})

test("a new file keeps its writer's lines through a commit that leaves it out, and through the commit that takes most of it", async () => {
  // T1 creates a file Git doesn't track yet. Someone commits other work, so
  // HEAD moves without the file. Later a commit takes the file without its
  // last line.
  const created = `def first():\n    return 1\n\ndef second():\n    return 2\n`
  const committed = `def first():\n    return 1\n\ndef second():\n`
  const w = await world({ "other.ts": "export const other = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  w.write("schemas.py", created)
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "write", path: join(w.repo, "schemas.py"), content: created }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("turn", "T1", "t1", "end")
  await w.tracker.settled()
  w.clock.advance(15_000)
  w.tracker.sweep()
  const git = (...args: string[]) => execFileSync("git", args, { cwd: w.repo, encoding: "utf8", input: args.includes("--stdin") ? committed : undefined }).trim()
  const settle = async () => {
    w.clock.advance(1_000)
    w.events.changed(join(w.repo, ".git/index"))
    await w.tracker.settled()
  }
  writeFileSync(join(w.repo, "other.ts"), "export const other = 2\n")
  git("commit", "-q", "-am", "other work")
  await settle()
  const all = (label: string) => {
    const runs = w.tracker.blame("repo", "schemas.py")!
    const lines = created.split(/(?<=\n)/).length
    for (let line = 0; line < lines; line++) {
      const author = runs.find((run) => line >= run.start && line < run.start + run.length)?.author
      assert.equal(author && certainty(author), "exact:T1", `${label}: line ${line + 1} is T1's`)
    }
  }
  all("after a commit without the file")
  const whole = partition(w.view, w.project, "T1").files.find((file) => file.path === "schemas.py")
  assert.equal(whole?.move, "whole", "a move of T1 takes the new file a commit of other work left out")
  git("update-index", "--add", "--cacheinfo", `100644,${git("hash-object", "-w", "--stdin")},schemas.py`)
  git("commit", "-q", "-m", "most of schemas.py")
  await settle()
  const runs = w.tracker.blame("repo", "schemas.py")!
  const last = runs.find((run) => 4 >= run.start && 4 < run.start + run.length)
  assert.equal(last?.author && certainty(last.author), "exact:T1", "the line the commit left out is T1's")
  const moved = partition(w.view, w.project, "T1").files.find((file) => file.path === "schemas.py")
  assert.ok(moved?.thread.kind === "text" && moved.thread.text === created, "a move of T1 takes the line the commit left out")
  await w.tracker.close()
})

/**
 * Child agents' records as the catalog serves them: each child's transcript,
 * read by its harness's reader, with the time it last changed.
 */
function childRecords(harness: string, cwd: string) {
  const kids = new Map<string, { parent: string; entries: ThreadEntry[]; updatedAt: string }>()
  let listings = 0
  const source: ChildSource = {
    async children(path) {
      listings++
      const mine = [...kids].filter(([, kid]) => kid.parent === path)
      return { parent: { harness, nativeId: "parent", path }, children: mine.map(([nativeId, kid]) => ({ nativeId, path: `/records/${nativeId}.jsonl`, state: { kind: "complete" as const }, updatedAt: kid.updatedAt })) }
    },
    async open(path) {
      const nativeId = path.slice("/records/".length, -".jsonl".length)
      const kid = kids.get(nativeId)
      return kid ? { ref: { harness, nativeId, path, cwd }, entries: kid.entries } : null
    },
  }
  /** T1's child's edit, written to its record at `at`, finished by the next entry at `until`. */
  const edit = (child: string, call: string, at: number, until: number, file: string, old: string, replacement: string, name = "Edit") => {
    const kid = kids.get(child) ?? { parent: "/records/T1-parent.jsonl", entries: [], updatedAt: "" }
    const input = name === "StrReplace" ? { path: file, old_string: old, new_string: replacement } : { file_path: file, old_string: old, new_string: replacement }
    const entry: ThreadEntry = { kind: "assistant", blocks: [{ type: "tool", id: call, name, input: JSON.stringify(input), output: "ok" }] }
    // An untimed entry, as a harness that writes no time leaves it.
    if (at) entry.at = new Date(at).toISOString()
    kid.entries.push(entry)
    if (until) kid.entries.push({ kind: "assistant", at: new Date(until).toISOString(), blocks: [{ type: "text", text: "done" }] })
    kid.updatedAt = new Date(until || Date.now()).toISOString()
    kids.set(child, kid)
  }
  return { source, edit, listings: () => listings }
}

/** A world whose tracker reads child agents' records, the way the host wires it. */
async function followedWorld(files: Record<string, string>, harness = "claude") {
  let children: ChildCalls | undefined
  const w = await world(files, { uncertain: (sessions) => children?.uncertain(sessions) })
  const records = childRecords(harness, w.repo)
  children = new ChildCalls({
    records: records.source,
    reported: (call) => w.tracker.reported(call),
    reconcile: (calls) => w.tracker.reconcile(calls),
    hold: () => w.tracker.hold(),
    unsure: () => w.tracker.unsure(),
    now: () => w.clock.now(),
  })
  const mark = (kind: ActivityMark["kind"], thread: string, id: string, edge: "start" | "end") => {
    const at = w.clock.now()
    const fields = { kind, id, edge, at, thread, session: `${thread}-session`, checkout: w.project, cwd: w.project, record: `/records/${thread}-parent.jsonl` }
    w.tracker.activity(fields)
    children!.marked(fields)
  }
  /** Until the follower has read what it was asked to, and the tracker has journaled what that changed. */
  const read = async () => {
    do await new Promise((resolve) => setTimeout(resolve, 10))
    while (!children!.idle())
    await w.tracker.settled()
  }
  return { ...w, records, children, mark, read }
}

test("a background agent's edit while its parent is idle is the parent Thread's, exactly", async () => {
  // T1's turn ended, leaving a background agent running. It edits a file;
  // nothing in T1's live wire reports the call, only the agent's record.
  const w = await followedWorld({ "src/e.ts": "export const e = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.mark("background", "T1", "agent-1", "start")
  w.clock.advance(500)
  w.mark("turn", "T1", "t1", "end")
  w.clock.advance(2_000)
  const at = w.clock.now()
  w.records.edit("agent-1", "toolu_1", at, at + 50, join(w.repo, "src/e.ts"), "export const e = 1", "export const e = 2")
  w.write("src/e.ts", "export const e = 2\n")
  await w.tracker.settled()
  await w.read()
  assert.equal(certainty(w.last().author), "exact:T1", `the agent's own record proves it: ${JSON.stringify(w.last().author)}`)
  const author = w.last().author
  assert.ok("author" in author && author.author.call === "agent-1/toolu_1", "the call is the child's, under the parent Session")
  w.children.close()
  await w.tracker.close()
})

test("a foreground subagent's edit during its parent's call is the subagent's call, exactly", async () => {
  // Two Threads run; T1's Task call is in flight while its subagent edits.
  const w = await followedWorld({ "src/f.ts": "export const f = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.mark("turn", "T2", "t2", "start")
  w.mark("call", "T1", "task", "start")
  w.mark("call", "T2", "c2", "start")
  w.clock.advance(1_000)
  const at = w.clock.now()
  w.records.edit("sub-1", "toolu_2", at, at + 20, join(w.repo, "src/f.ts"), "export const f = 1", "export const f = 2")
  w.write("src/f.ts", "export const f = 2\n")
  await w.tracker.settled()
  assert.equal(w.last().author.certainty, "ambiguous", "two Threads were running")
  await w.read()
  assert.equal(certainty(w.last().author), "exact:T1")
  assert.ok(partition(w.view, w.project, "T1").files.some((file) => file.path === "src/f.ts"), "a move of T1 takes it without asking")
  w.children.close()
  await w.tracker.close()
})

test("a child's record read after its change settled still names the change by its content", async () => {
  const w = await followedWorld({ "src/g.ts": "export const g = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.mark("background", "T1", "agent-2", "start")
  w.clock.advance(1_000)
  const at = w.clock.now()
  w.write("src/g.ts", "export const g = 2\n")
  await w.tracker.settled()
  // The record isn't written yet when the change is heard; the change settles uncertain.
  await w.read()
  w.clock.advance(15_000)
  w.tracker.sweep()
  assert.equal(certainty(w.tracker.changes(0).at(-1)!.author), "window:T1")
  w.records.edit("agent-2", "toolu_3", at, at + 30, join(w.repo, "src/g.ts"), "export const g = 1", "export const g = 2")
  w.mark("background", "T1", "agent-2", "end")
  await w.read()
  assert.equal(certainty(w.tracker.changes(0).find((entry) => entry.path === "src/g.ts")!.author), "exact:T1")
  w.children.close()
  await w.tracker.close()
})

test("a Cursor subagent's edit, whose record keeps no times, is proven by its content alone", async () => {
  const w = await followedWorld({ "src/h.ts": "export const h = 1\n" }, "cursor")
  w.mark("turn", "T1", "t1", "start")
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(1_000)
  w.records.edit("cursor-sub", "tool_1", 0, 0, join(w.repo, "src/h.ts"), "export const h = 1", "export const h = 2", "StrReplace")
  w.write("src/h.ts", "export const h = 2\n")
  await w.tracker.settled()
  await w.read()
  assert.equal(certainty(w.last().author), "exact:T1")
  w.children.close()
  await w.tracker.close()
})

test("an ignored file is kept only when a Thread's own write named it, never a tool's cache or a secret", async () => {
  // `scratch/` and `.cache/` are ignored; a tool marked `.cache/` as its own.
  const w = await world({ ".gitignore": "scratch/\n.cache/\n.env.local\ngen/\n", ".cache/CACHEDIR.TAG": "Signature: 8a477f597d28d172789f06886806bc55\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  const probe = "console.log('probe')\n"
  w.write("scratch/probe.mts", probe)
  w.write(".cache/notes.txt", "kept by the tool\n")
  w.write(".env.local", "TOKEN=x\n")
  await w.tracker.settled()
  w.report("T1", "c1", [
    { kind: "create", path: join(w.repo, "scratch/probe.mts"), content: probe },
    { kind: "create", path: join(w.repo, ".cache/notes.txt"), content: "kept by the tool\n" },
    { kind: "create", path: join(w.repo, ".env.local"), content: "TOKEN=x\n" },
  ], started)
  w.mark("call", "T1", "c1", "end")
  // A build writes its output; no write names a file of it.
  w.mark("call", "T1", "c2", "start")
  const built = w.clock.now()
  w.clock.advance(100)
  w.write("gen/bundle.js", "bundle\n")
  await w.tracker.settled()
  w.report("T1", "c2", [{ kind: "command", command: "npm run build" }], built)
  w.mark("call", "T1", "c2", "end")
  w.mark("turn", "T1", "t1", "end")
  await w.tracker.settled()
  w.clock.advance(1_000)
  await w.tracker.settled()
  const kept = w.tracker.changes(0).map((entry) => entry.path)
  assert.deepEqual(kept, ["scratch/probe.mts"], "only the scratch file T1 wrote by name is journaled")
  const author = w.tracker.blame("repo", "scratch/probe.mts")?.[0]?.author
  assert.equal(author && certainty(author), "exact:T1")
  const moved = partition(w.view, w.project, "T1").files.map((file) => file.path)
  assert.deepEqual(moved, ["scratch/probe.mts"], "a move of T1 takes it")
  await w.tracker.close()
})

test("a deletion a commit of other work didn't take still goes with the Thread that deleted the file", async () => {
  const w = await world({ "old.ts": "export const old = 1\n", "other.ts": "export const other = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.clock.advance(100)
  rmSync(join(w.repo, "old.ts"))
  w.events.changed(join(w.repo, "old.ts"))
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "delete", path: join(w.repo, "old.ts") }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("turn", "T1", "t1", "end")
  await w.tracker.settled()
  w.clock.advance(15_000)
  w.tracker.sweep()
  writeFileSync(join(w.repo, "other.ts"), "export const other = 2\n")
  execFileSync("git", ["commit", "-q", "-m", "other work", "other.ts"], { cwd: w.repo })
  w.clock.advance(1_000)
  w.events.changed(join(w.repo, ".git/index"))
  await w.tracker.settled()
  const gone = partition(w.view, w.project, "T1").files.find((file) => file.path === "old.ts")
  assert.ok(gone?.move === "whole" && gone.thread.kind === "absent", `a move of T1 takes its deletion: ${JSON.stringify(gone)}`)
  await w.tracker.close()
})

test("a root idle past retention is let go, never one a Thread worked in or anyone changed lately, and a turn there tracks it again", async () => {
  const DAY = 86_400_000
  const w = await world({ "a.ts": "export const a = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.write("a.ts", "export const a = 2\n")
  await w.tracker.settled()
  w.mark("turn", "T1", "t1", "end")
  w.clock.advance(15_000)
  w.tracker.sweep()
  w.clock.advance(13 * DAY)
  assert.deepEqual(await w.tracker.letGoIdle(), [], "changed 13 days ago")
  // A turn with no change in the project folder around it keeps it, though the last change is past retention.
  w.clock.advance(2 * DAY)
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(1_000)
  w.mark("turn", "T2", "t2", "end")
  assert.deepEqual(await w.tracker.letGoIdle(), [], "a Thread worked around it today")
  w.clock.advance(15 * DAY)
  const entries = w.tracker.changes(0).length
  assert.deepEqual(await w.tracker.letGoIdle(), [w.repo], "nobody used it for longer than retention")
  assert.equal(w.tracker.rootStates().size, 0)
  w.write("a.ts", "export const a = 3\n")
  await w.tracker.settled()
  assert.equal(w.tracker.changes(0).length, entries, "nothing is heard there any more")
  // The next turn there tracks it again, from a fresh baseline: what changed meanwhile was before tracking.
  await w.tracker.track({ id: "repo", path: w.repo, kind: "workspace" })
  await w.tracker.settled()
  w.mark("turn", "T1", "t3", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.write("a.ts", "export const a = 4\n")
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "modify", path: join(w.repo, "a.ts"), edits: [{ old: "export const a = 3\n", new: "export const a = 4\n" }] }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("turn", "T1", "t3", "end")
  await w.tracker.settled()
  assert.equal(certainty(w.last().author), "exact:T1", "and attributes as before")
  await w.tracker.close()
})

test("lines there before tracking are given to the session whose record wrote them, and only those", async () => {
  // A session outside Mako (a terminal Claude Code, since imported) wrote a
  // function into the file; the person typed a note into it too. Mako starts
  // tracking afterwards: all of it is "before tracking".
  const base = "export const a = 1\n"
  const fn = "export function total(items: number[]): number {\n  return items.reduce((sum, item) => sum + item, 0)\n}\n"
  const note = "// remember to ask about rounding\n"
  const project = realpathSync(mkdtempSync(join(tmpdir(), "mako-attribution-backfill-")))
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: project })
  writeFileSync(join(project, "math.ts"), base)
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "--allow-empty", "-m", "empty"], { cwd: project })
  execFileSync("git", ["add", "-A"], { cwd: project })
  execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-q", "-m", "base"], { cwd: project })
  writeFileSync(join(project, "math.ts"), `${base}${note}${fn}`)
  const clock = new FakeClock(Date.now())
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events: new FakeEventSource(), clock, storage: mkdtempSync(join(tmpdir(), "mako-backfill-journal-")), device: "regression" }, { repository: async (path) => gitRepository(runner, path) })
  await tracker.track({ id: "repo", path: project, kind: "workspace" })
  await tracker.settled()
  const writer = (line: number) => {
    const run = tracker.blame("repo", "math.ts")!.find((item) => line >= item.start && line < item.start + item.length)
    return run?.author ? certainty(run.author) : "base"
  }
  assert.equal(writer(2), "ambiguous")
  const found = await tracker.reconcile([{
    thread: "T9", session: "T9-session", call: "toolu_old", status: "completed", startedAt: clock.now() - 3_600_000, endedAt: clock.now() - 3_599_000,
    effects: [{ kind: "modify", path: join(project, "math.ts"), edits: [{ old: "export const a = 1\n", new: `export const a = 1\n${fn}` }] }],
  }])
  assert.equal(found.lines, 3)
  for (const line of [2, 3, 4]) assert.equal(writer(line), "named:T9", `line ${line + 1}, the function, is the session's`)
  assert.equal(writer(1), "ambiguous", "the person's note stays nobody's")
  assert.equal(writer(0), "base")
  // Reading the same record again changes nothing.
  assert.deepEqual(await tracker.reconcile([{ thread: "T9", session: "T9-session", call: "toolu_old", status: "completed", effects: [{ kind: "modify", path: join(project, "math.ts"), edits: [{ old: "export const a = 1\n", new: `export const a = 1\n${fn}` }] }] }]), { entries: 0, lines: 0 })
  await tracker.close()
})

test("backfill opens only sessions that worked in the checkout, their child agents too, and only again once they move", async () => {
  const fn = "export function double(value: number): number {\n  return value * 2\n}\n"
  const helper = "export const HELPER_NAME = \"written by a subagent\"\n"
  const w = await world({ "lib.ts": "export const base = 0\n" })
  w.write("lib.ts", `export const base = 0\n${fn}${helper}`)
  await w.tracker.settled()
  w.clock.advance(15_000)
  w.tracker.sweep()
  assert.deepEqual(w.last().author, { certainty: "person", via: "no-activity" }, "nothing ran in Mako: a terminal session wrote it")
  const opened: string[] = []
  const records = new Map<string, ThreadEntry[]>([
    ["/sessions/terminal.jsonl", [{ kind: "assistant", at: new Date(w.clock.now() - 20_000).toISOString(), blocks: [{ type: "tool", id: "toolu_t", name: "Edit", input: JSON.stringify({ file_path: join(w.repo, "lib.ts"), old_string: "export const base = 0\n", new_string: `export const base = 0\n${fn}` }), output: "ok" }] }]],
    ["/sessions/terminal-child.jsonl", [{ kind: "assistant", at: new Date(w.clock.now() - 18_000).toISOString(), blocks: [{ type: "tool", id: "toolu_c", name: "Edit", input: JSON.stringify({ file_path: join(w.repo, "lib.ts"), old_string: fn, new_string: `${fn}${helper}` }), output: "ok" }] }]],
    ["/sessions/elsewhere.jsonl", []],
    ["/sessions/unplaced.jsonl", []],
  ])
  const source: ChildSource = {
    async children(path) {
      return { parent: { harness: "claude", nativeId: "p", path }, children: path === "/sessions/terminal.jsonl" ? [{ nativeId: "agent-x", path: "/sessions/terminal-child.jsonl", state: { kind: "complete" as const } }] : [] }
    },
    async open(path) {
      opened.push(path)
      const entries = records.get(path)
      return entries ? { ref: { harness: "claude", nativeId: path, path, cwd: w.repo }, entries } : null
    },
  }
  const updatedAt = new Date(w.clock.now()).toISOString()
  const sessions = [
    { harness: "claude", nativeId: "terminal", path: "/sessions/terminal.jsonl", cwd: join(w.repo, "src"), updatedAt, threadId: "T7", sessionId: "T7-session" },
    { harness: "claude", nativeId: "elsewhere", path: "/sessions/elsewhere.jsonl", cwd: "/somewhere/else", updatedAt, threadId: "T8", sessionId: "T8-session" },
    { harness: "claude", nativeId: "unplaced", path: "/sessions/unplaced.jsonl", cwd: w.repo, updatedAt },
  ]
  const backfill = new Backfill({ sessions: () => sessions, records: source, unsure: () => w.tracker.unsureFiles(), reconcile: (calls) => w.tracker.reconcile(calls), now: () => w.clock.now() })
  const first = await backfill.run()
  assert.equal(first.sessions, 1, "only the session that worked in the checkout and has a Thread")
  assert.deepEqual(opened.sort(), ["/sessions/terminal-child.jsonl", "/sessions/terminal.jsonl"])
  assert.equal(first.lines, 4)
  const runs = w.tracker.blame("repo", "lib.ts")!
  const writer = (line: number) => certainty(runs.find((run) => line >= run.start && line < run.start + run.length)!.author!)
  for (const line of [1, 2, 3, 4]) assert.equal(writer(line), "named:T7", `line ${line + 1} is the terminal session's`)
  const moved = partition(w.view, w.project, "T7").files.find((file) => file.path === "lib.ts")
  assert.ok(moved?.thread.kind === "text" && moved.thread.text.includes(helper), "a move of its Thread takes them without asking")
  // Nothing moved since: the next pass opens nothing.
  opened.length = 0
  assert.equal((await backfill.run()).sessions, 0)
  assert.equal(opened.length, 0, "nothing is opened again")
  // The unplaced session is imported (it gets a Thread): the next pass reads it.
  Object.assign(sessions[2]!, { threadId: "T9", sessionId: "T9-session" })
  w.write("lib.ts", `export const base = 0\n${fn}${helper}// a person's note\n`)
  await w.tracker.settled()
  w.clock.advance(15_000)
  w.tracker.sweep()
  await backfill.run()
  assert.ok(opened.includes("/sessions/unplaced.jsonl"))
  await w.tracker.close()
})

test("content read back never takes a change from a Thread a call proved, nor from the person's editor", async () => {
  const w = await world({ "src/i.ts": "export const i = 1\n" })
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T2", "c2", "start")
  w.clock.advance(100)
  w.write("src/i.ts", "export const i = 2\n")
  await w.tracker.settled()
  w.report("T2", "c2", [{ kind: "modify", path: join(w.repo, "src/i.ts"), edits: [{ old: "1", new: "2" }] }], started)
  w.mark("call", "T2", "c2", "end")
  await w.tracker.settled()
  w.clock.advance(15_000)
  w.tracker.sweep()
  assert.equal(certainty(w.last().author), "exact:T2")
  const found = await w.tracker.reconcile([{ thread: "T1", session: "T1-session", call: "other", status: "completed", effects: [{ kind: "modify", path: join(w.repo, "src/i.ts"), edits: [{ old: "export const i = 1", new: "export const i = 2" }] }] }])
  assert.deepEqual(found, { entries: 0, lines: 0 })
  assert.equal(certainty(w.last().author), "exact:T2")
  await w.tracker.close()
})

test("a call that only reads doesn't claim the person's save while it runs, nor name the file it searched", async () => {
  const w = await world({ "src/j.ts": "export const j = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  let started = w.clock.now()
  w.mark("call", "T1", "c1", "start", { readOnly: true, label: "rg", named: [join(w.repo, "src/j.ts")] })
  w.clock.advance(100)
  w.write("src/j.ts", "export const j = 2\n")
  await w.tracker.settled()
  w.report("T1", "c1", [{ kind: "command", command: "rg -n 'const j' src/j.ts", cwd: w.repo, named: [join(w.repo, "src/j.ts")] }], started)
  w.mark("call", "T1", "c1", "end")
  await w.tracker.settled()
  const author = w.last().author
  assert.ok(author.certainty === "window" && author.during === "turn", `the turn was running, not a call that writes: ${JSON.stringify(author)}`)
  // The same save during a command that may write stays on the call.
  w.clock.advance(5_000)
  started = w.clock.now()
  w.mark("call", "T1", "c2", "start")
  w.clock.advance(100)
  w.write("src/j.ts", "export const j = 3\n")
  await w.tracker.settled()
  w.report("T1", "c2", [{ kind: "command", command: "npm run codegen", cwd: w.repo }], started)
  w.mark("call", "T1", "c2", "end")
  await w.tracker.settled()
  const next = w.last().author
  assert.ok(next.certainty === "window" && next.during === "call", JSON.stringify(next))
  await w.tracker.close()
})

test("a save while the agent's dev server runs, minutes into a long command, or just after a call isn't taken without asking", async () => {
  const w = await world({ "src/s.ts": "export const s = 1\n", "src/t.ts": "export const t = 1\n", "src/u.ts": "export const u = 1\n" })
  const taken = () => partition(w.view, w.project, "T1").files.map((file) => file.path).sort()
  // A dev server T1 left running after its turn: the person saves while it runs.
  w.mark("turn", "T1", "t1", "start")
  w.mark("background", "T1", "dev", "start", { label: "npm run dev", standing: true })
  w.mark("turn", "T1", "t1", "end")
  w.clock.advance(30_000)
  w.write("src/s.ts", "export const s = 2\n")
  await w.tracker.settled()
  const server = w.last().author
  assert.ok(server.certainty === "window" && server.during === "background" && server.standing, JSON.stringify(server))
  w.clock.advance(5_000)
  w.mark("background", "T1", "dev", "end")
  w.clock.advance(5_000)
  // Three minutes into a build: the person saves.
  w.mark("turn", "T1", "t2", "start")
  w.mark("call", "T1", "build", "start")
  w.clock.advance(180_000)
  w.write("src/t.ts", "export const t = 2\n")
  await w.tracker.settled()
  const long = w.last().author
  assert.ok(long.certainty === "window" && long.during === "call" && long.standing, JSON.stringify(long))
  // A second into the same kind of call, run in the file's folder, the change is the call's.
  w.clock.advance(5_000)
  w.mark("call", "T1", "build", "end")
  w.clock.advance(5_000)
  w.mark("call", "T1", "gen", "start", { cwd: join(w.repo, "src") })
  w.clock.advance(1_000)
  w.write("src/u.ts", "export const u = 2\n")
  await w.tracker.settled()
  const short = w.last().author
  assert.ok(short.certainty === "window" && short.during === "call" && !short.standing && !short.trailing && short.reached === "folder", JSON.stringify(short))
  w.mark("call", "T1", "gen", "end")
  w.mark("turn", "T1", "t2", "end")
  w.clock.advance(15_000)
  w.tracker.sweep()
  assert.deepEqual(taken(), ["src/u.ts"], "only the short call's change goes with T1 unasked; the rest wait for Bring")
  await w.tracker.close()
})

test("in a project folder of several repositories, a Thread counts for a change only through work in that repository", async () => {
  // Both Threads work from the project folder. T1 generates fixtures in `repo`;
  // T2 runs scripts in `backend`. Neither names a file.
  const w = await world({ "fixtures/a.json": "{}\n", "src/s.ts": "export const s = 1\n" })
  const backend = join(w.project, "backend")
  mkdirSync(backend)
  const git = (...args: string[]) => execFileSync("git", args, { cwd: backend, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.com")
  git("config", "user.name", "Test")
  writeFileSync(join(backend, "app.py"), "x = 1\n")
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  await w.tracker.track({ id: "backend", path: backend, kind: "workspace" })
  const writeBackend = (text: string) => {
    const absolute = join(backend, "app.py")
    writeFileSync(absolute, text)
    utimesSync(absolute, w.clock.now() / 1000, w.clock.now() / 1000)
    w.events.changed(absolute)
  }
  w.mark("turn", "T1", "t1", "start")
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "gen", "start", { cwd: w.repo })
  w.mark("call", "T2", "py", "start", { cwd: backend })
  w.clock.advance(200)
  w.write("fixtures/a.json", "{\"a\":1}\n")
  writeBackend("x = 2\n")
  await w.tracker.settled()
  w.report("T1", "gen", [{ kind: "command", command: "npx tsx scripts/fixtures.ts", cwd: w.repo }], started)
  w.report("T2", "py", [{ kind: "command", command: "python3 - <<'EOF'\nprint(1)\nEOF", cwd: backend }], started)
  await w.tracker.settled()
  const of = (root: string, path: string) => w.tracker.blame(root, path)?.[0]?.author
  const fixture = of("repo", "fixtures/a.json")
  const app = of("backend", "app.py")
  assert.equal(fixture && certainty(fixture), "window:T1", `T2's work was all in another repository: ${JSON.stringify(fixture)}`)
  assert.equal(app && certainty(app), "window:T2", JSON.stringify(app))

  // Once T2 runs a command in `repo` too, a change there is either one's.
  w.mark("call", "T2", "py2", "start", { cwd: w.repo })
  w.clock.advance(200)
  w.write("src/s.ts", "export const s = 2\n")
  await w.tracker.settled()
  const both = of("repo", "src/s.ts")
  assert.equal(both?.certainty, "ambiguous", JSON.stringify(both))
  w.mark("call", "T1", "gen", "end")
  w.mark("call", "T2", "py", "end")
  w.mark("call", "T2", "py2", "end")
  await w.tracker.close()
})

test("a script whose text holds the lines it wrote names the change by its content, though it names no path", async () => {
  const w = await world({ "src/k.ts": "export const k = 1\n" })
  w.mark("turn", "T1", "t1", "start")
  w.mark("turn", "T2", "t2", "start")
  w.clock.advance(500)
  const started = w.clock.now()
  w.mark("call", "T1", "c1", "start")
  w.mark("call", "T2", "c2", "start")
  w.clock.advance(100)
  const added = "export function greet(name: string): string {\n  return `hello, ${name}`\n}\n"
  w.write("src/k.ts", `export const k = 1\n${added}`)
  await w.tracker.settled()
  const script = `python3 - <<'EOF'\nimport pathlib, glob\nfor p in glob.glob("src/*.ts"):\n    f = pathlib.Path(p)\n    f.write_text(f.read_text() + '''${added}''')\nEOF`
  w.report("T1", "c1", [{ kind: "command", command: script, cwd: w.repo }], started)
  w.report("T2", "c2", [{ kind: "command", command: "npm test", cwd: w.repo }], started)
  w.mark("call", "T1", "c1", "end")
  w.mark("call", "T2", "c2", "end")
  await w.tracker.settled()
  const author = w.last().author
  assert.equal(certainty(author), "named:T1", JSON.stringify(author))
  assert.ok(author.certainty === "named" && author.by === "content")
  await w.tracker.close()
})

test("command lines that only read, and ones that may write", () => {
  const reads = ["git status --short", "git log --oneline -5 && git diff HEAD~1 --stat", "rg -n foo src | head -20", "ls -la; pwd", "cat package.json | jq .scripts", "sed -n 1,40p src/a.ts", "find . -name '*.ts' -newer x", "LC_ALL=C sort file.txt | uniq -c", "git branch --show-current", "cd packages/host && rg -l attribute 2>/dev/null", "git stash list", "git stash show -p stash@{0}"]
  const writes = ["git stash", "git checkout -- src/a.ts", "sed -i '' 's/a/b/' x.ts", "echo hi > notes.md", "cat a >> b", "find . -name '*.orig' -delete", "npm test", "python3 - <<'EOF'\nprint(1)\nEOF", "rg foo | xargs sed -i 's/a/b/'", "cat $(git ls-files)", "prettier --write .", "git branch -D old", "awk '{print > \"out\"}' in", "sort -o out in"]
  for (const command of reads) assert.ok(readOnlyCommand(command), `reads: ${command}`)
  for (const command of writes) assert.ok(!readOnlyCommand(command), `may write: ${command}`)
})

test("a change inside a submodule doesn't lose the other changes heard with it", async () => {
  const w = await world({ "src/c.ts": "export const c = 1\n" }, { submodule: true })
  w.mark("turn", "T1", "t1", "start")
  w.clock.advance(500)
  // One burst: a new file in the repository and a new file inside the submodule.
  w.write("src/new.ts", "export const n = 1\n")
  w.write("vendor/library/extra.ts", "export const extra = 1\n")
  await w.tracker.settled()
  const paths = w.tracker.changes(0).map((entry) => entry.path)
  assert.ok(paths.includes("src/new.ts"), `the repository's own change is journaled: ${JSON.stringify(paths)}`)
  await w.tracker.close()
})
