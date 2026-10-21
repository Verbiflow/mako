import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { answersId, prefetchProcess, readAlongside, runPrefetch, type StartPrefetch } from "@mako/host/harnesses/start-prefetch"

// A start run ahead: its files read whole by several readers, and its process taken through its exchange, each step
// written once the one before is answered, then stopped. Nothing throws and nothing is left running.
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
  const heard = join(root, "heard")
  // Answers each request by its id, after the first a moment later, and writes noise between.
  const server = await fixture("server", `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(pids)}, process.pid + "\\n")
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  fs.appendFileSync(${JSON.stringify(heard)}, line + "\\n")
  const message = JSON.parse(line)
  if (message.id === undefined) return
  process.stdout.write("not json\\n" + JSON.stringify({ note: "progress" }) + "\\n")
  setTimeout(() => process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n"), 30)
})
setInterval(() => {}, 1000)`)
  const exchange = [
    { send: JSON.stringify({ id: 0, method: "initialize" }), answer: answersId(0) },
    { send: `${JSON.stringify({ method: "initialized" })}\n${JSON.stringify({ id: 1, method: "open" })}`, answer: answersId(1) },
  ]
  assert.equal(await prefetchProcess({ ...server, exchange }, root, "test"), true, "each step answered by its id, in order")
  assert.deepEqual((await readFile(heard, "utf8")).trim().split("\n").map((line) => JSON.parse(line).method), ["initialize", "initialized", "open"], "a step is written only once the one before is answered")
  const [pid] = (await readFile(pids, "utf8")).trim().split("\n").map(Number)
  assert.ok(await gone(pid!), "and the process is stopped")

  const speaks = await fixture("speaks", `process.stdout.write("ready\\n"); setInterval(() => {}, 1000)`)
  assert.equal(await prefetchProcess(speaks, root, "test"), true, "with no exchange, its first output is the answer")
  const exits = await fixture("exits", "process.exit(3)")
  assert.equal(await prefetchProcess({ ...exits, exchange }, root, "test"), false, "an exit before the answer is no answer")
  const silent = await fixture("silent", "setInterval(() => {}, 1000)")
  const began = performance.now()
  assert.equal(await prefetchProcess({ ...silent, exchange }, root, "test", 200), false, "silence until its time is no answer")
  assert.ok(performance.now() - began < 2_000)
  assert.equal(await prefetchProcess({ command: join(root, "missing"), args: [], env: process.env }, root, "test"), false, "a missing executable is no answer, not a throw")
  assert.equal(await prefetchProcess({ ...server, exchange }, join(root, "gone"), "test"), false, "nor is a missing folder")
  assert.equal(await prefetchProcess(undefined, root, "test"), false, "nor a harness that isn't installed")

  const folder = join(root, "package")
  await mkdir(join(folder, "lib"), { recursive: true })
  await writeFile(join(folder, "lib", "big"), Buffer.alloc((20 << 20) + 5, 1))
  await writeFile(join(folder, "small"), "x".repeat(10))
  const read = await readAlongside([folder, join(root, "missing"), join(folder, "small")])
  assert.equal(read.bytes, (20 << 20) + 5 + 10 + 10, "a folder is read whole, a file as given, a missing path skipped")

  const prefetch: StartPrefetch = { via: "test", files: async () => [join(folder, "small")], run: async () => true }
  const outcome = await runPrefetch(prefetch, process.env, root, "test")
  assert.equal(outcome.answered, true)
  assert.equal(outcome.readMiB, 0)
  const failing: StartPrefetch = { via: "test", files: async () => { throw new Error("no files") }, run: async () => { throw new Error("no start") } }
  assert.deepEqual({ ...(await runPrefetch(failing, process.env, root, "test")), ms: 0 }, { answered: false, ms: 0, readMiB: 0, readMs: 0 }, "a half that throws is a half that didn't answer")
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log("Start prefetch: files read whole by several readers; an exchange step by step, answered by id; no answer on exit, time, or a missing executable or folder; nothing left running")
