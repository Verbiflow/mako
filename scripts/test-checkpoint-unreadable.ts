import "./lib/scratch-git.mjs"
// A file a writer rewrites while a turn's checkpoint reads it ("short read while indexing") costs that checkpoint the
// file, not the checkpoint: Git's add runs again once, and a file it still can't read whole is left out and named in
// the record. A rewind to that checkpoint leaves the file as it finds it and restores the rest. A rewind's own reading
// of the workspace must be whole, so there the same failure still fails.
//
//   npx tsx scripts/test-checkpoint-unreadable.ts
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { Git, GitError, type RunOptions } from "@mako/git"
import type { RewindPlan } from "@mako/host/contracts/workspace-snapshots"
import { WorkspaceSnapshots } from "@mako/host/workspaces/snapshots"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-checkpoint-unreadable-")))
const cwd = join(root, "workspace")
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
const file = (path: string, text: string) => writeFileSync(join(cwd, path), text)
const read = (path: string) => readFileSync(join(cwd, path), "utf8")
const plan = (targetId: string, expectedId: string): RewindPlan => ({
  sourceId: randomUUID(), targetId, expectedId, fork: { id: randomUUID(), provider: "test", point: { kind: "run", requestId: randomUUID() } },
})

// Git's own words when a file shrinks under it as it indexes it: what a writer that truncates and writes again causes.
const shortRead = (path: string) => new GitError({
  kind: "failed", command: "add", code: 128,
  stderr: `error: short read while indexing ${path}\nerror: ${path}: failed to insert into database\nerror: unable to index file '${path}'\nfatal: updating files failed`,
})
/** An add's pathspecs from stdin (`--pathspec-from-file=-`), when it reads them there. */
const Listed = z.string()
// Each path's adds still to fail: an add that would take it fails as Git does, unless it's left out.
const failing = new Map<string, number>()
const adds: string[][] = []
const runner = new Git()
const run = runner.run.bind(runner)
runner.run = async (options: RunOptions) => {
  if (options.args.includes("add")) {
    adds.push([...options.args])
    const listed = Listed.safeParse(options.input).data?.split("\0") ?? []
    for (const [path, left] of failing) {
      const takes = options.args.includes(".") ? !options.args.includes(`:(exclude,literal)${path}`) : listed.includes(path)
      if (takes && left > 0) {
        failing.set(path, left - 1)
        throw shortRead(path)
      }
    }
  }
  return run(options)
}
const store = new WorkspaceSnapshots(runner, join(root, "store"))
const Row = z.object({ value: z.string() })
const Saved = z.object({ unreadable: z.array(z.string()).optional() }).loose()
const record = (id: string) => {
  const db = new DatabaseSync(join(root, "store", "snapshots.sqlite"), { readOnly: true })
  try {
    return Saved.parse(JSON.parse(Row.parse(db.prepare("SELECT value FROM snapshots WHERE id=?").get(id)).value))
  } finally {
    db.close()
  }
}

try {
  execFileSync("git", ["init", "-q", cwd])
  git("config", "user.email", "test@localhost")
  git("config", "user.name", "Test")
  file("racing.txt", "committed racing\n")
  file("steady.txt", "committed steady\n")
  git("add", ".")
  git("commit", "-qm", "initial")

  // Once: the second read takes it whole, and the checkpoint is complete.
  file("racing.txt", "before turn one\n")
  failing.set("racing.txt", 1)
  const once = randomUUID()
  const first = await store.beginRun(once, cwd)
  assert.equal(failing.get("racing.txt"), 0, "the add met the rewrite")
  assert.equal(record(first.id).unreadable, undefined, "a file read whole the second time is in the checkpoint")
  await store.endRun(once)
  console.log("PASS: a file rewritten as the checkpoint read it is read again, and taken")

  // Every time: the checkpoint is taken without it, and says so.
  file("racing.txt", "before turn two\n")
  file("steady.txt", "before turn two\n")
  failing.set("racing.txt", Number.POSITIVE_INFINITY)
  adds.length = 0
  const twice = randomUUID()
  const before = await store.beginRun(twice, cwd)
  assert.deepEqual(record(before.id).unreadable, ["racing.txt"], "the checkpoint names the file it couldn't read")
  assert.ok(adds.at(-1)?.includes(":(exclude,literal)racing.txt"), "and its last add left it out")
  assert.equal(adds.length, 3, "one add, the same again, then one without the file")
  // The turn edits both.
  file("racing.txt", "the turn's racing\n")
  file("steady.txt", "the turn's steady\n")
  failing.delete("racing.txt")
  await store.endRun(twice)
  console.log("PASS: a file still rewritten the second time is left out of the checkpoint, which names it")

  // A rewind to it restores what it holds and leaves the file it doesn't as it is.
  const preview = await store.preview(before.id)
  assert.deepEqual(preview.changedFiles, ["steady.txt"], "the rewind would change only what the checkpoint read")
  await store.restore(plan(before.id, preview.current.id), () => {})
  assert.equal(read("steady.txt"), "before turn two\n", "what the checkpoint held is restored")
  assert.equal(read("racing.txt"), "the turn's racing\n", "the file it couldn't read is left as it was, not set to what the index held")
  console.log("PASS: a rewind to it restores the rest and leaves that file as it finds it")

  // A rewind's reading of the workspace as it is must be whole: the same failure there fails it.
  failing.set("racing.txt", Number.POSITIVE_INFINITY)
  await assert.rejects(store.preview(before.id), /unable to index file 'racing\.txt'/, "a rewind never acts on a part read")
  failing.delete("racing.txt")
  console.log("PASS: a rewind's own reading of the workspace still fails rather than leave a file out")
} finally {
  store.close()
  await runner.close()
  rmSync(root, { recursive: true, force: true })
}
