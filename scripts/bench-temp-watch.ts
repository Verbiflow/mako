import "./lib/scratch-git.mjs"
import { Git } from "@mako/git"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchTree } from "@mako/host/workspaces/tree-watcher"
import { childBackend } from "@mako/host/workspaces/watch-backend"

/*
 * A tree watch of a folder shaped like a busy Mac's temporary folder, through the host's own `watchTree` and watcher
 * child: scratch checkouts (by default 6,800 files in 1,850 folders each, a source archive's shape) made and kept, then
 * made and deleted one after another, as agents and tests do. Prints the child's CPU and resident memory over the
 * churn, and how often events were dropped.
 *
 * @parcel/watcher's FSEvents backend keeps every path a subscription has heard created in one hash map and, for each
 * folder deleted, walks the whole map for what was under it. A watch of the temporary folder (the installed app's
 * live footprint watch before #1001) held millions of paths, so each deleted scratch checkout cost minutes of a core
 * and the child grew past a gigabyte.
 *
 * `--as-temporary` makes the folder this process's temporary folder (`TMPDIR`), the shape of that watch; the host
 * refuses to watch one, so the child never starts. Without it the folder is watched as any project would be.
 *
 *   npx tsx scripts/bench-temp-watch.ts [--as-temporary] [--keep 20] [--churn 60] [--files 6800] [--folders 1850]
 */

const argv = process.argv.slice(2)
const option = (name: string, fallback: number) => {
  const at = argv.indexOf(name)
  return at >= 0 ? Number(argv[at + 1]) : fallback
}
const asTemporary = argv.includes("--as-temporary")
const keep = option("--keep", 20)
const churnS = option("--churn", 60)
const files = option("--files", 6800)
const folders = option("--folders", 1850)

const root = realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-temp-watch-")))
if (asTemporary) process.env.TMPDIR = root

/** One scratch checkout: `folders` folders two deep, `files` files spread over them. */
function scratch(name: string): void {
  const top = Math.max(1, Math.round(Math.sqrt(folders)))
  const made: string[] = []
  for (let index = 0; index < folders; index++) {
    const folder = join(root, name, `d${index % top}`, `s${index}`)
    mkdirSync(folder, { recursive: true })
    made.push(folder)
  }
  for (let index = 0; index < files; index++) writeFileSync(join(made[index % made.length]!, `f${index}.ts`), "export {}\n")
}

/** The child's CPU seconds and resident memory, from `ps`. */
function usage(pid: number) {
  const [rss = "0", time = "0"] = execFileSync("ps", ["-o", "rss=,time=", "-p", String(pid)], { encoding: "utf8" }).trim().split(/\s+/)
  return { cpuS: time.split(":").reduce((total, part) => total * 60 + Number(part), 0), rssMb: Number(rss) / 1024 }
}
function childPid(): number | undefined {
  try {
    const found = Number(execFileSync("pgrep", ["-P", String(process.pid), "-f", "watcher-child-main"], { encoding: "utf8" }).trim().split("\n")[0])
    return Number.isFinite(found) && found > 0 ? found : undefined
  } catch {
    return undefined
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms))
let heard = 0
let dropped = 0
const backend = childBackend()

try {
  const watch = watchTree(new Git(), backend, root, (paths) => { heard += paths.length }, () => {}, (why) => { if (why === "dropped") dropped += 1 })
  if (watch) await watch.ready
  await sleep(1_000)
  const pid = childPid()
  console.log(`root ${asTemporary ? "is the temporary folder" : "is an ordinary folder"}: ${watch ? "watched" : "refused"}, watcher child ${pid ?? "not started"}`)
  const at = () => (pid === undefined ? { cpuS: 0, rssMb: 0 } : usage(pid))

  const before = at()
  const keptFrom = performance.now()
  for (let index = 0; index < keep; index++) scratch(`kept-${index}`)
  await sleep(5_000)
  const kept = at()
  console.log(`kept ${keep} scratch checkouts (${keep * (files + folders)} paths) in ${((performance.now() - keptFrom) / 1000).toFixed(1)} s: child +${(kept.cpuS - before.cpuS).toFixed(1)} CPU s, ${kept.rssMb.toFixed(0)} MB`)

  const churnFrom = performance.now()
  let rounds = 0
  while (performance.now() - churnFrom < churnS * 1000) {
    scratch("churn")
    rmSync(join(root, "churn"), { recursive: true, force: true })
    rounds += 1
  }
  await sleep(10_000)
  const churned = at()
  const wallS = (performance.now() - churnFrom) / 1000
  console.log(`churned ${rounds} scratch checkouts in ${wallS.toFixed(0)} s (+10 s to settle): child ${(churned.cpuS - kept.cpuS).toFixed(1)} CPU s (${((100 * (churned.cpuS - kept.cpuS)) / wallS).toFixed(0)}% of a core), ${churned.rssMb.toFixed(0)} MB; ${heard} paths heard, ${dropped} drops`)
  watch?.close()
} finally {
  rmSync(root, { recursive: true, force: true })
  await sleep(500)
  process.exit(0)
}
