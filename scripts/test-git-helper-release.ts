import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync, type spawn } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import { closeHostChild, hostSpawn } from "@mako/host/base/host-command"
import { GitHelper } from "@mako/host/git/git-helper"

/**
 * A `git` the helper ran is collected once it's done (`npm run test:git-helper-release`, with `--expose-gc`). Each is
 * a `ChildProcess` the host never spawned, and Node's constructor gave every one a native process handle that was
 * never closed: the handle held its owner, with its output, from the host's roots for the host's life. Under
 * bench:host-load's sends (2026-11-12) the host held 6,988 of them after 20 sends and 25,673 after 80, retaining
 * 426 MB and then 1,133 MB of live heap, about 13.7 MB a send.
 */

const exposed = globalThis.gc
if (!exposed) throw new Error("run with --expose-gc")
const gc: () => void = exposed
const RUNS = 200

const root = mkdtempSync(join(tmpdir(), "mako-git-helper-release-"))
const repo = join(root, "repo")
execFileSync("git", ["init", "-q", repo])
writeFileSync(join(repo, "a.txt"), "a\n".repeat(50_000))
execFileSync("git", ["-C", repo, "add", "."])
execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"])

const helper = new GitHelper({ spawn: hostSpawn, close: closeHostChild })
const runner = helper.runner()
let spawned = 0
let collected = 0
const children = new FinalizationRegistry<number>(() => { collected++ })
// SAFETY: the runner's own `spawn` (`GitHelper.runner`), called with the arguments `Git` gave it, and its child
// handed back as it is: the same overloads it already answers to, as the helper's own wrapper declares them.
const noting = ((...args: Parameters<typeof runner.spawn>) => {
  const child = runner.spawn(...args)
  children.register(child, spawned++)
  return child
}) as typeof spawn
// The helper's runner, noting each child it hands out so its collection can be counted.
const git = new Git({ processes: { spawn: noting, close: (child, first) => runner.close(child, first) } })

try {
  for (let run = 0; run < RUNS; run++) {
    const result = await git.run({ cwd: repo, args: ["cat-file", "-p", "HEAD:a.txt"] })
    assert.equal(result.stdout.length, 100_000)
  }
  assert.ok(helper.pid(), "the runs went through the helper")
  assert.equal(spawned, RUNS)
  for (let attempt = 0; attempt < 40 && collected < spawned; attempt++) {
    gc()
    await new Promise((resume) => setTimeout(resume, 20))
  }
  assert.ok(collected >= spawned - 2, `the helper's children are collected once done: ${collected} of ${spawned}`)
  console.log(`git helper release: ${collected} of ${spawned} finished children collected`)
} finally {
  await helper.stop()
  rmSync(root, { recursive: true, force: true })
}
