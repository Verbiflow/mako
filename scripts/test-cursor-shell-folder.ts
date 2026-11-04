import assert from "node:assert/strict"
import * as childProcess from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  guardShellFolder,
  movedShellCommand,
  shellCommandIndex,
} from "@mako/host/harnesses/cursor/sdk/shell-folder"
import { routeShellCall } from "@mako/host/contracts/native-calls"
import { Writable } from "node:stream"

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
const routed: string[] = []
guardShellFolder(() => workspace, (message) => warnings.push(message), (command, cwd) => {
  routed.push(`${cwd}: ${command}`)
  const thread = { folder: workspace, recipe: { kind: "ready" as const, processes: ["web"] } }
  return routeShellCall(thread, { command, cwd })
})

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

  // Routing: a deny runs its notice instead of the command and fails; a warn prints its note and runs the command.
  for (const [shell, args] of [
    ["/bin/zsh", ["-c", wrapper, "--"]],
    ["/bin/bash", ["-O", "extglob", "-c", wrapper, "--"]],
  ] as const) {
    const denied = await run(shell, [...args, "echo SHOULD-NOT-RUN && gh pr merge --squash"], workspace)
    assert.ok(!denied.stdout.includes("SHOULD-NOT-RUN"), `${shell}: nothing on a denied line runs`)
    assert.match(denied.stderr, /Call pull_request_merge instead/, `${shell}: the agent reads the redirect`)
    assert.equal(denied.code, 1, `${shell}: a denied command fails`)
    const warned = await run(shell, [...args, "lsof -i :1 ; echo it-ran"], workspace)
    assert.ok(warned.stdout.includes("it-ran"), `${shell}: a warned command runs`)
    assert.match(warned.stderr, /port_holder names who holds a port/, `${shell}: and the agent reads the note`)
    const plain = await run(shell, [...args, "echo plain"], workspace)
    assert.ok(plain.stdout.includes("plain") && !plain.stderr.trim(), `${shell}: an ordinary command is untouched`)
  }
  assert.ok(routed.every((line) => line.startsWith(`${workspace}: `)), "the route reads the shell's folder")

  // SDK 1.2.0's shape: the command arrives on descriptor 5, ended by a NUL, in one `end` after the shell starts.
  const piped = async (text: string) => {
    const script = `IFS= builtin read -r -d '' __cursor_command <&5 2>/dev/null || builtin exit 126; exec 5<&-; builtin eval "$__cursor_command"`
    const child = childProcess.spawn("/bin/zsh", ["-c", script, "--"], { cwd: workspace, stdio: ["ignore", "pipe", "pipe", "ignore", "ignore", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const pipe = child.stdio.at(5)
    assert.ok(pipe instanceof Writable)
    pipe.end(`${text}\0`)
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve))
    return { code, stdout, stderr }
  }
  const pipedDenied = await piped("echo SHOULD-NOT-RUN && gh pr merge --squash")
  assert.ok(!pipedDenied.stdout.includes("SHOULD-NOT-RUN"), "a piped command routing denies doesn't run")
  assert.match(pipedDenied.stderr, /Call pull_request_merge instead/)
  assert.equal(pipedDenied.code, 1)
  const pipedWarned = await piped("lsof -i :1 ; echo it-ran")
  assert.ok(pipedWarned.stdout.includes("it-ran") && /port_holder/.test(pipedWarned.stderr), "a piped command routing warns of runs after its note")
  const pipedPlain = await piped("echo plain-piped")
  assert.ok(pipedPlain.stdout.includes("plain-piped") && !pipedPlain.stderr.trim(), "an ordinary piped command is untouched")

  const quoted = await run("/bin/zsh", ["-c", movedShellCommand("/tmp/it's gone", "/tmp/now")], root)
  assert.match(quoted.stderr, /\/tmp\/it's gone was deleted/, "a quote in a folder name cannot break the notice")
} finally {
  rmSync(root, { recursive: true, force: true })
}
console.log("Cursor shell folder: a shell whose folder was deleted refuses its command, names both folders and moves to the workspace; a routed command is refused or noted; other spawns are untouched")
