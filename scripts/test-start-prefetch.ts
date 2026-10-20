import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { prefetchStart } from "@mako/host/harnesses/start-prefetch"

// A start run ahead stops at its process's first answer, its exit or its time, whichever comes first; it never throws
// and never leaves the process running.
const root = await mkdtemp(join(tmpdir(), "mako-start-prefetch-"))
// Run by this process's own Node, whose path (Electron's Helper's, under Electron) a shebang can't hold.
const fixture = async (name: string, body: string) => {
  const path = join(root, name)
  await writeFile(path, `${body}\n`)
  return { command: process.execPath, args: [path], env: process.env }
}
const gone = (pid: number) => new Promise<boolean>((resolve) => setTimeout(() => {
  try {
    process.kill(pid, 0)
    resolve(false)
  } catch {
    resolve(true)
  }
}, 300))
try {
  const pids = join(root, "pids")
  const answers = await fixture("answers", `require("node:fs").appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n")
process.stdin.once("data", (line) => process.stdout.write(String(line).trim() === "hello" ? "hi\\n" : "?\\n"))
setInterval(() => {}, 1000)`)
  const answered = await prefetchStart({ ...answers, first: "hello" }, root, "test")
  assert.equal(answered.answered, true, "the first answer ends it")
  const [pid] = (await import("node:fs")).readFileSync(pids, "utf8").trim().split("\n").map(Number)
  assert.ok(await gone(pid!), "and the process is stopped")

  const exits = await fixture("exits", "process.exit(3)")
  assert.equal((await prefetchStart(exits, root, "test")).answered, false, "an exit without an answer is no answer")

  const silent = await fixture("silent", "setInterval(() => {}, 1000)")
  const waited = await prefetchStart(silent, root, "test", 200)
  assert.equal(waited.answered, false, "silence until its time is no answer")
  assert.ok(waited.ms >= 200 && waited.ms < 2_000)

  assert.equal((await prefetchStart({ command: join(root, "missing"), args: [], env: process.env }, root, "test")).answered, false, "a missing executable is no answer, not a throw")
  assert.equal((await prefetchStart({ ...answers, first: "hello" }, join(root, "gone"), "test")).answered, false, "nor is a missing folder")
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("Start prefetch: stops at the first answer, an exit or its time; never throws; leaves nothing running")
