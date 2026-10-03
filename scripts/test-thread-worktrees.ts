import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Actor } from "../electron/contracts/thread-identity.js"
import type { Prepared } from "../electron/thread-processes.js"
import { inputsDigest, RecipeSchema, type Recipe } from "../electron/thread-recipe.js"
import { ThreadStore } from "../electron/thread-store.js"
import { worktreeSlug } from "../electron/contracts/thread-worktrees.js"
import { ThreadWorktreeService } from "../electron/thread-worktrees.js"
import { carryOutputs, carryReport, type CheckoutSetup, outputNames } from "../electron/worktree-carry.js"
import { holdsCredentials } from "../electron/recipe-secrets.js"

/**
 * A Thread's worktree against a real repository: where it goes, what the
 * project's recipe has it take from the main checkout, that a repeated or
 * interrupted start finds the first one, and what removal refuses.
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
  writeFileSync(join(path, ".gitignore"), "node_modules/\ndist/\n.env\n.env.*\n.venv/\n")
  writeFileSync(join(path, "web", "index.ts"), "export {}\n")
  // Past Git's threshold, so the checkout runs its parallel workers.
  mkdirSync(join(path, "web", "generated"))
  for (let n = 0; n < 150; n += 1) writeFileSync(join(path, "web", "generated", `part-${n}.ts`), `export const part = ${n}\n`)
  writeFileSync(join(path, ".env"), "API=1\n")
  writeFileSync(join(path, ".env.local"), "LOCAL=1\n")
  mkdirSync(join(path, "node_modules", "left-pad"), { recursive: true })
  writeFileSync(join(path, "node_modules", "left-pad", "index.js"), "module.exports = 1\n")
  mkdirSync(join(path, "web", "node_modules", "tiny"), { recursive: true })
  writeFileSync(join(path, "web", "node_modules", "tiny", "index.js"), "module.exports = 2\n")
  mkdirSync(join(path, "dist"))
  writeFileSync(join(path, "dist", "app.js"), "\n")
  if (commit) {
    git(path, "add", ".")
    git(path, "commit", "-q", "-m", "first")
  }
  return path
}

const busy = new Map<string, string[]>()
const working = new Map<string, string[]>()
const threads = new ThreadStore(join(root, "threads.sqlite"))
const INSTALL = { command: "npm install", inputs: ["package-lock.json"], outputs: ["**/node_modules"] }
let recipe: Recipe | undefined = RecipeSchema.parse({ secrets: [".env", ".env.*"], prepare: [INSTALL] })
let secretsAllowed = true
const records = new Map<string, Prepared>()
const setup: CheckoutSetup = {
  recipe: async () => recipe,
  grantedSecrets: async (_checkout, wanted) => secretsAllowed ? wanted?.secrets ?? [] : [],
  prepared: async (checkout) => records.get(checkout) ?? { done: {} },
  savePrepared: async (checkout, prepared) => {
    records.set(checkout, prepared)
  },
}
const service = () => new ThreadWorktreeService(join(root, "worktrees"), threads, async (path) => busy.get(path) ?? [], async (path) => working.get(path) ?? [], undefined, setup)

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

// What the recipe's carry names comes along before the agent starts, then its install step's outputs as clones, at any depth; nothing else does.
assert.equal(prepared.copied, 2)
assert.equal(prepared.spare, false, "the project's first worktree has no spare to take")
assert.equal(readFileSync(join(prepared.path, ".env"), "utf8"), "API=1\n")
assert.equal(readFileSync(join(prepared.path, ".env.local"), "utf8"), "LOCAL=1\n")
const outputs = await worktrees.outputs(first)
const noLock = await inputsDigest(shop, ["package-lock.json"])
if (process.platform === "darwin") {
  assert.deepEqual(outputs, { carried: [{ command: "npm install", inputs: ["package-lock.json"], digest: noLock, entries: ["node_modules", "web/node_modules"] }], skipped: [] })
  assert.equal(readFileSync(join(prepared.path, "node_modules", "left-pad", "index.js"), "utf8"), "module.exports = 1\n")
  assert.equal(readFileSync(join(prepared.path, "web", "node_modules", "tiny", "index.js"), "utf8"), "module.exports = 2\n")
} else {
  assert.ok(outputs?.carried.length || outputs?.skipped.length, "Linux clones them where the volume shares blocks and says why not elsewhere")
}
assert.equal(existsSync(join(prepared.path, "dist")), false)
assert.equal(records.has(prepared.path), false, "the main checkout has no record of the step passing, so it still runs once here to catch up")
assert.equal(git(prepared.path, "status", "--porcelain"), "", "what came along is all ignored")

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
await worktrees.outputs(fromSpare)
if (process.platform === "darwin") assert.equal(existsSync(join(claimed.path, "web", "node_modules", "tiny", "index.js")), true, "the spare's cloned outputs came with it")
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

// Outputs cloned before the step's inputs changed don't fit them: they go, and aren't cloned again while they differ.
writeFileSync(join(shop, "package-lock.json"), "{\"lockfileVersion\":3}\n")
const relocked = randomUUID()
const unlocked = await worktrees.prepare(relocked, shop, "lockfile changed")
assert.equal(unlocked.spare, true)
assert.deepEqual(await worktrees.outputs(relocked), { carried: [], skipped: ["npm install: package-lock.json differs from the main checkout's, so it installs here in full."] })
assert.equal(existsSync(join(unlocked.path, "node_modules")), false)
assert.equal(existsSync(join(unlocked.path, "web", "node_modules")), false)
rmSync(join(shop, "package-lock.json"))
await worktrees.settled()

// When the main checkout's own record says the step passed with these inputs, a new checkout's says so too, and it doesn't run there.
records.set(shop, { done: { "npm install": noLock } })
const recorded = randomUUID()
const trusted = await worktrees.prepare(recorded, shop, "install recorded")
await worktrees.outputs(recorded)
if (process.platform === "darwin") {
  assert.deepEqual(records.get(trusted.path), { done: { "npm install": noLock } })
  // An install already under way there records its own outcome.
  const underWay: Prepared = { done: {}, pending: { "npm install": noLock } }
  records.set(trusted.path, underWay)
  await carryOutputs(shop, trusted.path, [INSTALL], setup)
  assert.deepEqual(records.get(trusted.path), underWay)
}
records.delete(shop)
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

// Its work since it branched, committed and not, and merging it into the project's branch only when that's safe.
assert.equal(git(shop, "status", "--porcelain", "--untracked-files=no"), "")
const cartId = randomUUID()
const cart = await worktrees.prepare(cartId, shop, "Review the cart")
started(cartId)
await worktrees.list()
writeFileSync(join(cart.path, "web", "index.ts"), "export const cart = []\n")
git(cart.path, "mv", "web/generated/part-0.ts", "web/generated/first.ts")
git(cart.path, "commit", "-qam", "cart")
writeFileSync(join(cart.path, "web", "draft.ts"), "one\ntwo\n")
let review = await worktrees.review(cart.path)
assert.equal(review.into, "main")
assert.equal(review.commits, 1)
assert.equal(review.files.find((file) => file.path === "web/index.ts")?.insertions, 1)
assert.deepEqual(review.files.find((file) => file.path === "web/generated/first.ts"), { path: "web/generated/first.ts", from: "web/generated/part-0.ts", insertions: 0, deletions: 0 })
assert.deepEqual(review.files.find((file) => file.path === "web/draft.ts"), { path: "web/draft.ts", insertions: 2, deletions: 0 }, "uncommitted and untracked work counts too")
assert.deepEqual(review.merge, { ok: false, reason: "Commit or discard this worktree's changes first." })
const { diffs } = await worktrees.reviewDiffs(cart.path)
const indexDiff = diffs.find((diff) => diff.path === "web/index.ts")
assert.equal(indexDiff?.oldFile?.contents, readFileSync(join(shop, "web", "index.ts"), "utf8"))
assert.equal(indexDiff?.newFile?.contents, "export const cart = []\n")
assert.equal(diffs.find((diff) => diff.path === "web/draft.ts")?.oldFile, null)
git(cart.path, "add", ".")
git(cart.path, "commit", "-qm", "draft")
assert.deepEqual((await worktrees.review(cart.path)).merge, { ok: true, into: "main" })
writeFileSync(join(shop, "web", "index.ts"), "export const cart = null\n")
git(shop, "commit", "-qam", "clash")
review = await worktrees.review(cart.path)
assert.match(review.merge.ok ? "" : review.merge.reason, /conflicts with main/)
assert.equal(git(shop, "status", "--porcelain", "--untracked-files=no"), "", "finding the conflict touches neither checkout")
await assert.rejects(worktrees.merge(cart.path), /conflicts with main/)
git(shop, "reset", "-q", "--hard", "HEAD~1")
writeFileSync(join(shop, "web", "index.ts"), "// editing\n")
review = await worktrees.review(cart.path)
assert.match(review.merge.ok ? "" : review.merge.reason, /uncommitted changes on main/)
git(shop, "checkout", "--", "web/index.ts")
assert.deepEqual(await worktrees.merge(cart.path), { branch: cart.branch, into: "main" })
assert.equal(readFileSync(join(shop, "web", "index.ts"), "utf8"), "export const cart = []\n")
assert.equal(existsSync(join(shop, "web", "draft.ts")), true)
review = await worktrees.review(cart.path)
assert.equal(review.commits, 0)
assert.deepEqual(review.files, [])
assert.deepEqual((await worktrees.inventory()).worktrees.find((worktree) => worktree.path === cart.path)?.landing, { kind: "merged", into: "main" })

// Continuing in a worktree takes the checkout's uncommitted work along, staged as it was, once.
writeFileSync(join(shop, "web", "index.ts"), "export const staged = 1\n")
git(shop, "add", "web/index.ts")
writeFileSync(join(shop, "web", "draft.ts"), "unstaged\n")
writeFileSync(join(shop, "web", "new.ts"), "untracked\n")
const movingId = randomUUID()
const moving = await worktrees.prepare(movingId, shop, "Carry on elsewhere")
assert.equal(await worktrees.moveChanges(movingId), 3)
assert.equal(git(shop, "status", "--porcelain", "--untracked-files=all"), "", "the checkout is left clean")
assert.equal(git(shop, "stash", "list"), "", "the stash that carried them is gone")
assert.equal(git(moving.path, "diff", "--cached", "--name-only"), "web/index.ts")
assert.equal(git(moving.path, "diff", "--name-only"), "web/draft.ts")
assert.equal(readFileSync(join(moving.path, "web", "new.ts"), "utf8"), "untracked\n")
writeFileSync(join(shop, "web", "later.ts"), "made after the move\n")
assert.equal(await worktrees.moveChanges(movingId), 3, "a repeated request answers the same")
assert.equal(existsSync(join(shop, "web", "later.ts")), true, "and moves nothing again")
rmSync(join(shop, "web", "later.ts"))

// What the worktree can't take stays in a named stash; a checkout that moved keeps its changes.
const clashId = randomUUID()
const clash = await worktrees.prepare(clashId, shop, "Clashing notes")
writeFileSync(join(clash.path, "notes.md"), "worktree\n")
writeFileSync(join(shop, "notes.md"), "checkout\n")
await assert.rejects(worktrees.moveChanges(clashId), /kept in the main checkout's stash as "Mako: moving to mako\/clashing-notes"/)
await assert.rejects(worktrees.moveChanges(clashId), /kept in the main checkout's stash/)
assert.match(git(shop, "stash", "list"), /Mako: moving to mako\/clashing-notes/)
git(shop, "stash", "pop", "-q")
assert.equal(readFileSync(join(shop, "notes.md"), "utf8"), "checkout\n")
rmSync(join(shop, "notes.md"))
rmSync(join(clash.path, "notes.md"))
const driftId = randomUUID()
await worktrees.prepare(driftId, shop, "Drifted")
git(shop, "commit", "-q", "--allow-empty", "-m", "moved on")
writeFileSync(join(shop, "web", "draft.ts"), "stays\n")
await assert.rejects(worktrees.moveChanges(driftId), /moved to another commit/)
assert.equal(readFileSync(join(shop, "web", "draft.ts"), "utf8"), "stays\n")
git(shop, "checkout", "--", "web/draft.ts")

// A Thread has one worktree per device, so a fork that would give it a second is refused.
await assert.rejects(worktrees.prepareFork(cartId, randomUUID(), shop, "Second tree"), /already works in its own worktree, on mako\/review-cart/)
const loneId = randomUUID()
started(loneId)
const loneFork = randomUUID()
const forked = await worktrees.prepareFork(loneId, loneFork, shop, "Fork elsewhere")
const lonePlacement = threads.journalPlacement(loneId)
assert.ok(lonePlacement)
threads.attachWorktree({ path: forked.path, thread: lonePlacement.thread, repoRoot: shop, project: shop, branch: forked.branch, base: git(shop, "rev-parse", "HEAD") })
assert.equal((await worktrees.prepareFork(loneId, loneFork, shop, "Fork elsewhere")).path, forked.path, "a repeated request finds its first worktree")
await assert.rejects(worktrees.prepareFork(loneId, randomUUID(), shop, "Another"), /already works in its own worktree/)
// Another of that Thread's Sessions moving in joins its worktree, in the same folder.
assert.equal(await worktrees.joinFolder(loneId, randomUUID(), join(shop, "web")), join(forked.path, "web"))
assert.equal(await worktrees.joinFolder(loneId, randomUUID(), shop), forked.path)
assert.equal(await worktrees.joinFolder(loneId, loneFork, shop), undefined, "the fork that made the worktree finishes the way it started")
const unplaced = randomUUID()
started(unplaced)
assert.equal(await worktrees.joinFolder(unplaced, randomUUID(), shop), undefined, "a Thread without a worktree makes one")

// A worktree made for a fork that was refused goes, branch and all.
const refusedId = randomUUID()
const refused = await worktrees.prepare(refusedId, shop, "Never started")
await worktrees.abandon(refusedId)
assert.equal(existsSync(refused.path), false)
assert.equal(git(shop, "branch", "--list", refused.branch), "")
assert.equal(existsSync(join(root, "worktrees", "receipts", `${refusedId}.json`)), false)
await worktrees.abandon(refusedId)

// Two hosts starting Threads with the same words at once never share a folder,
// and giving one back leaves the other's work alone.
const [twinA, twinB] = [randomUUID(), randomUUID()]
const [madeA, madeB] = await Promise.all([worktrees.prepare(twinA, shop, "Same words"), service().prepare(twinB, shop, "Same words")])
assert.notEqual(madeA.path, madeB.path)
assert.notEqual(madeA.branch, madeB.branch)
writeFileSync(join(madeA.path, "mine.txt"), "A's work\n")
await worktrees.abandon(twinB)
assert.equal(existsSync(madeB.path), false)
assert.equal(readFileSync(join(madeA.path, "mine.txt"), "utf8"), "A's work\n")
// A folder with work in it is never given back; Settings lists it in no Thread, and it can be removed from there.
await worktrees.abandon(twinA)
assert.equal(existsSync(join(madeA.path, "mine.txt")), true, "abandon keeps a worktree with uncommitted work")
const loose = (await worktrees.inventory()).worktrees.find((worktree) => worktree.path === madeA.path)
assert.equal(loose?.thread, null)
assert.match(loose?.held ?? "", /changes that aren't committed/)
await assert.rejects(worktrees.remove(madeA.path), /changes that aren't committed/)
rmSync(join(madeA.path, "mine.txt"))
await worktrees.remove(madeA.path)
assert.equal(existsSync(madeA.path), false)

// Removal never loses commits: not from a detached HEAD no branch has, nor mid-rebase.
const detachId = randomUUID()
started(detachId)
const detached = await worktrees.prepare(detachId, shop, "Detached work")
await worktrees.attach(detachId)
git(detached.path, "checkout", "-q", "--detach")
writeFileSync(join(detached.path, "only-here.txt"), "x\n")
git(detached.path, "add", ".")
git(detached.path, "commit", "-q", "-m", "on no branch")
await assert.rejects(worktrees.remove(detached.path), /on a commit no branch has/)
assert.match((await worktrees.inventory()).worktrees.find((worktree) => worktree.path === detached.path)?.held ?? "", /no branch has/)
git(detached.path, "branch", "kept-from-detached")
// A failing `--exec` stops the rebase with a clean tree, so only Git's own marker says it's under way.
assert.throws(() => git(detached.path, "rebase", "-q", "--exec", "false", "HEAD~1"))
await assert.rejects(worktrees.remove(detached.path), /in the middle of a rebase/)
git(detached.path, "rebase", "--abort")
await worktrees.remove(detached.path)
assert.equal(existsSync(detached.path), false)
assert.equal(git(shop, "log", "-1", "--format=%s", "kept-from-detached"), "on no branch")

// A move cut short after its stash was made finds the stash again and finishes.
const cutId = randomUUID()
const cut = await worktrees.prepare(cutId, shop, "Cut short move")
writeFileSync(join(shop, "web", "draft.ts"), "halfway\n")
const cutReceipt = join(root, "worktrees", "receipts", `${cutId}.json`)
const cutMessage = `Mako: moving to ${cut.branch}`
writeFileSync(cutReceipt, JSON.stringify({ ...JSON.parse(readFileSync(cutReceipt, "utf8")), moving: { stash: cutMessage, files: 1 } }))
git(shop, "stash", "push", "--include-untracked", "--message", cutMessage)
assert.equal(await worktrees.moveChanges(cutId), 1)
assert.equal(readFileSync(join(cut.path, "web", "draft.ts"), "utf8"), "halfway\n")
assert.equal(git(shop, "stash", "list"), "", "the stash is dropped once its changes are in the worktree")
assert.equal(git(shop, "status", "--porcelain"), "")

// Nothing moves or merges under a turn running in the main checkout.
const quietSource = randomUUID()
started(quietSource)
working.set(shop, ["“Busy”"])
await assert.rejects(worktrees.prepareFork(quietSource, randomUUID(), shop, "Under a turn"), /“Busy” is working in shop/)
const mergingId = randomUUID()
started(mergingId)
const mergeable = await worktrees.prepare(mergingId, shop, "Ready to merge")
await worktrees.attach(mergingId)
writeFileSync(join(mergeable.path, "feature.txt"), "done\n")
git(mergeable.path, "add", ".")
git(mergeable.path, "commit", "-q", "-m", "feature")
assert.deepEqual((await worktrees.review(mergeable.path)).merge, { ok: false, reason: "“Busy” is working in the main checkout. Merge once it stops." })
working.delete(shop)
assert.deepEqual((await worktrees.review(mergeable.path)).merge, { ok: true, into: "main" })

// A Python virtual environment names its own folder, so a copy would run the main checkout's
// packages: neither carry nor outputs take one, and saving a recipe that names one is refused.
for (const venvFolder of [".env.venv", ".venv"]) {
  mkdirSync(join(shop, venvFolder, "bin"), { recursive: true })
  writeFileSync(join(shop, venvFolder, "pyvenv.cfg"), "home = /usr/bin\n")
  writeFileSync(join(shop, venvFolder, "bin", "python"), "#!/bin/sh\n")
}
recipe = RecipeSchema.parse({ secrets: [".env", ".env.*"], prepare: [INSTALL, { command: "uv sync", inputs: ["uv.lock"], outputs: [".venv"] }] })
const venvId = randomUUID()
const venv = await worktrees.prepare(venvId, shop, "Virtualenv left behind")
assert.equal(existsSync(join(venv.path, ".env")), true)
assert.equal(existsSync(join(venv.path, ".env.venv")), false)
const venvOutputs = await worktrees.outputs(venvId)
assert.equal(existsSync(join(venv.path, ".venv")), false)
assert.ok(venvOutputs?.skipped.includes(".venv is a Python virtual environment, which names its own folder; it's made here instead."))
await assert.rejects(carryReport(recipe, shop), /^Error: Not saved: \.env\.venv is a Python virtual environment, which names its own folder, so a copy would run the main checkout's packages/)
assert.deepEqual(readdirSync(venv.path).filter((name) => name.includes("mako-")), [], "nothing half-made is left in the checkout")
for (const venvFolder of [".env.venv", ".venv"]) rmSync(join(shop, venvFolder), { recursive: true })
assert.deepEqual(await carryReport(recipe, shop, [".env", ".env.*"]), [
  "The user allows these credentials files, so a new worktree gets them from the main checkout before its agent starts: .env, .env.local.",
  "npm install: node_modules, web/node_modules are cloned into a new worktree when package-lock.json is the same there.",
  "uv sync: nothing Git ignores in the main checkout matches .venv yet; once the step has run there, new worktrees get them.",
])

// Credentials: carry refuses a file named like one, and secrets reach a new checkout only once the person allows them.
await assert.rejects(carryReport(RecipeSchema.parse({ carry: [".env.*"] }), shop), /^Error: Not saved: \.env\.\*, \.env\.local hold credentials by their names, so they go under "secrets", not "carry"/)
await assert.rejects(carryReport(RecipeSchema.parse({ carry: ["certs/dev.pem"] }), shop), /dev\.pem holds credentials by its name/)
assert.deepEqual(await carryReport(RecipeSchema.parse({ carry: ["dist/app.js"] }), shop), ["A new worktree gets these from the main checkout before its agent starts: dist/app.js."], "a file that isn't named like credentials carries as before")
const [waitingLine] = await carryReport(RecipeSchema.parse({ secrets: [".env", ".env.*"] }), shop, [".env"])
assert.match(waitingLine!, /^These hold credentials: \.env, \.env\.local\. A new worktree gets them only once the user allows it in Mako .* Never ask the user to paste a value\.$/, "allowing some patterns isn't allowing the list")
for (const [name, held] of [[".env", true], [".env.production", true], ["web/.env.local", true], [".env.example", false], [".env.sample", false], [".npmrc", true], ["deploy/key.pem", true], ["client_secret.json", true], ["gcloud-credentials.json", true], ["config.json", false], ["README.md", false]] as const)
  assert.equal(holdsCredentials(name), held, name)
secretsAllowed = false
const notAllowed = await worktrees.prepare(randomUUID(), shop, "Before allowing")
assert.equal(existsSync(join(notAllowed.path, ".env")), false, "secrets stay behind until the person allows them")
assert.equal(existsSync(join(notAllowed.path, ".env.local")), false)
secretsAllowed = true
assert.deepEqual(outputNames(RecipeSchema.parse({ prepare: [{ command: "make", inputs: ["Makefile"], outputs: ["**/node_modules", "target", "dist/*", "build/*.o"] }] })), ["node_modules", "target"], "a wildcard name would leave the whole checkout out of its size")

// A path inside an ignored folder is taken as it is; the rest of the folder stays.
writeFileSync(join(shop, "dist", "big.js"), "\n")
recipe = RecipeSchema.parse({ carry: ["dist/app.js"] })
const single = await worktrees.prepare(randomUUID(), shop, "One built file")
assert.equal(existsSync(join(single.path, "dist", "app.js")), true)
assert.equal(existsSync(join(single.path, "dist", "big.js")), false)

// Without a recipe, a worktree has what Git checks out and nothing more.
// Warm a separate pool while install outputs are authorized, then withdraw the
// recipe. This exercises reuse deterministically rather than depending on refill timing.
recipe = RecipeSchema.parse({ prepare: [INSTALL] })
const withdrawnRepo = repository("withdrawn-recipe")
const withdrawn = new ThreadWorktreeService(join(root, "withdrawn-worktrees"), threads, undefined, undefined, undefined, setup)
await withdrawn.prepare(randomUUID(), withdrawnRepo, "Warm the old recipe")
await withdrawn.settled()
recipe = undefined
const withdrawnBare = await withdrawn.prepare(randomUUID(), withdrawnRepo, "Use the current recipe")
assert.equal(withdrawnBare.spare, true, "the withdrawn recipe is checked on a warmed spare")
for (const entry of ["node_modules", "web/node_modules"])
  assert.equal(existsSync(join(withdrawnBare.path, entry)), false, `${entry} from an obsolete recipe stays behind`)
await withdrawn.settled()
const bareId = randomUUID()
const bare = await worktrees.prepare(bareId, shop, "No recipe")
assert.equal(bare.copied, 0)
assert.deepEqual(await worktrees.outputs(bareId), { carried: [], skipped: [] })
for (const entry of [".env", ".env.local", "node_modules", "dist"]) assert.equal(existsSync(join(bare.path, entry)), false, `${entry} stays behind`)
recipe = RecipeSchema.parse({ secrets: [".env", ".env.*"], prepare: [INSTALL] })

// Output clones are staged beside the checkout, where Git can't see them, and ones a stopped host left go.
const staging = join(venv.path, "..", ".carrying")
const stale = join(staging, "left-by-a-stopped-host")
mkdirSync(stale, { recursive: true })
utimesSync(stale, new Date(Date.now() - 2 * 60 * 60_000), new Date(Date.now() - 2 * 60 * 60_000))
mkdirSync(join(staging, "in-flight"))
await worktrees.tidy()
for (let tries = 0; existsSync(stale) && tries < 100; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20))
assert.equal(existsSync(stale), false, "a clone staged over an hour ago is deleted")
assert.equal(existsSync(join(staging, "in-flight")), true, "one being made now stays")

// A folder named as an install input counts what Git tracks or would track there, never what the step writes.
const webInputs = await inputsDigest(shop, ["web"])
writeFileSync(join(shop, "web", "node_modules", "tiny", "index.js"), "module.exports = 3\n")
assert.equal(await inputsDigest(shop, ["web"]), webInputs, "an ignored output changing leaves the digest as it was")
writeFileSync(join(shop, "web", "schema.sql"), "create table t ();\n")
assert.notEqual(await inputsDigest(shop, ["web"]), webInputs, "a new source file changes it")
rmSync(join(shop, "web", "schema.sql"))
assert.equal(await inputsDigest(shop, ["web"]), webInputs)
assert.notEqual(await inputsDigest(shop, [".env"]), await inputsDigest(shop, ["missing.lock"]), "a file named outright counts even when Git ignores it")
const loosePlain = join(root, "loose")
mkdirSync(join(loosePlain, "db"), { recursive: true })
writeFileSync(join(loosePlain, "db", "001.sql"), "one\n")
const looseDigest = await inputsDigest(loosePlain, ["db"])
writeFileSync(join(loosePlain, "db", "002.sql"), "two\n")
assert.notEqual(await inputsDigest(loosePlain, ["db"]), looseDigest, "outside Git, every file in the folder counts")

// Folders that can't have one say what to do instead.
const plain = join(root, "plain")
mkdirSync(plain)
await assert.rejects(worktrees.prepare(randomUUID(), plain, "x"), /plain isn't in a Git repository.*Choose Project folder/)
const empty = repository("empty", false)
await assert.rejects(worktrees.prepare(randomUUID(), empty, "x"), /no commits yet/)

await worktrees.settled()
threads.close()
rmSync(root, { recursive: true, force: true })
console.log("thread worktrees: names, subfolder, the recipe's carry and install outputs at any depth, one per conversation, attach, resume, in-use, dirty, branch kept, outside removal, spares (fill, claim, catch up, outputs that no longer fit their inputs, two hosts, orphans, idle), install records that travel only when the main checkout's proves them, virtual environments refused, credentials refused in carry and copied from secrets only once allowed, a path inside an ignored folder, no recipe means nothing extra, inventory (landed, squashed, empty, dirty, in use, size), review (committed, renamed, untracked, diffs), merge (dirty, conflict, main dirty, merged), continue (moved staged, repeated, kept stash, drifted, one per Thread, joining it, abandoned, cut short, checkout busy), same names at once, loose worktrees, detached and mid-rebase removal, stale staging, refusals")
