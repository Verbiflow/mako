import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { quietFoldersOf, watchTree } from "../electron/tree-watcher.js"
import { watchOutsideGitDir } from "../electron/git-dir-watch.js"

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-tree-watcher-")))
// FSEvents can deliver seconds late on a busy Mac, but in order: once a
// marker written after a change arrives, the change has arrived too.
const heard: string[] = []
let markers = 0
async function drained(): Promise<void> {
  const marker = `marker-${++markers}`
  writeFileSync(join(root, marker), "")
  for (let waited = 0; !heard.includes(marker); waited += 50) {
    assert.ok(waited < 90_000, `file events arrive (${marker})`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

try {
  assert.equal(watchTree("/", () => {}, () => {}), undefined, "the filesystem root isn't watched")
  assert.equal(watchTree(homedir(), () => {}, () => {}), undefined, "nor the home folder")

  const many = join(root, "many")
  for (const name of ["node_modules", "dist", ".next", "target"]) mkdirSync(join(many, name), { recursive: true })
  for (let index = 0; index < 10; index++) mkdirSync(join(many, "packages", `p${index}`, "node_modules"), { recursive: true })
  const quiet = quietFoldersOf(many)
  assert.equal(quiet.length, 8, "at most eight: FSEvents ignores a longer list")
  assert.deepEqual(quiet.slice(0, 4), ["node_modules", ".next", "dist", "target"].map((name) => join(many, name)), "the project's own first")

  mkdirSync(join(root, "src"))
  let failed = false
  const watch = watchTree(root, (paths) => heard.push(...paths), () => {
    failed = true
  })
  assert.ok(watch)
  await watch.ready
  await drained()

  mkdirSync(join(root, "node_modules", "left-pad"), { recursive: true })
  await drained()
  // The first install starts the watch over with node_modules excluded at the source.
  await new Promise((resolve) => setTimeout(resolve, 500))
  for (let index = 0; index < 200; index++) writeFileSync(join(root, "node_modules", "left-pad", `f${index}.js`), "")
  writeFileSync(join(root, "src", "index.ts"), "export {}\n")
  await drained()
  assert.equal(heard.some((path) => path.startsWith("node_modules")), false, "dependency writes never arrive")
  assert.ok(heard.includes("src/index.ts"), "source writes do")
  assert.equal(failed, false)
  watch.close()

  // A linked worktree's Git directory is outside it, so its commits are heard through the index and reflog.
  // Run as other processes, the way commits reach the host: libuv arms a watch at its next poll, which a blocking call would hold off.
  const run = promisify(execFile)
  const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args], { cwd })
  const repo = join(root, "repo")
  mkdirSync(repo)
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "commit", "-q", "--allow-empty", "-m", "first")
  const linked = join(root, "linked")
  await git(repo, "worktree", "add", "-q", "-b", "side", linked)
  let commits = 0
  const outside = watchOutsideGitDir(linked, () => { commits += 1 })
  let insideHeard = 0
  const inside = watchOutsideGitDir(repo, () => { insideHeard += 1 })
  await Promise.all([outside.ready, inside.ready])
  const heardCommit = async () => {
    for (const deadline = Date.now() + 5000; commits === 0 && Date.now() < deadline;) await new Promise((resolve) => setTimeout(resolve, 20))
    return commits
  }
  writeFileSync(join(linked, "a.txt"), "a\n")
  await git(linked, "add", "a.txt")
  await git(linked, "commit", "-qm", "a")
  assert.ok(await heardCommit() > 0, "a commit in the worktree is heard")
  commits = 0
  await git(linked, "commit", "-q", "--allow-empty", "-m", "b")
  assert.ok(await heardCommit() > 0, "and the next one, after Git replaced the index")
  await git(repo, "commit", "-q", "--allow-empty", "-m", "c")
  assert.equal(insideHeard, 0, "a Git directory inside the folder is left to the tree watch")
  outside.close()
  inside.close()
  console.log("tree watcher: refuses / and home, excludes eight quiet folders, drops dependency writes, reports source writes; a worktree's commits are heard through its outside Git directory")
} finally {
  rmSync(root, { recursive: true, force: true })
}
