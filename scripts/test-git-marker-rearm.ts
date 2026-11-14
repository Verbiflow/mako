import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { promisify } from "node:util"
import { watchGitMarkers, type GitDirWatch } from "@mako/host/workspaces/git-dir-watch"

const root = fs.mkdtempSync(join(tmpdir(), "mako-ref-rearm-"))
let watching: GitDirWatch | undefined
try {
  const target = join(root, "prefix")
  const callbacks: (() => void)[] = []
  let appeared = false, changes = 0
  mock.method(fs, "watch", (_path: fs.PathLike, _options: fs.WatchOptions, listener: fs.WatchListener<string>) => {
    callbacks.push(() => listener("rename", "prefix"))
    return Object.assign(new EventEmitter(), {
      close() { if (!appeared) { appeared = true; fs.mkdirSync(target) } },
      ref() { return this }, unref() { return this }, [Symbol.dispose]() { this.close() },
    })
  })
  syncBuiltinESMExports()
  watching = watchGitMarkers(root, () => changes++, ["prefix"])
  // The callback's stamp is still missing. Closing the parent watch makes it appear before arm's stamp.
  callbacks[0]!()
  assert.equal(changes, 1, "appearance between the callback and rearm stamps must be announced")
  callbacks[1]!()
  assert.equal(changes, 1, "the same unchanged path is not announced twice")
  watching.close(); watching = undefined
  mock.restoreAll(); syncBuiltinESMExports()

  const run = promisify(execFile)
  const git = (...args: string[]) => run("git", args, { cwd: root })
  await git("init", "-q", "-b", "main")
  await git("-c", "user.email=fixture@example.invalid", "-c", "user.name=Fixture", "commit", "-qm", "Fixture", "--allow-empty")
  await git("init", "-q", "--bare", join(root, "origin.git"))
  await git("remote", "add", "origin", join(root, "origin.git"))
  let pushes = 0
  watching = watchGitMarkers(join(root, ".git"), () => pushes++, ["refs/remotes/origin/new/prefix"])
  await watching.ready
  await git("push", "-q", "origin", "HEAD:refs/heads/new/prefix/fixture")
  for (const deadline = performance.now() + 10_000; !pushes; await new Promise(resolve => setTimeout(resolve, 25))) {
    if (performance.now() > deadline) throw new Error("First push to a missing remote prefix was not heard")
  }
  console.log("Git markers: appearance during rearm, unchanged-path dedup and actual first push to a new prefix passed")
} finally {
  watching?.close(); mock.restoreAll(); syncBuiltinESMExports()
  fs.rmSync(root, { recursive: true, force: true })
}
