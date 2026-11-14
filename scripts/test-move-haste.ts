import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git } from "@mako/git"
import type { CheckoutShares, Partition } from "@mako/host/attribution/queries"
import { moveByAuthor, type MoveLedger } from "@mako/host/workspaces/worktree-move"

/**
 * A Thread's move onto its own branch as its Mac goes off (`MoveHaste`, `npm run test:move-haste`): with a deadline,
 * the attribution journal is waited for until then and nothing is read back, so a journal that hasn't settled (a busy
 * Mac's, 14 s on staging) holds a handoff no longer than its deadline; what it hadn't caught up with stays in the main
 * checkout. Without one, a move waits for the whole settle and reads back, as ever.
 */
const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-move-haste-")))
const git = new Git()
const sh = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" }).trim()

const none = { files: [], lines: 0 }
const shares: CheckoutShares = { thread: none, likely: none, others: none, person: none, uncertain: none, unattributed: none }

/** A repository with a worktree on a branch of its own, and a journal whose settle answers when `settles` does. */
function world(name: string, settles: Promise<void>) {
  const repo = join(root, name)
  sh(root, "init", "--quiet", repo)
  writeFileSync(join(repo, "a.txt"), "one\n")
  sh(repo, "add", ".")
  sh(repo, "commit", "--quiet", "-m", "base")
  const base = sh(repo, "rev-parse", "HEAD")
  const worktree = join(root, `${name}-worktree`)
  sh(repo, "worktree", "add", "--quiet", "-b", `mako/${name}`, worktree)
  const empty: Partition = { checkout: repo, thread: "t", roots: [], files: [], whole: [], uncertain: [], unattributed: [], ms: 0 }
  const readBacks: string[] = []
  const logged: Array<Record<string, string | number | boolean>> = []
  const ledger: MoveLedger = {
    settled: () => settles,
    track: async () => {},
    head: () => base,
    partition: () => empty,
    shares: () => shares,
    mako: () => ({ end: () => {} }),
    readBack: async (repoRoot) => void readBacks.push(repoRoot),
  }
  const move = (by?: number) => moveByAuthor({
    git, ledger, id: randomUUID(), thread: "t", branch: `mako/${name}`, project: repo, members: [{ repoRoot: repo, path: worktree, base }], bring: false,
    save: async () => {}, log: (_message, facts) => void logged.push(facts), ...by !== undefined && { by },
  })
  return { repo, readBacks, logged, move }
}

try {
  // A journal that never settles: with a deadline, the move answers by then, reading nothing back.
  {
    const w = world("hasty", new Promise(() => undefined))
    const began = Date.now()
    let timer: ReturnType<typeof setTimeout> | undefined
    const plan = await Promise.race([w.move(Date.now() + 300), new Promise<never>((_, refuse) => { timer = setTimeout(() => refuse(new Error("it waited on the journal past its deadline")), 5_000) })])
    clearTimeout(timer)
    assert.equal(plan.step, "done")
    assert.ok(Date.now() - began < 2_000, `answered by its deadline, in ${Date.now() - began} ms`)
    assert.deepEqual(w.readBacks, [], "nothing read back")
    assert.equal(w.logged.at(-1)?.["hasty"], true, "the log says it moved in haste")
  }
  // Without one, the whole settle is waited for and what nobody is sure of is read back, as before.
  {
    let settle: () => void = () => undefined
    const w = world("whole", new Promise<void>((resolve) => { settle = resolve }))
    let done = false
    const moving = w.move().then((plan) => ((done = true), plan))
    await new Promise((resolve) => setTimeout(resolve, 300))
    assert.equal(done, false, "it waits for the settle")
    settle()
    assert.equal((await moving).step, "done")
    assert.deepEqual(w.readBacks, [w.repo], "and reads back")
  }
  console.log("PASS: a move with a handoff's deadline waits for the journal until then and reads nothing back; without one it waits for the whole settle and reads back")
} finally {
  git.close()
  rmSync(root, { recursive: true, force: true })
}
