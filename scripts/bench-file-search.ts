import "./lib/scratch-git.mjs"
import { execFileSync } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { Git, GitError, listFiles } from "@mako/git"
import { FileIndexCore } from "@mako/host/contracts/file-index"
import type { WorkspaceFile } from "@mako/host/contracts/git-workspace-search"
import { WorkspaceGit } from "@mako/host/git/index"
import { FolderIndex } from "@mako/host/workspaces/file-index"
import { searchWorkspace } from "@mako/host/workspaces/search"
import { rank } from "../src/lib/fuzzy.ts"

/*
 * How fast the Files view finds things, the way it did before the index and the way it does now, in one run on the
 * same machine: on a folder given (`--folder`, this checkout by default) and on a generated repository of `--files`
 * files (100,000 by default; one folder of it holds 20,000).
 *
 * Before, a window asked the host for every path (`git ls-files` and `git status`, then the whole list over the
 * wire), drew the tree from it and ranked all of it on its own thread at every keystroke; a text search ran
 * `git grep` over everything and answered when it was done. Now the host keeps the index, answers a keystroke from
 * it (narrowing from the last one), lists a folder at a time and stops a text search once it has a screenful.
 *
 * Every number is printed (and written to the job summary on CI). It fails only on a gross regression, judged
 * against the old way measured in turns with it in the same run rather than a fixed number of milliseconds: a
 * keystroke slower than twice ranking the whole list in the window (at the median), a first text result slower than
 * twice the whole old search (the quickest of three each), or a change not seen within five seconds or twice the
 * index's own build.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/bench-file-search.ts [--files 100000] [--folder <path>] [--keep]
 */

const argv = process.argv.slice(2)
const option = (name: string) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const fileCount = Number(option("--files") ?? 100_000)
const given = resolve(option("--folder") ?? join(import.meta.dirname, ".."))
const keep = argv.includes("--keep")
/** A repository an earlier `--keep` run generated, measured again instead of generating one. */
const reuse = option("--repo")

/** What someone types, a keystroke at a time. */
const TYPED = ["fileviewer", "indexcss", "packages/host/file", "rail tree"]
const TEXT = { common: "import", rare: "ZebraQuokka", absent: "qqzzxxyy-not-here" }

type Row = { name: string; before?: number; after?: number; unit?: string; note?: string }
const rows: Row[] = []
const failures: string[] = []

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}
function p95(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0
}
const ms = (value: number) => `${value < 10 ? value.toFixed(2) : value.toFixed(0)} ms`

async function time<T>(run: () => Promise<T> | T): Promise<[number, T]> {
  const started = performance.now()
  const value = await run()
  return [performance.now() - started, value]
}

/** The old list: Git's files and its status, sorted, marked, and carried to the window as JSON. */
async function oldList(git: Git, folder: string): Promise<WorkspaceFile[]> {
  const workspaceGit = new WorkspaceGit(git, folder)
  const repository = await git.openRepository(folder)
  const paths = repository ? await listFiles(git, repository.root) : []
  const status = await workspaceGit.status().catch(() => null)
  const changed = new Set(status?.files.map((file) => file.path) ?? [])
  const files = paths.sort((left, right) => left.localeCompare(right)).map((path) => (changed.has(path) ? { path, changed: true } : { path }))
  // SAFETY: the window parsed what the host serialized: the same list.
  return JSON.parse(JSON.stringify(files)) as WorkspaceFile[]
}

/** `scratch`: the folder is the bench's own, so a file may be written into it to time a change being seen. */
async function measure(label: string, folder: string, git: Git, scratch: boolean): Promise<void> {
  console.log(`\n${label}: ${folder}`)
  const [listMs, files] = await time(() => oldList(git, folder))
  const workspaceGit = new WorkspaceGit(git, folder)
  const index = new FolderIndex({ folder, git, changed: () => workspaceGit.status() })
  index.feed(true)
  const [buildMs, rootListing] = await time(() => index.folders([""]))

  // Before and after in turns, each keystroke and search both ways, so a busy moment of the machine falls on both.
  const oldKeys: number[] = []
  const newKeys: number[] = []
  for (const word of TYPED)
    for (let end = 1; end <= word.length; end += 1) {
      oldKeys.push((await time(() => rank(files, word.slice(0, end), (file) => file.path).slice(0, 400)))[0])
      newKeys.push((await time(() => index.find(word.slice(0, end))))[0])
    }
  const [firstNameMs] = await time(() => index.find("fileviewer"))
  // The quickest of three: one search caught behind a collection or a busy machine says nothing about either way.
  const oldText: Record<string, number> = {}
  const newFirst: Record<string, number> = {}
  const newAll: Record<string, number> = {}
  for (const [kind, term] of Object.entries(TEXT))
    for (let round = 0; round < 3; round += 1) {
      // The old search stops itself after 15 s: on a machine that slow the old way took that long.
      const old = (await time(() => searchWorkspace(folder, workspaceGit, async () => [], term, {}).catch((error: Error) => {
        if (error instanceof GitError && error.kind === "timeout") return undefined
        throw error
      })))[0]
      const first = (await time(() => index.grep(term, { limit: 200 })))[0]
      const all = (await time(() => index.grep(term, { limit: 5_000 })))[0]
      oldText[kind] = Math.min(oldText[kind] ?? Infinity, old)
      newFirst[kind] = Math.min(newFirst[kind] ?? Infinity, first)
      newAll[kind] = Math.min(newAll[kind] ?? Infinity, all)
    }
  const biggest = rootListing.folders[0]?.folders.reduce((best, folder) => (folder.files > best.files ? folder : best), { path: "", files: 0, name: "", changed: false })
  const [openMs, opened] = await time(() => index.folders([biggest?.path ?? ""]))

  // A file appearing and going, as the watcher hears it.
  const probe = `bench-probe-${Date.now()}.ts`
  if (scratch) writeFileSync(join(folder, probe), "probe\n")
  const [seenMs] = !scratch ? [0] : await time(async () => {
    index.noteChanges([probe])
    for (;;) {
      const found = await index.find(probe)
      if (found.hits[0]?.path.endsWith(probe)) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })
  if (scratch) rmSync(join(folder, probe))
  const [goneMs] = !scratch ? [0] : await time(async () => {
    index.noteChanges([probe])
    for (;;) {
      const found = await index.find(probe)
      if (!found.hits.some((hit) => hit.path.endsWith(probe))) return
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })
  index.close()

  const fileTotal = rootListing.total
  rows.push(
    { name: `${label}: files`, after: fileTotal, unit: "files" },
    { name: `${label}: first name result, cold (list or build, then a keystroke)`, before: listMs + (oldKeys[0] ?? 0), after: buildMs + firstNameMs },
    { name: `${label}: keystroke, median`, before: median(oldKeys), after: median(newKeys) },
    { name: `${label}: keystroke, 95th percentile`, before: p95(oldKeys), after: p95(newKeys) },
    { name: `${label}: open the largest folder (${biggest?.files ?? 0} files)`, after: openMs, note: `${opened.folders[0]?.folders.length ?? 0} folders and ${opened.folders[0]?.files.length ?? 0} files listed, ${opened.folders[0]?.more ?? 0} more` },
    ...Object.keys(TEXT).flatMap((kind) => [
      { name: `${label}: text "${kind}", first result`, before: oldText[kind], after: newFirst[kind] },
      { name: `${label}: text "${kind}", complete`, before: oldText[kind], after: newAll[kind] },
    ]),
    ...(scratch ? [{ name: `${label}: a new file found by name`, after: seenMs }, { name: `${label}: a deleted file gone`, after: goneMs }] : []),
  )
  // The median: one keystroke caught behind a collection or a busy machine says nothing about the index.
  if (median(newKeys) > Math.max(median(oldKeys), 5) * 2) failures.push(`${label}: a keystroke took ${ms(median(newKeys))} at the median, past twice ranking the whole list in the window (${ms(median(oldKeys))})`)
  for (const kind of Object.keys(TEXT))
    if ((newFirst[kind] ?? 0) > Math.max(oldText[kind] ?? 0, 50) * 2) failures.push(`${label}: the first "${kind}" text result took ${ms(newFirst[kind] ?? 0)}, past twice the whole old search`)
  // A change is applied a moment after it's heard; five seconds, or twice what building the whole index took here, is it missed.
  const seenLimit = Math.max(5_000, 2 * buildMs)
  if (seenMs > seenLimit || goneMs > seenLimit) failures.push(`${label}: a change took ${ms(Math.max(seenMs, goneMs))} to be seen, past ${ms(seenLimit)}`)
}

/** A repository shaped like a large monorepo: packages of nested source, tests and docs, and one folder of generated files. */
function generate(root: string, count: number): void {
  let seed = 7
  const random = () => ((seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648)
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  const words = ["file", "viewer", "index", "tree", "rail", "session", "store", "router", "button", "panel", "search", "token", "cache", "event", "model", "graph", "query", "sheet", "theme", "layout"]
  const kinds = [".ts", ".tsx", ".ts", ".tsx", ".js", ".json", ".md", ".css", ".py", ".rs", ".go", ".yml"]
  const big = Math.min(20_000, Math.floor(count / 5))
  for (let index = 0; index < count; index += 1) {
    const path = index < big
      ? `generated/fixtures/case-${index}${pick(kinds)}`
      : `packages/${pick(words)}-${index % 120}/${pick(["src", "src", "test", "docs"])}/${pick(words)}/${pick(words)}-${pick(words)}-${index}${pick(kinds)}`
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    const rare = index % 9_973 === 0 ? "ZebraQuokka\n" : ""
    writeFileSync(full, `import { ${pick(words)} } from "./${pick(words)}"\nexport const value${index} = ${index}\n${rare}`)
  }
  writeFileSync(join(root, "index.css"), ":root {}\n")
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore", maxBuffer: 1 << 30 })
  run("init", "-q")
  run("add", "-A")
  run("-c", "user.email=bench@example.invalid", "-c", "user.name=Bench", "commit", "-qm", "files")
  // Files written in the second Git's index was are "racily clean": every status reads them all again. A real
  // checkout's files are older than its index, so the index is written again once that second has passed.
  execFileSync("sleep", ["1.2"])
  run("update-index", "--really-refresh")
  run("status", "--porcelain")
}

const git = new Git()
const scratch = reuse ? realpathSync(reuse) : realpathSync(mkdtempSync(join(tmpdir(), "mako-bench-files-")))
try {
  await measure("this checkout", given, git, false)
  if (!reuse) {
    console.log(`\ngenerating ${fileCount.toLocaleString()} files in ${scratch}`)
    const [generateMs] = await time(() => generate(scratch, fileCount))
    console.log(`generated in ${ms(generateMs)}`)
  }
  await measure(`${Math.round(fileCount / 1000)}k files`, scratch, git, true)
} finally {
  await git.close()
  if (!keep && !reuse) rmSync(scratch, { recursive: true, force: true })
  else console.log(`kept ${scratch}`)
}

// The index on its own, with nothing but its own work timed: a yardstick for the keystroke numbers above.
const synthetic = new FileIndexCore(Array.from({ length: fileCount }, (_, index) => `packages/p${index % 300}/src/f${index % 997}/name-${index}.ts`))
const coreKeys: number[] = []
for (const word of ["n", "na", "nam", "name", "name-9", "name-99"]) coreKeys.push(synthetic.find(word).ms)
rows.push({ name: `index alone, ${Math.round(fileCount / 1000)}k paths: keystroke, median`, after: median(coreKeys) })

const lines = [
  "| Measure | Before | After |",
  "| --- | ---: | ---: |",
  ...rows.map((row) => `| ${row.name}${row.note ? ` (${row.note})` : ""} | ${row.before === undefined ? "" : ms(row.before)} | ${row.after === undefined ? "" : row.unit ? `${row.after.toLocaleString()} ${row.unit}` : ms(row.after)} |`),
]
console.log(`\n${lines.join("\n")}`)
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## File search\n\n${lines.join("\n")}\n`)
if (failures.length) {
  console.error(`\n${failures.join("\n")}`)
  process.exitCode = 1
}
