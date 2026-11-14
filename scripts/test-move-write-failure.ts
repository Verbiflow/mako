import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import fsp from "node:fs/promises"
import { syncBuiltinESMExports } from "node:module"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Git } from "@mako/git"
import { mapLimit } from "@mako/host/base/map-limit"
import { rewriteInPlace, type InPlaceFile } from "@mako/host/workspaces/worktree-move"

const tick = (ms: number) => new Promise((done) => setTimeout(done, ms))

test("mapLimit starts nothing after a failure, waits for what started, then rejects with the first error", async () => {
  const started: number[] = []
  const settled: number[] = []
  const failing = mapLimit([0, 1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    started.push(value)
    if (value === 0) {
      await tick(5)
      throw new Error("first")
    }
    if (value === 1) {
      await tick(10)
      throw new Error("second")
    }
    await tick(40)
    settled.push(value)
    return value
  })
  await assert.rejects(failing, /first/)
  // 0, 1 and 2 had started when 0 failed; 2 was still writing and is waited for, and nothing after it starts.
  assert.deepEqual(started, [0, 1, 2])
  assert.deepEqual(settled, [2])
  assert.deepEqual(await mapLimit([3, 1, 2], 2, async (value) => (await tick(value), value * 2)), [6, 2, 4])
  assert.deepEqual(await mapLimit([], 4, async () => 1), [])
})

test("a disk that fills mid-rewrite: every file is put back, the writes still in flight included", async () => {
  const base = mkdtempSync(join(tmpdir(), "mako-move-enospc-"))
  try {
    const repo = join(base, "repo")
    const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
    execFileSync("git", ["init", "-q", repo])
    git("config", "user.email", "test@example.invalid")
    git("config", "user.name", "Test")
    // More files than the rewrite writes at once.
    const count = 40
    const before = (index: number) => `${index}\n`.repeat(2_000)
    const after = (index: number) => `${index} rewritten\n`.repeat(2_000)
    const paths = Array.from({ length: count }, (_, index) => `src/file-${String(index).padStart(2, "0")}.ts`)
    execFileSync("mkdir", ["-p", join(repo, "src")])
    paths.forEach((path, index) => writeFileSync(join(repo, path), before(index)))
    git("add", "-A")
    git("commit", "-qm", "base")
    const head = git("rev-parse", "HEAD")
    const files = paths.map((path, index): InPlaceFile => ({ path, before: Buffer.from(before(index)), after: Buffer.from(after(index)) }))

    // The disk fills at the third file the rewrite writes, and every rename into the checkout takes a while: when the
    // write fails, the first two files are still on their way in. Injected where the rewrite meets the disk, so the
    // failure is the filesystem's own rejection, not a hook's.
    const real = { writeFile: fsp.writeFile, rename: fsp.rename }
    let writes = 0
    // The rewrite stages each file in `.git/mako-move/` and renames it into the checkout.
    const staged = (path: Parameters<typeof fsp.rename>[0] | Parameters<typeof fsp.writeFile>[0]) => String(path).includes(`${join(".git", "mako-move")}/`)
    fsp.writeFile = async (file, data, options) => {
      if (staged(file) && ++writes === 3) throw Object.assign(new Error(`ENOSPC: no space left on device, write '${String(file)}'`), { code: "ENOSPC", errno: -28, syscall: "write" })
      return real.writeFile(file, data, options)
    }
    fsp.rename = async (from, to) => {
      if (staged(from)) await tick(200)
      return real.rename(from, to)
    }
    syncBuiltinESMExports()
    try {
      await assert.rejects(
        rewriteInPlace({ git: new Git(), ledger: undefined, id: "enospc", thread: "T1", project: repo, repositories: [{ repoRoot: repo, head, files }], message: "before", save: async () => {}, log: () => {} }),
        (error: Error) => /no space left on device/.test(error.message) && error.message.includes("refs/mako/moves/enospc") && !/except/.test(error.message),
      )
    } finally {
      Object.assign(fsp, real)
      syncBuiltinESMExports()
    }
    // Whatever was still on its way in has landed by now.
    await tick(500)
    const wrong = paths.filter((path, index) => readFileSync(join(repo, path), "utf8") !== before(index))
    assert.deepEqual(wrong, [], `every file put back: ${wrong.length} of ${count} left rewritten`)
    assert.equal(git("status", "--porcelain"), "", "the checkout is as it was")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
