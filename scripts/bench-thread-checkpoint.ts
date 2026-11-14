import "./lib/scratch-git.mjs"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { Git } from "@mako/git"
import { contentRef } from "@mako/host/attribution/index"
import type { Partition } from "@mako/host/attribution/queries"
import { captureThreadCheckpoint } from "@mako/host/workspaces/thread-checkpoint"

/*
 * What a Thread's checkpoint costs (`thread-checkpoint.ts`) on a checkout the size of a busy one: a clone of this
 * repository, with `--files` files changed by the Thread (default 40). Runs `--captures` captures (default 20) in a
 * child under `/usr/bin/time -l`, and an empty run beside it, so the CPU counted is capture's own, its Git children
 * included. Prints wall time per capture, CPU per capture, and CPU per hour at one capture every 30 s.
 *
 *   npx tsx scripts/bench-thread-checkpoint.ts [--files 40] [--captures 20] [--source <repository>]
 */

const here = fileURLToPath(import.meta.url)
const arg = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`)
  return at > 0 ? process.argv[at + 1]! : fallback
}

if (process.argv[2] === "child") {
  const repo = process.argv[3]!
  const captures = Number(process.argv[4])
  // SAFETY: the parent wrote partition.json from a `Partition["files"]` just before it started this process.
  const files = JSON.parse(readFileSync(join(repo, "..", "partition.json"), "utf8")) as Partition["files"]
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim()
  const partition: Partition = { checkout: repo, thread: "T", roots: [{ root: "repo", path: repo, head }], files, whole: [], uncertain: [], unattributed: [], ms: 0 }
  const git = new Git()
  const ledger = { settled: async () => {}, track: async () => {}, head: () => head, partition: () => partition }
  const walls: number[] = []
  for (let i = 0; i < captures; i++) {
    const folder = mkdtempSync(join(tmpdir(), "mako-bench-checkpoint-out-"))
    const started = performance.now()
    const taken = await captureThreadCheckpoint({ git, ledger, thread: "T", repoRoot: repo, branch: "mako/bench", folder })
    walls.push(performance.now() - started)
    if (i === 0) process.stderr.write(`took ${taken.took.length} files, bundle ${taken.checkpoint.bytes} bytes\n`)
    rmSync(folder, { recursive: true, force: true })
  }
  await git.close()
  process.stdout.write(JSON.stringify(walls))
  process.exit(0)
}

const source = arg("source", execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim())
const changed = Number(arg("files", "40"))
const captures = Number(arg("captures", "20"))
const base = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-checkpoint-")))
try {
  const repo = join(base, "repo")
  execFileSync("git", ["clone", "--quiet", source, repo])
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" }).split("\0").filter((path) => /\.(ts|tsx|md|json)$/.test(path))
  // The Thread appended a line to each of its files; the journal holds them as they are.
  const files: Partition["files"] = tracked.slice(0, changed).map((path) => {
    const before = readFileSync(join(repo, path))
    const after = Buffer.concat([before, Buffer.from("// by the Thread\n")])
    writeFileSync(join(repo, path), after)
    return { root: "repo", path, move: "lines" as const, current: contentRef(after), thread: { kind: "text" as const, text: after.toString("utf8") }, remaining: { kind: "content" as const, ref: contentRef(before) } }
  })
  writeFileSync(join(base, "partition.json"), JSON.stringify(files))
  const run = (count: number) => {
    const result = spawnSync("/usr/bin/time", ["-l", process.execPath, "--import", "tsx", here, "child", repo, String(count)], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(result.stderr)
    const cpu = (label: string) => Number(new RegExp(`([0-9.]+) ${label}`).exec(result.stderr)![1])
    // SAFETY: the child's only stdout is `JSON.stringify` of its array of wall times.
    return { cpu: cpu("user") + cpu("sys"), walls: JSON.parse(result.stdout) as number[], note: result.stderr.split("\n").find((line) => line.startsWith("took")) }
  }
  const idle = run(0)
  const busy = run(captures)
  const sorted = [...busy.walls].sort((a, b) => a - b)
  const perCapture = ((busy.cpu - idle.cpu) / captures) * 1000
  const load = execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim()
  console.log(JSON.stringify({
    trackedFiles: execFileSync("git", ["ls-files"], { cwd: repo, encoding: "utf8" }).split("\n").length - 1,
    changedFiles: changed,
    captures,
    note: busy.note,
    wallMs: { median: Math.round(sorted[Math.floor(sorted.length / 2)]!), p90: Math.round(sorted[Math.floor(sorted.length * 0.9)]!), max: Math.round(sorted.at(-1)!) },
    cpuMsPerCapture: Math.round(perCapture),
    cpuSecondsPerHourAt30s: Math.round((perCapture * 120) / 100) / 10,
    load,
  }, null, 2))
} finally {
  rmSync(base, { recursive: true, force: true })
}
