import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { WorktreeOrigins } from "../electron/worktree-origins.js"

/**
 * Which worktree a session's folder is in, against real repositories:
 * worktrees made by `git worktree add` where Claude, Codex and Cursor put
 * theirs, a submodule-style `.git` file, removal, and the memory two hosts
 * share.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-origins-")))
const repo = join(root, "app")
const other = join(root, "other")
const plain = join(root, "plain")
const memory = join(root, "home", ".mako", "worktree-origins.json")

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function init(dir: string): void {
  mkdirSync(dir, { recursive: true })
  git(dir, "init", "-q", "-b", "main")
  writeFileSync(join(dir, "a.txt"), "one\n")
  git(dir, "add", "a.txt")
  git(dir, "-c", "user.email=test@example.invalid", "-c", "user.name=Test", "commit", "-q", "-m", "first")
}

try {
  init(repo)
  init(other)
  mkdirSync(join(repo, "web"))
  mkdirSync(plain)
  const claude = join(repo, ".claude", "worktrees", "fix-login")
  const codex = join(root, "home", ".codex", "worktrees", "a1b2", "app")
  const cursor = join(root, "home", ".cursor", "worktrees", "other", "tidy")
  git(repo, "worktree", "add", "-q", "-b", "worktree-fix-login", claude)
  git(repo, "worktree", "add", "-q", "--detach", codex)
  git(other, "worktree", "add", "-q", "-b", "tidy", cursor)
  mkdirSync(join(claude, "web"))

  const origins = new WorktreeOrigins(memory)
  assert.equal(origins.of(repo), undefined, "a main checkout is no worktree")
  assert.equal(origins.of(join(repo, "web")), undefined, "nor is a folder inside it")
  assert.equal(origins.of(plain), undefined, "nor a folder in no repository")
  assert.deepEqual(origins.of(claude), { path: claude, repoRoot: repo }, "Claude's worktree, inside the repository")
  assert.deepEqual(origins.of(join(claude, "web")), { path: claude, repoRoot: repo }, "a folder inside a worktree names the worktree")
  assert.deepEqual(origins.of(codex), { path: codex, repoRoot: repo }, "Codex's detached worktree, outside the repository")
  assert.deepEqual(origins.of(cursor), { path: cursor, repoRoot: other }, "Cursor's, of another repository")
  if (root.startsWith("/private/")) {
    const spelled = codex.slice("/private".length)
    assert.deepEqual(origins.of(spelled), { path: spelled, repoRoot: repo.slice("/private".length) },
      "asked without /private, the worktree and its repository are named that way too")
  }

  const submodule = join(root, "vendored")
  mkdirSync(join(submodule), { recursive: true })
  mkdirSync(join(repo, ".git", "modules", "vendored"), { recursive: true })
  writeFileSync(join(submodule, ".git"), `gitdir: ${join(repo, ".git", "modules", "vendored")}\n`)
  assert.equal(origins.of(submodule), undefined, "a submodule's .git file points without a commondir, so it's no worktree")

  // Every folder a catalog could hold, twice: the first pass reads the disk, the second only memory.
  const folders = Array.from({ length: 400 }, (_, index) => join([repo, claude, codex, plain][index % 4] ?? repo, `deep/${index}`))
  for (const folder of folders) mkdirSync(folder, { recursive: true })
  const fresh = new WorktreeOrigins(join(root, "unused.json"))
  let started = performance.now()
  for (const folder of folders) fresh.of(folder)
  const cold = performance.now() - started
  started = performance.now()
  for (const folder of folders) fresh.of(folder)
  const warm = performance.now() - started
  assert.deepEqual(fresh.of(join(codex, "deep/2")), { path: codex, repoRoot: repo })

  await origins.flush()
  git(repo, "worktree", "remove", "--force", codex)
  git(repo, "worktree", "remove", "--force", claude)
  assert.deepEqual(origins.of(codex), { path: codex, repoRoot: repo }, "a worktree removed while the host runs keeps its sessions under the project")
  const restarted = new WorktreeOrigins(memory)
  assert.deepEqual(restarted.of(codex), { path: codex, repoRoot: repo }, "and after a restart, from the remembered file")
  assert.deepEqual(restarted.of(join(codex, "web")), { path: codex, repoRoot: repo }, "so does a folder that was inside it")
  if (root.startsWith("/private/")) {
    // Hosts remember whichever spelling they saw; a recalled worktree is named the way it's asked about.
    const unprivate = (path: string) => path.slice("/private".length)
    const recall = (spelling: string, asked: string) => {
      const file = join(root, `recall-${randomUUID()}.json`)
      writeFileSync(file, JSON.stringify({ worktrees: { [spelling === "private" ? codex : unprivate(codex)]: { repoRoot: spelling === "private" ? repo : unprivate(repo), seenAt: Date.now() } } }))
      return new WorktreeOrigins(file).of(asked)
    }
    assert.deepEqual(recall("plain", codex), { path: codex, repoRoot: repo }, "remembered without /private, asked with it")
    assert.deepEqual(recall("private", unprivate(codex)), { path: unprivate(codex), repoRoot: unprivate(repo) }, "remembered with /private, asked without it")
  }
  const neverSeen = new WorktreeOrigins(join(root, "empty.json"))
  assert.deepEqual(neverSeen.of(join(repo, ".claude", "worktrees", "gone", "web")), { path: join(repo, ".claude", "worktrees", "gone"), repoRoot: repo },
    "a Claude worktree removed before any host saw it is named by its path")
  assert.equal(neverSeen.of(join(root, "home", ".codex", "worktrees", "ffff", "app")), undefined, "a removed Codex worktree nobody saw stays unknown")

  // Hosts that each found a worktree and save at the same moment keep them all.
  const SavedSchema = z.object({ worktrees: z.record(z.string(), z.object({ repoRoot: z.string() })) })
  const second = join(root, "second")
  git(other, "worktree", "add", "-q", "-b", "second", second)
  const hostA = new WorktreeOrigins(memory)
  const hostB = new WorktreeOrigins(memory)
  hostA.of(cursor)
  hostB.of(second)
  await Promise.all([hostA.flush(), hostB.flush()])
  const saved = SavedSchema.parse(JSON.parse(readFileSync(memory, "utf8")))
  assert.equal(saved.worktrees[cursor]?.repoRoot, other, "the first host's worktree")
  assert.equal(saved.worktrees[second]?.repoRoot, other, "the second host's, merged rather than overwritten")
  assert.equal(saved.worktrees[codex]?.repoRoot, repo, "and the one removed earlier")
  const together = join(root, "together.json")
  const theirs = Array.from({ length: 6 }, (_, index) => join(root, `together-${index}`))
  for (const worktree of theirs) git(other, "worktree", "add", "-q", "--detach", worktree)
  const hosts = theirs.map((worktree) => {
    const host = new WorktreeOrigins(together)
    host.of(worktree)
    return host
  })
  await Promise.all(hosts.map((host) => host.flush()))
  const savedTogether = SavedSchema.parse(JSON.parse(readFileSync(together, "utf8"))).worktrees
  assert.deepEqual(theirs.filter((worktree) => !savedTogether[worktree]), [], "six hosts saving at once keep every host's worktree")
  assert.equal(existsSync(`${memory}.lock`) || existsSync(`${together}.lock`), false, "no save leaves its lock behind")

  // A host that died mid-save doesn't stop the others saving.
  const third = join(root, "third")
  git(other, "worktree", "add", "-q", "-b", "third", third)
  writeFileSync(`${memory}.lock`, "")
  const died = new Date(Date.now() - 60_000)
  utimesSync(`${memory}.lock`, died, died)
  const hostC = new WorktreeOrigins(memory)
  hostC.of(third)
  await hostC.flush()
  assert.equal(SavedSchema.parse(JSON.parse(readFileSync(memory, "utf8"))).worktrees[third]?.repoRoot, other, "saved past a lock left by a host that died")

  writeFileSync(memory, "{\"worktrees\": {\"torn")
  assert.equal(new WorktreeOrigins(memory).of(join(root, "home", ".codex", "worktrees", "a1b2", "app", "x")), undefined,
    "a torn file starts the memory over without failing")

  console.log("worktree origins: main checkout, subfolder, no repository, Claude/Codex/Cursor worktrees, /private spelling, submodule, removed while running, after restart, recalled in the asked spelling, removed unseen, hosts saving at once, a dead host's lock, torn file")
  console.log(`${folders.length} folders: ${cold.toFixed(1)} ms first, ${warm.toFixed(2)} ms again`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
