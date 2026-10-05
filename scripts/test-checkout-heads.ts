import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CheckoutHeadService, locateCheckout } from "../electron/checkout-heads.js"
import type { CheckoutHead, CheckoutHeads } from "../electron/contracts/checkout-heads.js"
import { moveablePlace } from "../electron/workspace-tools.js"

const unused = () => Promise.reject(new Error("not called"))
const noWorktrees = { ofConversation: () => undefined, ahead: unused, merge: unused, remove: unused }

/**
 * Checkout heads against real repositories: what HEAD reads as in each state
 * Git leaves it in, and that a change made by Git itself arrives as an event.
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-heads-")))
const repo = join(root, "app")
const worktree = join(root, "app-feature")
const plain = join(root, "plain")
const EVENT_DEADLINE_MS = 5_000

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function commit(file: string, text: string, message: string): void {
  writeFileSync(join(repo, file), text)
  git(repo, "add", file)
  git(repo, "commit", "-q", "-m", message)
}

const events: CheckoutHeads[] = []
const latencies: number[] = []
let waiting: { folder: string; want: (head: CheckoutHead | null) => boolean; resolve: () => void } | null = null
const heads = new CheckoutHeadService((changed) => {
  events.push(changed)
  if (waiting && waiting.folder in changed && waiting.want(changed[waiting.folder] ?? null)) waiting.resolve()
})

/** Runs `change`, then waits for the event that reports `folder` as `want` describes. */
async function expectEvent(folder: string, change: () => void, want: (head: CheckoutHead | null) => boolean, what: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const arrived = new Promise<void>((resolve, reject) => {
    waiting = { folder, want, resolve }
    timer = setTimeout(() => reject(new Error(`No checkout-heads event for ${what} within ${EVENT_DEADLINE_MS} ms`)), EVENT_DEADLINE_MS)
  })
  change()
  const changedAt = performance.now()
  try {
    await arrived
    latencies.push(performance.now() - changedAt)
  } finally {
    clearTimeout(timer)
    waiting = null
  }
}

try {
  mkdirSync(join(repo, "web"), { recursive: true })
  mkdirSync(plain)
  git(repo, "init", "-q", "-b", "main")
  git(repo, "config", "user.email", "test@example.invalid")
  git(repo, "config", "user.name", "Test")
  commit("a.txt", "one\n", "first")

  const first = await heads.read([repo, join(repo, "web"), plain])
  assert.deepEqual(first[repo], { kind: "branch", name: "main" })
  assert.deepEqual(first[join(repo, "web")], { kind: "branch", name: "main" }, "a subfolder reads its checkout's head")
  assert.equal(first[plain], null, "a folder in no checkout has no head")

  await expectEvent(repo, () => git(repo, "checkout", "-q", "-b", "feature/login"),
    (head) => head?.kind === "branch" && head.name === "feature/login", "a branch switch")
  assert.ok(events.at(-1)?.[join(repo, "web")], "every folder of the checkout hears the switch")
  assert.deepEqual((await heads.read([repo]))[repo], { kind: "branch", name: "feature/login" })

  git(repo, "worktree", "add", "-q", "-b", "mako/fix-redirect", worktree)
  mkdirSync(join(worktree, "web"))
  const linked = { path: worktree, repoRoot: repo }
  const inWorktree = await heads.read([worktree, join(worktree, "web")])
  assert.deepEqual(inWorktree[worktree], { kind: "branch", name: "mako/fix-redirect", linked },
    "a linked worktree reads its own HEAD through its .git file, and says whose worktree it is")
  assert.deepEqual(inWorktree[join(worktree, "web")], { kind: "branch", name: "mako/fix-redirect", linked }, "so does a folder inside it")
  assert.equal((await locateCheckout(repo))?.linked, undefined, "the main checkout is no linked worktree")
  if (worktree.startsWith("/private/"))
    assert.equal((await locateCheckout(worktree.slice("/private".length)))?.linked?.repoRoot, repo.slice("/private".length),
      "asked through /var or /tmp, the repository is named that way too, not the /private way Git records it")
  const refusal = await moveablePlace(noWorktrees, "conversation", join(worktree, "web"))
  assert.ok(refusal.refused, "a Session already in a worktree made outside Mako isn't moved into another")
  assert.match(refusal.refused, /made outside Mako/)
  await expectEvent(worktree, () => git(worktree, "checkout", "-q", "--detach"),
    (head) => head?.kind === "detached", "detaching a linked worktree")
  assert.deepEqual((await heads.read([repo]))[repo], { kind: "branch", name: "feature/login" }, "the main checkout is unaffected")
  await expectEvent(worktree, () => git(repo, "worktree", "remove", "--force", worktree),
    (head) => head === null, "removing a linked worktree")

  // A rebase stopped on a conflict leaves HEAD detached; the branch being rebased is what it reads as.
  commit("a.txt", "feature\n", "feature change")
  git(repo, "checkout", "-q", "main")
  commit("a.txt", "main\n", "main change")
  git(repo, "checkout", "-q", "feature/login")
  await expectEvent(repo, () => {
    try {
      git(repo, "rebase", "main")
      assert.fail("the rebase was meant to stop on a conflict")
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error
    }
  }, (head) => head?.kind === "rebasing", "a rebase stopping on a conflict")
  assert.deepEqual((await heads.read([repo]))[repo], { kind: "rebasing", name: "feature/login" })
  await expectEvent(repo, () => git(repo, "rebase", "--abort"),
    (head) => head?.kind === "branch" && head.name === "feature/login", "aborting the rebase")

  const before = events.length
  git(repo, "status", "--porcelain")
  writeFileSync(join(repo, "b.txt"), "untracked\n")
  git(repo, "add", "b.txt")
  // The index changed; HEAD did not. A checkout switch after it is the next event.
  await expectEvent(repo, () => git(repo, "checkout", "-q", "main"),
    (head) => head?.kind === "branch" && head.name === "main", "the next switch")
  assert.equal(events.length, before + 1, "index writes announce nothing")

  heads.close()
  git(repo, "checkout", "-q", "-b", "after-close")
  assert.deepEqual(await heads.read([repo]), { [repo]: null }, "a closed service follows nothing")
  console.log("checkout heads: branch, subfolder, no checkout, switch event, linked worktree and whose, no move from it, detached, removed, rebasing, index quiet, close")
  console.log(`events arrived ${latencies.map((ms) => ms.toFixed(1)).join(", ")} ms after Git returned`)
} finally {
  heads.close()
  rmSync(root, { recursive: true, force: true })
}
