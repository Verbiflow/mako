import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import type { ReportedEffect } from "@mako/protocol"
import { FakeClock, FakeEventSource } from "@mako/protocol/attribution-conformance"
import { changeSummary, lostVersions, restoreVersion } from "@mako/host/attribution"
import { gitRepository, nodeFileSystem } from "@mako/host/attribution/ports"
import { changes, type JournalView } from "@mako/host/attribution/queries"
import { LaptopTracker } from "@mako/host/attribution/tracker"

/*
 * Recovering lost work and "changes made", on a real repository: a Thread's
 * edits are thrown away by `git checkout --` and `rm`, listed as lost,
 * restored, and counted.
 */

const runner = new Git()

test("work thrown away is listed, restored by a rename as the person's, and counted in changes made", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "mako-recovery-")))
  const repo = join(base, "repo")
  execFileSync("mkdir", [repo])
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
  git("init", "-q", "-b", "main")
  git("config", "user.email", "test@example.invalid")
  git("config", "user.name", "Test")
  writeFileSync(join(repo, "a.ts"), "export const a = 1\n")
  writeFileSync(join(repo, "run.sh"), "echo base\n")
  chmodSync(join(repo, "run.sh"), 0o755)
  git("add", "-A")
  git("commit", "-q", "-m", "base")
  const clock = new FakeClock(Date.now())
  const events = new FakeEventSource()
  const tracker = await LaptopTracker.open({ fs: nodeFileSystem(), events, clock, storage: join(base, "journal"), device: "recovery" }, { repository: async (path) => gitRepository(runner, path) })
  await tracker.track({ id: "repo", path: repo, kind: "workspace" })
  const view: JournalView = { store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) }
  const heard = (path: string) => {
    utimesSync(path, clock.now() / 1000, clock.now() / 1000)
    events.changed(path)
  }
  const call = async (id: string, effects: ReportedEffect[], act: () => void) => {
    tracker.activity({ kind: "call", id, edge: "start", at: clock.now(), thread: "T1", session: "S1", turn: "t1", checkout: repo })
    clock.advance(50)
    act()
    clock.advance(50)
    tracker.reported({ thread: "T1", session: "S1", turn: "t1", call: id, status: "completed", endedAt: clock.now(), effects })
    tracker.activity({ kind: "call", id, edge: "end", at: clock.now(), thread: "T1", session: "S1", turn: "t1" })
    await tracker.settled()
  }
  tracker.activity({ kind: "turn", id: "t1", edge: "start", at: clock.now(), thread: "T1", session: "S1", checkout: repo })
  await call("c1", [{ kind: "modify", path: join(repo, "a.ts"), edits: [{ old: "1", new: "2" }] }], () => {
    writeFileSync(join(repo, "a.ts"), "export const a = 2\n")
    heard(join(repo, "a.ts"))
  })
  await call("c2", [{ kind: "create", path: join(repo, "b.ts"), content: "export const b = 1\nexport const c = 2\n" }], () => {
    writeFileSync(join(repo, "b.ts"), "export const b = 1\nexport const c = 2\n")
    heard(join(repo, "b.ts"))
  })
  await call("c3", [{ kind: "modify", path: join(repo, "run.sh"), edits: [{ old: "base", new: "changed" }] }, { kind: "command", command: "npm test", cwd: repo }], () => {
    writeFileSync(join(repo, "run.sh"), "echo changed\n")
    heard(join(repo, "run.sh"))
  })
  tracker.activity({ kind: "turn", id: "t1", edge: "end", at: clock.now(), thread: "T1", session: "S1", checkout: repo })
  clock.advance(15_000)
  tracker.sweep()

  // Changes made: one created, two changed, the command, nothing outside.
  assert.deepEqual(changeSummary(changes(view, "T1")), {
    files: { created: 1, changed: 2, deleted: 0, renamed: 0 },
    lines: { added: 4, removed: 2 },
    commands: 1,
    outside: { named: 0, maybe: 0 },
    maybe: 0,
  })

  // The person throws it away with nothing running.
  clock.advance(5_000)
  git("checkout", "--", "a.ts", "run.sh")
  heard(join(repo, "a.ts"))
  heard(join(repo, "run.sh"))
  rmSync(join(repo, "b.ts"))
  events.changed(join(repo, "b.ts"))
  await tracker.settled()
  assert.equal(git("status", "--porcelain"), "")

  const lost = await lostVersions(tracker, view, { thread: "T1" })
  assert.deepEqual(lost.map((version) => [version.path.slice(repo.length + 1), version.by, version.thread]).sort(), [["a.ts", "thread", "T1"], ["b.ts", "thread", "T1"], ["run.sh", "thread", "T1"]])
  assert.deepEqual((await lostVersions(tracker, view, { path: join(repo, "b.ts") })).map((version) => version.entry), [lost.find((version) => version.path.endsWith("b.ts"))!.entry])

  // Restore: the version comes back whole, with the file's mode, and the journal names the person.
  clock.advance(1_000)
  for (const name of ["a.ts", "b.ts", "run.sh"]) {
    const version = lost.find((found) => found.path.endsWith(name))!
    const { path } = await restoreVersion(tracker, version.root, version.entry)
    heard(path)
  }
  await tracker.settled()
  assert.equal(readFileSync(join(repo, "a.ts"), "utf8"), "export const a = 2\n")
  assert.equal(readFileSync(join(repo, "b.ts"), "utf8"), "export const b = 1\nexport const c = 2\n")
  assert.equal(readFileSync(join(repo, "run.sh"), "utf8"), "echo changed\n")
  assert.equal(statSync(join(repo, "run.sh")).mode & 0o777, 0o755, "the file keeps its mode")
  const restored = tracker.changes(0).filter((entry) => entry.path === "a.ts").at(-1)!
  assert.deepEqual(restored.author, { certainty: "person", via: "editor" })
  assert.deepEqual(await lostVersions(tracker, view, { thread: "T1" }), [], "nothing of T1's is lost any more")
  // What the restore replaced is kept too, so a restore can be undone the same way.
  const undo = await lostVersions(tracker, view, { path: join(repo, "a.ts") })
  assert.ok(undo.some((version) => version.by === "person"), JSON.stringify(undo))

  await assert.rejects(restoreVersion(tracker, "repo", 999_999), /no longer keeps/)
  await tracker.close()
  rmSync(base, { recursive: true, force: true })
})
