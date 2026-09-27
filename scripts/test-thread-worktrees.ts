import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Actor } from "../electron/contracts/thread-identity.js"
import { ThreadStore } from "../electron/thread-store.js"
import { worktreeSlug } from "../electron/contracts/thread-worktrees.js"
import { ThreadWorktreeService } from "../electron/thread-worktrees.js"

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

// Mako's list of gitignored inputs comes along, then installed dependencies as clones; builds don't.
assert.equal(prepared.copied, 2)
assert.equal(prepared.spare, false, "the project's first worktree has no spare to take")
assert.equal(readFileSync(join(prepared.path, ".env"), "utf8"), "API=1\n")
assert.equal(readFileSync(join(prepared.path, ".env.local"), "utf8"), "LOCAL=1\n")
const dependencies = await worktrees.dependencies(first)
if (process.platform === "darwin") {
  assert.deepEqual(dependencies, { carried: ["node_modules"] })
  assert.equal(readFileSync(join(prepared.path, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1\n")
} else {
  assert.ok(dependencies?.carried.length || dependencies?.skipped, "Linux clones them where the volume shares blocks and says why not elsewhere")
}
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

// The strip counts the Thread's own commits, from the commit it started at.
assert.equal(await worktrees.ahead(prepared.path), 0)
writeFileSync(join(prepared.path, "notes.md"), "thread notes\n")
git(prepared.path, "add", "notes.md")
git(prepared.path, "commit", "-q", "-m", "thread work")
assert.equal(await worktrees.ahead(prepared.path), 1)
assert.equal(await worktrees.ahead(shop), undefined, "the main checkout isn't a Thread worktree")

// A start that finished before the host stopped is attached by the next list.
started(second)
const listed = await worktrees.list()
assert.deepEqual(listed.worktrees.map((worktree) => worktree.path).sort(), [prepared.path, other.path].sort())

// Cleanup reads what decides whether each worktree can go.
const detail = async (path: string) => (await worktrees.inventory()).worktrees.find((worktree) => worktree.path === path)
assert.deepEqual((await detail(prepared.path))?.landing, { kind: "open", into: "main", commits: 1 })
assert.deepEqual((await detail(other.path))?.landing, { kind: "empty" })
writeFileSync(join(other.path, "scratch.txt"), "x\n")
const dirty = await detail(other.path)
assert.equal(dirty?.changes, 1)
assert.ok((dirty?.bytes ?? 0) > 0, "its own files are measured")
rmSync(join(other.path, "scratch.txt"))
busy.set(other.path, ["“Other”"])
assert.deepEqual((await detail(other.path))?.users, ["“Other”"])
busy.delete(other.path)
// A squash merge leaves none of the branch's commits on main; its work landed all the same.
git(shop, "merge", "-q", "--squash", "mako/fix-login-redirect")
git(shop, "commit", "-q", "-m", "squashed")
assert.deepEqual((await detail(prepared.path))?.landing, { kind: "merged", into: "main" })

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
assert.equal(git(shop, "branch", "--list", "mako/fix-login-redirect"), "mako/fix-login-redirect", "the branch keeps committed work, free to check out at once")
await assert.rejects(worktrees.remove(join(root, "elsewhere")), /Mako didn't make this worktree/)

// Deleted outside Mako: forgotten on the next list.
git(shop, "worktree", "remove", "--force", other.path)
assert.deepEqual((await worktrees.list()).worktrees, [])

// Spares: two checkouts of a project that starts worktree Threads, made ahead of time.
const spareRecords = join(root, "worktrees", "spares")
const spares = () => readdirSync(spareRecords).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(spareRecords, name), "utf8")))
await worktrees.settled()
assert.equal(spares().filter((spare) => spare.repoRoot === shop && spare.state === "ready").length, 2, "each worktree start keeps two spares ready")
for (const spare of spares()) {
  assert.match(spare.path, /\/worktrees\/shop-[0-9a-f]{8}\/\.spare-[0-9a-f]{8}$/)
  assert.equal(git(spare.path, "status", "--porcelain"), "")
  assert.match(git(shop, "worktree", "list", "--porcelain"), new RegExp(`worktree ${spare.path}\\nHEAD [0-9a-f]+\\ndetached\\nlocked Mako keeps this checkout ready`))
}

// The send takes one: same name, branch, commit, carried files and subfolder as a fresh checkout.
const fromSpare = randomUUID()
const claimed = await worktrees.prepare(fromSpare, join(shop, "web"), "Speed up search")
assert.equal(claimed.spare, true)
assert.match(claimed.path, /\/shop-[0-9a-f]{8}\/speed-up-search$/)
assert.equal(claimed.cwd, join(claimed.path, "web"))
assert.equal(git(claimed.path, "rev-parse", "--abbrev-ref", "HEAD"), "mako/speed-up-search")
assert.equal(git(claimed.path, "rev-parse", "HEAD"), git(shop, "rev-parse", "HEAD"))
assert.equal(git(claimed.path, "status", "--porcelain"), "")
assert.equal(readFileSync(join(claimed.path, ".env"), "utf8"), "API=1\n")
assert.doesNotMatch(git(shop, "worktree", "list", "--porcelain"), new RegExp(`worktree ${claimed.path}\\n[^\\n]*\\n[^\\n]*\\nlocked`), "a claimed spare isn't locked")
await worktrees.dependencies(fromSpare)
if (process.platform === "darwin") assert.equal(existsSync(join(claimed.path, "node_modules", "left-pad", "index.js")), true, "the spare's cloned dependencies came with it")
await worktrees.settled()
assert.equal(spares().filter((spare) => spare.repoRoot === shop).length, 2, "the taken spare is replaced")

// The main checkout moved on: the spare catches up to its commit.
writeFileSync(join(shop, "web", "index.ts"), "export const moved = true\n")
git(shop, "commit", "-q", "-am", "moved")
const caughtUp = await worktrees.prepare(randomUUID(), shop, "after the move")
assert.equal(caughtUp.spare, true)
assert.equal(git(caughtUp.path, "rev-parse", "HEAD"), git(shop, "rev-parse", "HEAD"))
assert.equal(readFileSync(join(caughtUp.path, "web", "index.ts"), "utf8"), "export const moved = true\n")
assert.equal(git(caughtUp.path, "status", "--porcelain"), "")
await worktrees.settled()

// Dependencies cloned before the lockfile changed don't fit it: they go, and aren't cloned again while it differs.
writeFileSync(join(shop, "package-lock.json"), "{\"lockfileVersion\":3}\n")
const relocked = randomUUID()
const unlocked = await worktrees.prepare(relocked, shop, "lockfile changed")
assert.equal(unlocked.spare, true)
assert.equal(existsSync(join(unlocked.path, "node_modules")), false)
assert.deepEqual(await worktrees.dependencies(relocked), { carried: [], skipped: "package-lock.json differs from the main checkout's" })
rmSync(join(shop, "package-lock.json"))
await worktrees.settled()

// Two hosts sharing the root never take the same spare.
const hosts = [service(), service()]
const [left, right] = await Promise.all([hosts[0].prepare(randomUUID(), shop, "left host"), hosts[1].prepare(randomUUID(), shop, "right host")])
assert.equal(left.spare && right.spare, true)
assert.notEqual(left.path, right.path)
assert.equal(git(left.path, "status", "--porcelain") + git(right.path, "status", "--porcelain"), "")
await Promise.all(hosts.map((host) => host.settled()))
await worktrees.want(shop)
await worktrees.settled()
assert.equal(spares().filter((spare) => spare.repoRoot === shop && spare.state === "ready").length, 2, "one host refills while the other's lock holds")

// A spare half-made by a host that died is given back, as is a record that isn't one; so is a project idle for a day.
const orphan = { ...spares()[0], id: randomUUID(), state: "preparing", pid: 2 ** 22 + 7, path: join(root, "worktrees", "gone") }
writeFileSync(join(spareRecords, `${orphan.id}.json`), JSON.stringify(orphan))
writeFileSync(join(spareRecords, `${randomUUID()}.json`), "{\"cut\":")
await service().tidy()
assert.equal(spares().some((spare) => spare.id === orphan.id), false)
assert.equal(spares().length, 2)
const idle = spares().filter((spare) => spare.repoRoot === shop)
assert.equal(idle.length, 2)
const wantedFile = readdirSync(spareRecords).find((name) => name.endsWith(".wanted"))
assert.ok(wantedFile)
writeFileSync(join(spareRecords, wantedFile), String(Date.now() - 25 * 60 * 60_000))
await service().tidy()
assert.deepEqual(spares().filter((spare) => spare.repoRoot === shop), [])
for (const spare of idle) assert.equal(existsSync(spare.path), false, "an idle spare's folder is moved aside at once")

// Folders that can't have one say what to do instead.
const plain = join(root, "plain")
mkdirSync(plain)
await assert.rejects(worktrees.prepare(randomUUID(), plain, "x"), /plain isn't in a Git repository.*Switch to Local/)
const empty = repository("empty", false)
await assert.rejects(worktrees.prepare(randomUUID(), empty, "x"), /no commits yet/)

await worktrees.settled()
threads.close()
rmSync(root, { recursive: true, force: true })
console.log("thread worktrees: names, subfolder, carried inputs and dependencies, one per conversation, attach, resume, in-use, dirty, branch kept, outside removal, spares (fill, claim, catch up, stale dependencies, two hosts, orphans, idle), inventory (landed, squashed, empty, dirty, in use, size), refusals")
