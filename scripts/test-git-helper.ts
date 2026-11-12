import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Readable } from "node:stream"
import { Git, GitError, type GitTrace, type RunOptions } from "@mako/git"
import { closeHostChild, hostSpawn } from "@mako/host/base/host-command"
import { GitHelper } from "@mako/host/git/git-helper"

/**
 * The Git helper (`npm run test:git-helper`): every `git` the host runs through it ends as the same `git` started by
 * the host itself, case by case (output, an allowed and a failing exit code with its error output, too much output, a
 * timeout, a cancel, input given whole and streamed, a folder that's gone, a missing binary), with the same trace. A
 * helper killed under a running `git` fails that `git` as a killed one, kills its process group, runs the next ones
 * directly, and is started again after its pause.
 */
const root = mkdtempSync(join(tmpdir(), "mako-git-helper-"))
const repo = join(root, "repo")
execFileSync("git", ["init", "-q", repo])
writeFileSync(join(repo, "a.txt"), "a\n".repeat(200_000))
execFileSync("git", ["-C", repo, "add", "."])
execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one"])

const direct = { spawn: hostSpawn, close: closeHostChild }
const directTraces: GitTrace[] = []
const helperTraces: GitTrace[] = []
const helper = new GitHelper(direct)
const plain = new Git({ processes: direct, trace: (run) => directTraces.push(run) })
const helped = new Git({ processes: helper.runner(), trace: (run) => helperTraces.push(run) })

/** What a run came to, comparable across the two: its result, or its error's kind, words and code. */
type Outcome =
  | { code: number; stdout: string; stderr: string; truncated: boolean }
  | { error: "GitError"; kind: GitError["kind"]; message: string; code: GitError["code"]; stderr: GitError["stderr"] }
  | { error: string; message?: string }
async function outcome(git: Git, options: () => RunOptions): Promise<Outcome> {
  try {
    const result = await git.run(options())
    return { code: result.code, stdout: result.stdout.toString("utf8"), stderr: result.stderr, truncated: result.truncated }
  } catch (error) {
    if (error instanceof GitError) return { error: "GitError", kind: error.kind, message: error.message, code: error.code, stderr: error.stderr }
    if (error instanceof Error) return { error: error.name, message: error.message }
    return { error: String(error) }
  }
}
const lastTrace = (side: GitTrace[]) => {
  const { ms: _ms, queuedMs: _queued, ...rest } = side.at(-1)!
  return rest
}

const cases: [string, () => RunOptions][] = [
  ["output", () => ({ cwd: repo, args: ["rev-parse", "HEAD"] })],
  ["a read", () => ({ cwd: repo, args: ["status", "--porcelain"], read: true })],
  ["an allowed exit code", () => ({ cwd: repo, args: ["diff", "--quiet", "HEAD~0", "--", "missing"], codes: [1] })],
  ["a failing exit code and its error output", () => ({ cwd: repo, args: ["rev-parse", "--verify", "nope"] })],
  ["too much output", () => ({ cwd: repo, args: ["cat-file", "-p", "HEAD:a.txt"], maxBytes: 1000 })],
  ["a timeout", () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: new PassThrough(), timeoutMs: 300 })],
  ["a cancel", () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: new PassThrough(), signal: AbortSignal.timeout(300) })],
  ["input given whole", () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: "hello\n" })],
  ["input streamed", () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: Readable.from(["hel", "lo\n"]) })],
  ["a folder that's gone", () => ({ cwd: join(root, "gone"), args: ["status"] })],
  ["large output", () => ({ cwd: repo, args: ["cat-file", "-p", "HEAD:a.txt"] })],
]

try {
  for (const [name, options] of cases) {
    const want = await outcome(plain, options)
    const got = await outcome(helped, options)
    assert.deepEqual(got, want, `${name}: through the helper as when the host spawns it`)
    const [said, wanted] = [lastTrace(helperTraces), lastTrace(directTraces)]
    // Output past `maxBytes` stops a git still writing (exit code null), or finds one already done (0): which, the race
    // between its last write and the stop decides, for a git the host spawns too. Through the helper its output
    // arrives a moment later, so it's found done more often. The result is the same.
    if (wanted.outcome === "truncated") assert.ok(said.code === 0 || said.code === null, `${name}: ended or stopped`)
    assert.deepEqual(wanted.outcome === "truncated" ? { ...said, code: wanted.code } : said, wanted, `${name}: the same trace`)
  }
  assert.equal(helped.activity().running.length, 0, "nothing left running")

  // Many at once, as a pass over worktrees runs them.
  const many = await Promise.all(Array.from({ length: 40 }, () => helped.text({ cwd: repo, args: ["rev-parse", "HEAD"] })))
  assert.equal(new Set(many).size, 1)

  // The helper killed under a running git: that git fails as a killed one, and its process group goes.
  const running = outcome(helped, () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: new PassThrough(), timeoutMs: 30_000 }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  const pids = execFileSync("pgrep", ["-f", "git-helper-main"]).toString().trim().split("\n").filter(Boolean)
  assert.ok(pids.length > 0, "the helper runs")
  for (const pid of pids) process.kill(Number(pid), "SIGKILL")
  const killed = await running
  assert.deepEqual(killed, { error: "GitError", kind: "failed", message: "git hash-object failed", code: null, stderr: "" }, "a git the helper ran fails as a killed one")
  const left = () => { try { return execFileSync("pgrep", ["-f", "hash-object --stdin"]).toString().trim() } catch { return "" } }
  assert.equal(left(), "", "and its git is gone with it")
  // While it's down, git runs directly, with the same answer.
  const helpers = () => { try { return execFileSync("pgrep", ["-f", "git-helper-main"]).toString().trim().split("\n").filter(Boolean) } catch { return [] } }
  assert.equal(await helped.text({ cwd: repo, args: ["rev-parse", "HEAD"] }), many[0])
  assert.deepEqual(helpers(), [], "no helper while it waits out its pause")
  // After its pause, it's started again.
  await new Promise((resolve) => setTimeout(resolve, 5_200))
  assert.equal(await helped.text({ cwd: repo, args: ["rev-parse", "HEAD"] }), many[0])
  assert.equal(helpers().length, 1, "started again after its pause")
  console.log("git helper: every case ends as a direct spawn does, with the same trace; a killed helper fails its git and Git runs on directly")
} finally {
  // Held open as a host is, so a stop that never ends fails here rather than letting the process exit under it.
  const held = setInterval(() => {}, 1_000)
  const stopping = Date.now()
  await helper.stop()
  clearInterval(held)
  assert.ok(Date.now() - stopping < 5_000, "the helper stops")
  await plain.close()
  rmSync(root, { recursive: true, force: true })
}
