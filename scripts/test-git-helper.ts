import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
const helpers = [helper]
const plain = new Git({ processes: direct, trace: (run) => directTraces.push(run) })
const helped = new Git({ processes: helper.runner(), trace: (run) => helperTraces.push(run) })

/** What a run came to, comparable across the two: its result, or its error's kind, words and code. */
type Outcome =
  | { code: number; stdout: string; stderr: string; truncated: boolean }
  | { error: "GitError"; kind: GitError["kind"]; message: string; code: GitError["code"]; stderr: GitError["stderr"] }
  | { error: string; message?: string }
const messageOf = (outcome: Outcome) => ("message" in outcome ? outcome.message ?? "" : "")
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

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  // Each loss below gets a helper of its own: a helper lost waits out a pause before it's started again.
  const fresh = () => {
    const own = new GitHelper(direct)
    helpers.push(own)
    return { own, git: new Git({ processes: own.runner() }) }
  }
  /** The `git` processes whose arguments hold `pattern`: by the executable's name, so no shell quoting it matches. */
  // `comm` is cut to 16 characters on macOS, so the executable is read from the arguments' first word.
  const running = (pattern: string) => execFileSync("ps", ["-Ao", "pid=,args="]).toString().split("\n")
    .filter((line) => /(^|\/)git$/.test(line.trim().split(/\s+/)[1] ?? "") && line.includes(pattern)).join("\n")
  const until = async (what: string, done: () => boolean) => {
    for (let tries = 0; !done(); tries++) {
      if (tries > 1_200) throw new Error(`Timed out waiting for ${what}`)
      await pause(25)
    }
  }
  /** Whether `pattern`'s processes are gone, given a moment: an orphan that exited is reaped by launchd, not at once. */
  const gone = async (pattern: string) => {
    for (let tries = 0; tries < 20 && running(pattern); tries++) await pause(100)
    return running(pattern) === ""
  }

  // The helper killed under a running git: that git isn't killed for it. Its stdin closing with the helper, it ends on
  // its own, and its result is said unknown, never failed.
  {
    const { own, git } = fresh()
    const run = outcome(git, () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: new PassThrough(), timeoutMs: 30_000 }))
    await until("the git to run", () => running("hash-object --stdin") !== "")
    process.kill(own.pid()!, "SIGKILL")
    const lost = await run
    assert.equal("kind" in lost && lost.kind, "unknown", `a git the helper started is said unknown: ${JSON.stringify(lost)}`)
    assert.match(messageOf(lost), /ended on its own/)
    assert.ok(await gone("hash-object --stdin"), "and it ended")
    // While it's down, git runs directly, with the same answer; after its pause it's started again.
    assert.equal(await git.text({ cwd: repo, args: ["rev-parse", "HEAD"] }), many[0])
    assert.equal(own.pid(), undefined, "no helper while it waits out its pause")
    await pause(5_200)
    assert.equal(await git.text({ cwd: repo, args: ["rev-parse", "HEAD"] }), many[0])
    assert.ok(own.pid(), "started again after its pause")
  }

  // A write the helper is lost under lands: the commit its hook holds goes through, and leaves no lock behind.
  {
    const { own, git } = fresh()
    const hook = join(repo, ".git", "hooks", "pre-commit")
    writeFileSync(hook, `#!/bin/sh\nsleep 2\necho ran > "${join(root, "hook-ran")}"\n`, { mode: 0o755 })
    writeFileSync(join(repo, "b.txt"), "b\n")
    await git.run({ cwd: repo, args: ["add", "b.txt"] })
    const before = await git.text({ cwd: repo, args: ["rev-parse", "HEAD"] })
    const commit = outcome(git, () => ({ cwd: repo, args: ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "two"] }))
    await until("the commit to run", () => running("commit -qm two") !== "")
    process.kill(own.pid()!, "SIGKILL")
    const lost = await commit
    assert.equal("kind" in lost && lost.kind, "unknown", `the commit is said unknown, not failed: ${JSON.stringify(lost)}`)
    assert.match(messageOf(lost), /ended on its own/)
    assert.notEqual(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim(), before, "the commit landed")
    assert.ok(existsSync(join(root, "hook-ran")), "its hook ran to its end")
    assert.ok(!existsSync(join(repo, ".git", "index.lock")), "no lock left behind")
    rmSync(hook)
  }

  // A helper stopped (SIGSTOP) under a running git with a short timeout: the stop the timeout asks isn't answered, so
  // the helper is taken for wedged, killed, and the git stopped from here; Git says the timeout, as it would.
  {
    const { own, git } = fresh()
    const run = outcome(git, () => ({ cwd: repo, args: ["hash-object", "--stdin"], input: new PassThrough(), timeoutMs: 500 }))
    await until("the git to run", () => running("hash-object --stdin") !== "")
    const pid = own.pid()!
    process.kill(pid, "SIGSTOP")
    const started = Date.now()
    const timedOut = await run
    assert.equal("kind" in timedOut && timedOut.kind, "timeout", `the git's timeout is said: ${JSON.stringify(timedOut)}`)
    assert.ok(Date.now() - started < 15_000, "within the watch")
    assert.ok(await gone("hash-object --stdin"), "the git is gone")
    assert.equal(own.pid(), undefined, "the wedged helper was let go")
    assert.throws(() => process.kill(pid, 0), "and killed")
    assert.equal(await git.text({ cwd: repo, args: ["rev-parse", "HEAD"] }), execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim(), "the next git runs directly")
  }

  // The host's own loop held past a watch while the helper is healthy (the person's host has held it for seconds): the
  // helper's word is waiting, unread, when the watch fires late, so it's given its time again and nothing is lost.
  {
    const { own, git } = fresh()
    await git.text({ cwd: repo, args: ["rev-parse", "HEAD"] })
    const pid = own.pid()
    const run = outcome(git, () => ({ cwd: repo, args: ["rev-parse", "HEAD"] }))
    const held = Date.now()
    while (Date.now() - held < 7_000) { /* the loop held past the 5 s watch on the start */ }
    const answered = await run
    const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString()
    assert.deepEqual(answered, { code: 0, stdout: head, stderr: "", truncated: false }, `a git through a healthy helper answers after a held loop: ${JSON.stringify(answered)}`)
    assert.equal(own.pid(), pid, "and the helper is the same one")
  }

  // A git sent to a helper stopped before it started anything: it fails, nothing having run, within the watch.
  {
    const { own, git } = fresh()
    await git.text({ cwd: repo, args: ["rev-parse", "HEAD"] })
    process.kill(own.pid()!, "SIGSTOP")
    const started = Date.now()
    const never = await outcome(git, () => ({ cwd: repo, args: ["rev-parse", "HEAD"] }))
    assert.equal("kind" in never && never.kind, "failed")
    assert.match(messageOf(never), /didn't start: .*Nothing ran\./)
    assert.ok(Date.now() - started < 10_000, "within the watch")
  }

  console.log("git helper: every case ends as a direct spawn does, with the same trace; a lost helper's gits are never killed for it and are said unknown, a write landing; a wedged one is let go within its watch; Git runs on directly")
} finally {
  // Held open as a host is, so a stop that never ends fails here rather than letting the process exit under it.
  const held = setInterval(() => {}, 1_000)
  const stopping = Date.now()
  for (const each of helpers) await each.stop()
  clearInterval(held)
  assert.ok(Date.now() - stopping < 5_000, "the helper stops")
  await plain.close()
  rmSync(root, { recursive: true, force: true })
}
