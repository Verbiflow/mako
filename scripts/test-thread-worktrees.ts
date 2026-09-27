import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Actor } from "../electron/contracts/thread-identity.js"
import { ThreadStore } from "../electron/thread-store.js"
import { ThreadWorktreeService, worktreeSlug } from "../electron/thread-worktrees.js"

/**
 * A Thread's worktree against a real repository: where it goes, what it
 * carries from the main checkout, that a repeated or interrupted start finds
 * the first one, and what removal refuses.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-worktrees-")))
const migration: Actor = { kind: "service", name: "migration" }

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function repository(name: string, commit = true): string {
  const path = join(root, name)
  mkdirSync(join(path, "web"), { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.invalid")
  git(path, "config", "user.name", "Test")
  writeFileSync(join(path, ".gitignore"), "node_modules/\ndist/\n.env\n.env.*\n")
  writeFileSync(join(path, "web", "index.ts"), "export {}\n")
  // Past Git's threshold, so the checkout runs its parallel workers.
  mkdirSync(join(path, "web", "generated"))
  for (let n = 0; n < 150; n += 1) writeFileSync(join(path, "web", "generated", `part-${n}.ts`), `export const part = ${n}\n`)
  writeFileSync(join(path, ".env"), "API=1\n")
  writeFileSync(join(path, ".env.local"), "LOCAL=1\n")
  mkdirSync(join(path, "node_modules", "left-pad"), { recursive: true })
  writeFileSync(join(path, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
  mkdirSync(join(path, "dist"))
  writeFileSync(join(path, "dist", "app.js"), "\n")
  if (commit) {
    git(path, "add", ".")
    git(path, "commit", "-q", "-m", "first")
  }
  return path
}

const busy = new Map<string, string[]>()
const threads = new ThreadStore(join(root, "threads.sqlite"))
const service = () => new ThreadWorktreeService(join(root, "worktrees"), threads, async (path) => busy.get(path) ?? [])

function started(conversationId: string) {
  return threads.registerJournal({ conversationId, createdAt: Date.now(), bindings: [], harness: "codex" }, migration)
}

assert.equal(worktreeSlug("Fix the login redirect please"), "fix-login-redirect")
assert.equal(worktreeSlug("Can you make the checkout page load faster on mobile"), "make-checkout-page-load")
assert.equal(worktreeSlug("¿Qué?"), "que")
assert.equal(worktreeSlug(""), "thread")

const shop = repository("shop")
const worktrees = service()

// Started from a subfolder, the conversation runs in the same subfolder of the worktree.
const first = randomUUID()
const [prepared, again] = await Promise.all([
  worktrees.prepare(first, join(shop, "web"), "Fix the login redirect"),
  worktrees.prepare(first, join(shop, "web"), "Fix the login redirect"),
])
assert.deepEqual(again, prepared, "two starts of one conversation make one worktree")
assert.equal(prepared.branch, "mako/fix-login-redirect")
assert.equal(prepared.cwd, join(prepared.path, "web"))
assert.match(prepared.path, /\/worktrees\/shop-[0-9a-f]{8}\/fix-login-redirect$/)
assert.equal(git(prepared.path, "rev-parse", "--abbrev-ref", "HEAD"), "mako/fix-login-redirect")
assert.equal(git(prepared.path, "rev-parse", "HEAD"), git(shop, "rev-parse", "HEAD"), "it starts from the checkout's commit")
assert.equal(git(prepared.path, "ls-files").split("\n").length, git(shop, "ls-files").split("\n").length, "every tracked file is checked out")
assert.equal(git(prepared.path, "status", "--porcelain"), "", "a parallel checkout leaves a clean worktree")
assert.equal(readFileSync(join(prepared.path, "web", "generated", "part-149.ts"), "utf8"), "export const part = 149\n")

// Mako's list of gitignored inputs comes along; dependencies and builds don't.
assert.equal(prepared.copied, 2)
assert.equal(readFileSync(join(prepared.path, ".env"), "utf8"), "API=1\n")
assert.equal(readFileSync(join(prepared.path, ".env.local"), "utf8"), "LOCAL=1\n")
assert.equal(existsSync(join(prepared.path, "node_modules")), false)
assert.equal(existsSync(join(prepared.path, "dist")), false)

// Another Thread with the same words gets the next free name.
const second = randomUUID()
const other = await worktrees.prepare(second, shop, "fix the login redirect")
assert.equal(other.branch, "mako/fix-login-redirect-2")
assert.equal(other.cwd, other.path)

// Recorded against the Thread its conversation joined, once it has one.
const placed = started(first)
await worktrees.attach(first)
assert.deepEqual(threads.worktrees().map(({ path, thread, branch, repoRoot }) => ({ path, thread, branch, repoRoot })), [
  { path: prepared.path, thread: placed.thread, branch: prepared.branch, repoRoot: shop },
])

// A start that finished before the host stopped is attached by the next list.
started(second)
const listed = await worktrees.list()
assert.deepEqual(listed.worktrees.map((worktree) => worktree.path).sort(), [prepared.path, other.path].sort())

// Cut short between `git worktree add` and the copy: the next start finishes it.
const third = randomUUID()
const interrupted = await worktrees.prepare(third, shop, "tidy settings")
rmSync(join(interrupted.path, ".env"))
const receipt = join(root, "worktrees", "receipts", `${third}.json`)
writeFileSync(receipt, JSON.stringify({ ...JSON.parse(readFileSync(receipt, "utf8")), state: "creating" }))
const resumed = await service().prepare(third, shop, "a different title now")
assert.equal(resumed.path, interrupted.path, "the receipt keeps the first name")
assert.equal(existsSync(join(resumed.path, ".env")), true)

// Removal: never while something runs there, never with uncommitted work, and the branch stays.
busy.set(prepared.path, ["“Fix the login redirect”", "the terminal “zsh”"])
await assert.rejects(worktrees.remove(prepared.path), /fix-login-redirect is in use by “Fix the login redirect”, the terminal “zsh”\. Stop them/)
busy.delete(prepared.path)
writeFileSync(join(prepared.path, "web", "draft.ts"), "export const draft = 1\n")
await assert.rejects(worktrees.remove(prepared.path), /has changes that aren't committed/)
assert.equal(existsSync(join(prepared.path, "web", "draft.ts")), true, "a refused removal deletes nothing")
rmSync(join(prepared.path, "web", "draft.ts"))
const after = await worktrees.remove(prepared.path)
assert.equal(existsSync(prepared.path), false)
assert.deepEqual(after.worktrees.map((worktree) => worktree.path), [other.path])
assert.equal(git(shop, "branch", "--list", "mako/fix-login-redirect"), "mako/fix-login-redirect", "the branch keeps committed work")
await assert.rejects(worktrees.remove(join(root, "elsewhere")), /Mako didn't make this worktree/)

// Deleted outside Mako: forgotten on the next list.
git(shop, "worktree", "remove", "--force", other.path)
assert.deepEqual((await worktrees.list()).worktrees, [])

// Folders that can't have one say what to do instead.
const plain = join(root, "plain")
mkdirSync(plain)
await assert.rejects(worktrees.prepare(randomUUID(), plain, "x"), /plain isn't in a Git repository.*Switch to Local/)
const empty = repository("empty", false)
await assert.rejects(worktrees.prepare(randomUUID(), empty, "x"), /no commits yet/)

threads.close()
rmSync(root, { recursive: true, force: true })
console.log("thread worktrees: names, subfolder, carried inputs, one per conversation, attach, resume, in-use, dirty, branch kept, outside removal, refusals")
