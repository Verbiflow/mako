import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Git, type GitTrace } from "@mako/git"
import { ThreadStore } from "@mako/host/threads/store"
import { ThreadWorktreeService } from "@mako/host/workspaces/thread-worktrees"

/**
 * The worktree summaries at the size of the Mac they were slow on: 107 worktrees over two repositories of about 5,000
 * and 7,700 files, a third of them with commits. It prints the Git processes and the wall time of a cold pass, the
 * first pass after a restart with nothing moved, one worktree's commit, and the main checkout of the larger
 * repository moving. It makes about 700,000 files in a scratch folder and removes them.
 * `npx tsx scripts/bench-worktree-summaries.ts`
 */

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-summaries-bench-")))
const SIZES = [{ name: "smaller", files: 5_000, worktrees: 50 }, { name: "larger", files: 7_700, worktrees: 57 }]

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function repository(name: string, files: number): string {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  git(path, "init", "-q", "-b", "main")
  git(path, "config", "user.email", "test@example.invalid")
  git(path, "config", "user.name", "Test")
  for (let folder = 0; folder * 100 < files; folder += 1) {
    mkdirSync(join(path, "src", `part-${folder}`), { recursive: true })
    for (let file = 0; file < 100 && folder * 100 + file < files; file += 1) writeFileSync(join(path, "src", `part-${folder}`, `file-${file}.ts`), `export const value = ${folder * 100 + file}\n`)
  }
  // Submodules to set up keep spares from being made: their Git processes aren't a pass's.
  writeFileSync(join(path, ".gitmodules"), "")
  git(path, "add", ".")
  git(path, "commit", "-q", "-m", "first")
  return path
}

function commit(cwd: string, file: string, message: string): void {
  writeFileSync(join(cwd, file), `${message}\n`)
  git(cwd, "add", file)
  git(cwd, "commit", "-q", "-m", message)
}

function counting() {
  const ran: string[] = []
  const words = (trace: GitTrace) => trace.args.filter((word, index) => word !== "-c" && trace.args[index - 1] !== "-c" && word !== "--no-optional-locks")
  return { git: new Git({ trace: (trace) => ran.push(words(trace)[0] ?? "") }), ran }
}

const tally = (ran: readonly string[]) => Object.fromEntries([...new Set(ran)].map((command) => [command, ran.filter((each) => each === command).length]))

const threads = new ThreadStore(join(root, "threads.sqlite"))
const noWatch = async () => ({ unsubscribe: async () => {} })
const service = (runner: Git) => new ThreadWorktreeService(runner, join(root, "worktrees"), threads, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, noWatch)
const first = counting()
let host = service(first.git)
const second = counting()

try {
  const madeBegan = performance.now()
  const made: { path: string; repo: string }[] = []
  const repositories: string[] = []
  for (const { name, files, worktrees } of SIZES) {
    const repo = repository(name, files)
    repositories.push(repo)
    for (let n = 0; n < worktrees; n += 1) {
      const id = randomUUID()
      threads.registerJournal({ conversationId: id, createdAt: Date.now(), bindings: [], harness: "codex" }, { kind: "service", name: "migration" })
      const worktree = await host.prepare(id, repo, `${name} work ${n}`)
      await host.attach(id)
      made.push({ path: worktree.path, repo })
      if (n % 3 === 0) commit(worktree.path, `own-${n}.txt`, `work ${n}`)
    }
  }
  const madeMs = Math.round(performance.now() - madeBegan)

  const timed = async (ran: string[], work: () => Promise<void>) => {
    ran.length = 0
    const began = performance.now()
    await work()
    return { git: ran.length, ms: Math.round(performance.now() - began), commands: tally(ran) }
  }
  const pass = async () => {
    await host.summaries()
  }
  const cold = await timed(first.ran, pass)
  const again = await timed(first.ran, pass)
  await host.closeSummaries()
  host = service(second.git)
  const answered = performance.now()
  const held = await host.heldNow(undefined, "changes")
  const answerMs = Math.round(performance.now() - answered)
  const restarted = await timed(second.ran, pass)
  commit(made[1]!.path, "more.txt", "more work")
  const oneCommit = await timed(second.ran, pass)
  commit(repositories[1]!, "main-moved.txt", "main moves")
  const mainMoved = await timed(second.ran, pass)
  const inventory = await timed(second.ran, async () => {
    await host.inventory()
  })

  console.log(JSON.stringify({
    worktrees: made.length,
    repositories: SIZES.map(({ files, worktrees }) => ({ files, worktrees })),
    makingThemMs: madeMs,
    coldPass: cold,
    samePassAgain: again,
    answerAfterRestart: { ms: answerMs, summaries: held.summaries.length, reading: held.reading.length },
    passAfterRestartNothingMoved: restarted,
    oneCommit,
    mainMovedInLargerRepository: mainMoved,
    inventoryAnswer: inventory,
  }, null, 1))
} finally {
  await host.settled().catch(() => undefined)
  await host.closeSummaries().catch(() => undefined)
  threads.close()
  await first.git.close()
  await second.git.close()
  rmSync(root, { recursive: true, force: true, maxRetries: 3 })
}
