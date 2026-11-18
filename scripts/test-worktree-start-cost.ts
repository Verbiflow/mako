import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { subscribe } from "node:diagnostics_channel"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { Git, type GitTrace } from "@mako/git"
import type { Prepared } from "@mako/host/workspaces/thread-processes"
import { RecipeSchema } from "@mako/host/workspaces/thread-recipe"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"
import type { CheckoutSetup } from "@mako/host/workspaces/worktree-carry"

/**
 * What a new Thread's worktree costs between "the person starts a Thread in a worktree" and "the agent can run", with a
 * spare ready and without one, on a scratch repository of a few thousand files with an installed `node_modules`: the
 * Git processes each start runs, the other processes it starts (the clones), the files it copies, and how long it
 * takes. It holds the counts to a ceiling, that a spare is ready again after one is taken, and that a spare made
 * before the lockfile changed is made again rather than handed to a Thread with stale packages.
 * `npx tsx scripts/test-worktree-start-cost.ts`
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-start-cost-")))
const FILES = 3_000
const PACKAGES = 150
const PACKAGE_FILES = 20

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function repository(name: string): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.invalid")
  git(path, "config", "user.name", "Test")
  writeFileSync(join(path, ".gitignore"), "node_modules/\n.env\n")
  writeFileSync(join(path, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: {} }))
  for (let folder = 0; folder < FILES / 100; folder += 1) {
    mkdirSync(join(path, "src", `part-${folder}`), { recursive: true })
    for (let file = 0; file < 100; file += 1) writeFileSync(join(path, "src", `part-${folder}`, `file-${file}.ts`), `export const value${file} = ${folder * 100 + file}\n`.repeat(8))
  }
  writeFileSync(join(path, ".env"), "API=1\n")
  for (let pack = 0; pack < PACKAGES; pack += 1) {
    mkdirSync(join(path, "node_modules", `pack-${pack}`, "lib"), { recursive: true })
    for (let file = 0; file < PACKAGE_FILES; file += 1) writeFileSync(join(path, "node_modules", `pack-${pack}`, "lib", `m${file}.js`), `module.exports = ${file}\n`.repeat(40))
  }
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
  return path
}

const traces: GitTrace[] = []
const runner = new Git({ trace: (trace) => traces.push(trace) })
/** A child process as Node says it was made (`child_process` channel): its command line is there once it has started. */
const SpawnedSchema = z.object({ process: z.object({ spawnargs: z.array(z.string()) }) })
/** Every process this test's own process starts, as Node says each is made. */
let started: unknown[] = []
subscribe("child_process", (message) => {
  started.push(message)
})
/** The processes started that aren't Git's: the clones, a `du`, a hook. */
function others(children: readonly unknown[]): string[] {
  return children.flatMap((child) => {
    const words = SpawnedSchema.safeParse(child).data?.process.spawnargs ?? []
    return words[0]?.endsWith("git") ? [] : [words.slice(0, 2).join(" ")]
  })
}

const threads = new ThreadStore(join(root, "threads.sqlite"))
const records = new Map<string, Prepared>()
const recipe = RecipeSchema.parse({ carry: [".env"], prepare: [{ command: "npm install", inputs: ["package-lock.json"], outputs: ["node_modules"], link: false }] })
const setup: CheckoutSetup = {
  recipe: async () => recipe,
  prepared: async (checkout) => records.get(checkout) ?? { done: {} },
  savePrepared: async (checkout, prepared) => {
    records.set(checkout, prepared)
  },
}
const service = (name: string) => new ThreadWorktreeService(runner, join(root, name), threads, undefined, undefined, undefined, setup)

function begin(): string {
  const id = randomUUID()
  threads.registerJournal({ conversationId: id, createdAt: Date.now(), bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
  return id
}

/** One start, with what it ran before `prepare` answered (the agent can run then) and what its background work ran after. */
async function start(worktrees: ThreadWorktreeService, repo: string, name: string) {
  traces.length = 0
  started = []
  const began = performance.now()
  const made = await worktrees.prepare(begin(), repo, name)
  const ms = Math.round(performance.now() - began)
  const git = traces.map((trace) => trace.args.filter((word) => !word.startsWith("-c") && !word.includes("=")).slice(0, 2).join(" "))
  return { made, ms, git, others: others(started) }
}

try {
  // Without a spare, in a repository that never has one (it has submodules to set up): the send checks out the
  // worktree itself, the first time with nothing known of the repository, then with what's constant of it known.
  const bare = repository("bare")
  writeFileSync(join(bare, ".gitmodules"), "")
  git(bare, "add", ".gitmodules")
  git(bare, "commit", "-qm", "modules")
  const unspared = service("unspared")
  const first = await start(unspared, bare, "No spare")
  assert.equal(first.made.spare, false)
  await unspared.settled()
  const second = await start(unspared, bare, "No spare again")
  assert.equal(second.made.spare, false)
  assert.equal(git(second.made.path, "status", "--porcelain"), "", "the checkout is whole and clean")
  await unspared.settled()
  assert.ok(existsSync(join(second.made.path, "node_modules", "pack-0", "lib", "m0.js")), "its install's outputs were cloned in behind the start")

  const cold = repository("cold")
  const plain = service("plain")
  const fresh = await start(plain, cold, "No spare")
  assert.equal(fresh.made.spare, false)
  assert.equal(fresh.made.copied, 1, "the recipe's .env came along")
  assert.equal(git(fresh.made.path, "status", "--porcelain"), "", "the checkout is whole and clean")
  assert.equal(statSync(join(fresh.made.path, "src", "part-0", "file-0.ts")).isFile(), true)
  await plain.settled()
  assert.ok(existsSync(join(fresh.made.path, "node_modules", "pack-0", "lib", "m0.js")), "the install's outputs were cloned in behind the start")

  // The background fill made spares behind that start; the next takes one.
  const spared = await start(plain, cold, "With a spare")
  assert.equal(spared.made.spare, true, "a spare was ready")
  assert.equal(git(spared.made.path, "status", "--porcelain"), "", "the spare's checkout is whole and clean")
  assert.equal(git(spared.made.path, "symbolic-ref", "--short", "HEAD"), spared.made.branch)
  assert.ok(existsSync(join(spared.made.path, "node_modules", "pack-0", "lib", "m0.js")), "with its install outputs already in")
  assert.equal(lstatSync(join(spared.made.path, ".env")).isFile(), true)

  // One taken is made again at once: the start after it finds one ready too.
  await plain.settled()
  const next = await start(plain, cold, "With the refilled spare")
  assert.equal(next.made.spare, true, "a spare was ready again after one was taken")

  // The lockfile changes in the main checkout: spares made before it hold packages that no longer fit, and are made again.
  await plain.settled()
  writeFileSync(join(cold, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "node_modules/pack-0": { version: "2.0.0" } } }))
  git(cold, "commit", "-qam", "lockfile")
  await plain.want(cold)
  await plain.settled()
  const relocked = await start(plain, cold, "After the lockfile changed")
  assert.equal(relocked.made.spare, true)
  // Read as the start answers, before anything is cloned behind it: the packages came with the spare, or didn't.
  const packaged = existsSync(join(relocked.made.path, "node_modules", "pack-0", "lib", "m0.js"))

  const report = {
    files: FILES,
    packageFiles: PACKAGES * PACKAGE_FILES,
    withoutSpare: { ms: first.ms, git: first.git.length, commands: first.git, others: first.others, copied: first.made.copied },
    withoutSpareAgain: { ms: second.ms, git: second.git.length, commands: second.git, others: second.others },
    withSpare: { ms: spared.ms, git: spared.git.length, commands: spared.git, others: spared.others, copied: spared.made.copied },
    refilled: { ms: next.ms, git: next.git.length },
    afterLockfile: { ms: relocked.ms, git: relocked.git.length, packages: packaged },
  }
  console.log(JSON.stringify(report, null, 1))
  if (!process.env.MAKO_START_COST_MEASURE) {
    assert.ok(packaged, "a spare made again after the lockfile changed has the packages that fit it")
    assert.ok(second.git.length <= 6, `a start with no spare ran ${second.git.length} Git processes, not at most 6: ${second.git.join(", ")}`)
    // The spare that replaces the one taken is being made behind the start, by commands of its own.
    const refill = /^(rev-parse --verify|worktree add|worktree lock|ls-tree|ls-files -s|status|read-tree|update-index|reset)/
    const own = spared.git.filter((command) => !refill.test(command))
    assert.ok(own.length <= 6, `a start from a spare ran ${own.length} Git processes, not at most 6: ${own.join(", ")}`)
    assert.equal(own.filter((command) => command.startsWith("ls-files")).length, 1, "the main checkout's ignored files are listed once a start")
    assert.deepEqual(spared.others, [], "a start from a spare starts no process but Git's: its files and packages were there")
  }
  await plain.closeSummaries()
  await plain.settled()
  await unspared.closeSummaries()
  console.log("worktree start cost: with and without a spare, a spare ready again after one is taken, and made again when the lockfile changes")
} finally {
  threads.close()
  await runner.close()
  rmSync(root, { recursive: true, force: true })
}
