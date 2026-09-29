import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  guardShellFolder,
  movedShellCommand,
  shellCommandIndex,
} from "../electron/providers/cursor/sdk/shell-folder.ts"

// The shapes SDK 1.0.31 starts its shell tool with; anything else is not one.
assert.equal(shellCommandIndex("/bin/zsh", ["-c", "wrapper", "--", "ls"]), 3)
assert.equal(shellCommandIndex("/bin/bash", ["-O", "extglob", "-c", "wrapper", "--", "ls"]), 5)
assert.equal(shellCommandIndex("/opt/sandbox-helper", ["--policy", "{}", "--", "/bin/zsh", "-c", "wrapper", "--", "ls"]), 7)
assert.equal(shellCommandIndex("/bin/sh", ["-lc", "hook.sh SessionStart"]), undefined, "a hook is not the shell tool")
assert.equal(shellCommandIndex("/usr/bin/git", ["log", "--", "path"]), undefined, "a path after -- is not a command")
assert.equal(shellCommandIndex("/bin/zsh", ["script.zsh", "--", "arg"]), undefined, "a script without -c is not the shell tool")

const root = mkdtempSync(join(tmpdir(), "mako-shell-folder-"))
const workspace = join(root, "it's the workspace")
const gone = join(root, "deleted")
mkdirSync(workspace)
const warnings: string[] = []
guardShellFolder(() => workspace, (message) => warnings.push(message))

function run(command: string, args: string[], cwd: string) {
  // The namespace the SDK imports sees the guard, not only `require`.
  const child = childProcess.spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
  return new Promise<{ code: number | null; stdout: string; stderr: string; error?: NodeJS.ErrnoException }>((resolve) => {
    child.once("error", (error: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, error }))
    child.once("close", (code) => resolve({ code, stdout, stderr }))
  })
}

try {
  const wrapper = 'builtin eval "$1"; code=$?; builtin printf "pwd=%s\\n" "$(builtin pwd)"; builtin exit $code'
  for (const [shell, args] of [
    ["/bin/zsh", ["-c", wrapper, "--"]],
    ["/bin/bash", ["-O", "extglob", "-c", wrapper, "--"]],
  ] as const) {
    const moved = await run(shell, [...args, "echo SHOULD-NOT-RUN"], gone)
    assert.equal(moved.error, undefined, `${shell}: a deleted folder no longer fails the spawn`)
    assert.ok(!moved.stdout.includes("SHOULD-NOT-RUN"), `${shell}: the command does not run somewhere the agent did not choose`)
    assert.match(moved.stderr, /was deleted, so this command did not run/)
    assert.ok(moved.stderr.includes(gone) && moved.stderr.includes(workspace), `${shell}: the notice names both folders`)
    assert.equal(moved.code, 1, `${shell}: the call fails, so the agent runs it again`)
    const recorded = /pwd=(.*)\n/.exec(moved.stdout)?.[1]
    assert.ok(recorded !== undefined && realpathSync(recorded) === realpathSync(workspace), `${shell}: the wrapper records the workspace for the next command`)
    const kept = await run(shell, [...args, "echo ran-here"], workspace)
    assert.ok(kept.stdout.includes("ran-here"), `${shell}: a shell in an existing folder is untouched`)
  }
  assert.equal(warnings.length, 2)
  const other = await run(process.execPath, ["-e", "0"], gone)
  assert.equal(other.error?.code, "ENOENT", "other processes fail as they would")
  assert.equal(warnings.length, 2)

  const quoted = await run("/bin/zsh", ["-c", movedShellCommand("/tmp/it's gone", "/tmp/now")], root)
  assert.match(quoted.stderr, /\/tmp\/it's gone was deleted/, "a quote in a folder name cannot break the notice")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("Cursor shell folder: a shell whose folder was deleted refuses its command, names both folders and moves to the workspace; other spawns are untouched")
