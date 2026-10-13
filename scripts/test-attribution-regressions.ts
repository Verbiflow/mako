import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { ActivityMark, Attribution, ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
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
async function world(files: Record<string, string>, options: { submodule?: boolean } = {}) {
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
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events, clock, storage, device: "regression" }, { repository: async (path) => gitRepository(runner, path) })
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
