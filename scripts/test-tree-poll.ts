import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { pollTree } from "../electron/tree-poll.ts"
import { QUIET } from "../electron/tree-watcher.ts"

const run = promisify(execFile)
const git = (cwd: string, ...args: string[]) => run("git", ["-c", "user.email=test@example.invalid", "-c", "user.name=Test", ...args], { cwd })
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-tree-poll-")))

function recorder() {
  const heard: string[] = []
  return {
    heard,
    onChange: (paths: string[]) => heard.push(...paths),
    async hears(path: string, what: string) {
      for (const deadline = Date.now() + 8000; !heard.includes(path); await wait(25)) assert.ok(Date.now() < deadline, what)
      heard.length = 0
    },
  }
}
// The first poll only takes stock; a change must land after it to be reported.
const settled = () => wait(400)

try {
  const repo = join(root, "repo")
  mkdirSync(join(repo, "src"), { recursive: true })
  writeFileSync(join(repo, ".gitignore"), "node_modules/\n")
  writeFileSync(join(repo, "a.txt"), "a\n")
  writeFileSync(join(repo, "src", "b.ts"), "b\n")
  await git(repo, "init", "-q", "-b", "main")
  await git(repo, "add", ".")
  await git(repo, "commit", "-qm", "first")

  const inRepo = recorder()
  const poll = pollTree(repo, QUIET, inRepo.onChange)
  await settled()
  writeFileSync(join(repo, "a.txt"), "a2\n")
  await inRepo.hears("a.txt", "an edit to a clean file")
  writeFileSync(join(repo, "a.txt"), "a3, longer\n")
  await inRepo.hears("a.txt", "another edit to the same, already dirty, file")
  mkdirSync(join(repo, "src", "fresh"))
  writeFileSync(join(repo, "src", "fresh", "new.ts"), "new\n")
  await inRepo.hears("src/fresh/new.ts", "a new file in a new folder")
  mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true })
  writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "")
  await git(repo, "add", "-A")
  await git(repo, "commit", "-qm", "second")
  await inRepo.hears(".git/logs/HEAD", "a commit appends to HEAD's reflog")
  assert.equal(inRepo.heard.some((path) => path.startsWith("node_modules")), false, "what Git ignores is never reported")
  poll.close()
  writeFileSync(join(repo, "a.txt"), "after close\n")
  await wait(2500)
  assert.equal(inRepo.heard.includes("a.txt"), false, "nothing after close")

  const sub = recorder()
  const subPoll = pollTree(join(repo, "src"), QUIET, sub.onChange)
  await settled()
  writeFileSync(join(repo, "src", "b.ts"), "b2\n")
  await sub.hears("b.ts", "a folder inside a repository hears its files relative to itself")
  writeFileSync(join(repo, "a.txt"), "outside src\n")
  await wait(2500)
  assert.equal(sub.heard.some((path) => path.startsWith("..")), false, "and nothing outside it")
  subPoll.close()

  const link = join(root, "link")
  symlinkSync(repo, link)
  const linked = recorder()
  const linkPoll = pollTree(link, QUIET, linked.onChange)
  await settled()
  writeFileSync(join(repo, "a.txt"), "through a link\n")
  await linked.hears("a.txt", "a repository reached through a symlink hears its files")
  linkPoll.close()

  const plain = join(root, "plain")
  mkdirSync(join(plain, "docs"), { recursive: true })
  mkdirSync(join(plain, "node_modules"))
  writeFileSync(join(plain, "docs", "one.md"), "1\n")
  const walked = recorder()
  const walk = pollTree(plain, QUIET, walked.onChange)
  await settled()
  writeFileSync(join(plain, "docs", "two.md"), "2\n")
  await walked.hears("docs/two.md", "a folder outside Git hears a new file")
  writeFileSync(join(plain, "docs", "one.md"), "1, edited\n")
  await walked.hears("docs/one.md", "an edit")
  rmSync(join(plain, "docs", "two.md"))
  await walked.hears("docs/two.md", "a deletion")
  writeFileSync(join(plain, "node_modules", "dep.js"), "")
  await wait(2500)
  assert.equal(walked.heard.some((path) => path.startsWith("node_modules")), false, "quiet folders are never walked")
  walk.close()

  console.log("tree poll: in a repository, edits to clean and dirty files, new files and commits are heard, ignored files aren't, a subfolder hears only itself, a symlinked root works; outside Git, creates, edits and deletes are heard and quiet folders skipped; close is final")
} finally {
  rmSync(root, { recursive: true, force: true })
}
