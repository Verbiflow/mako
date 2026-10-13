import type { Git } from "@mako/git"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { JournalView, Partition, PartitionFile } from "./queries.js"

/** A Thread's side of one repository, as a Git tree. */
export interface ThreadTree {
  root: string
  /** The repository's folder. */
  path: string
  /** The commit the tree is based on; null for a repository with no commits. */
  base: string | null
  /** Base plus the Thread's last-writer lines, its created files and the deletions it made. */
  tree: string
  files: number
}

const NO_OBJECT = "0".repeat(40)
const StagedLine = z.tuple([z.string(), z.string()])

/**
 * The Thread's side of a partition as one Git tree per repository, written
 * with plumbing into a temporary index: the checkout's files, its index and
 * its HEAD are never touched. A worktree move checks the tree out; a Thread
 * leaving for the cloud commits it as its departure commit. The blobs go
 * into the repository's own object store, so either can use them at once.
 */
export async function threadTrees(git: Git, view: JournalView, result: Partition): Promise<ThreadTree[]> {
  const out: ThreadTree[] = []
  for (const root of result.roots) {
    const stored = [...view.roots()].find((item) => item.root.id === root.root)?.root
    if (!stored?.repository) continue
    const files = result.files.filter((file) => file.root === root.root)
    const directory = await mkdtemp(join(tmpdir(), "mako-thread-tree-"))
    try {
      const env = { GIT_INDEX_FILE: join(directory, "index") }
      await git.run({ cwd: root.path, args: ["read-tree", root.head ?? "--empty"], env })
      const modes = await indexModes(git, root.path, env, files.map((file) => file.path))
      const writes = files.filter((file) => file.thread.kind !== "absent")
      const sources = await Promise.all(writes.map(async (file, index) => {
        const source = join(directory, `blob-${index}`)
        await writeFile(source, await bytesOf(view, root.path, file))
        return source
      }))
      const oids = sources.length
        ? (await git.text({ cwd: root.path, args: ["hash-object", "-w", "--no-filters", "--stdin-paths"], input: `${sources.join("\n")}\n` })).split("\n").filter(Boolean)
        : []
      if (oids.length !== writes.length) throw new Error("Git didn't store every file of the Thread's side.")
      const lines = files.map((file) => {
        const at = writes.indexOf(file)
        if (at < 0) return `0 ${NO_OBJECT}\t${file.path}`
        return `${modes.get(file.path) ?? (executable(root.path, file, view) ? "100755" : "100644")} ${oids[at]}\t${file.path}`
      })
      if (lines.length) await git.run({ cwd: root.path, args: ["update-index", "--index-info"], input: `${lines.join("\n")}\n`, env })
      const tree = await git.text({ cwd: root.path, args: ["write-tree"], env })
      out.push({ root: root.root, path: root.path, base: root.head, tree, files: files.length })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
  return out
}

async function bytesOf(view: JournalView, rootPath: string, file: PartitionFile): Promise<Uint8Array> {
  const version = file.thread
  if (version.kind === "text") return Buffer.from(version.text, "utf8")
  if (version.kind === "absent") throw new Error(`${file.path} has no content on the Thread's side.`)
  const kept = view.store.blob(version.ref)
  if (kept) return kept
  return readFile(version.path ?? join(rootPath, file.path))
}

/** The modes the base gives `paths`, so an executable stays one. */
async function indexModes(git: Git, cwd: string, env: Record<string, string>, paths: readonly string[]): Promise<Map<string, string>> {
  if (!paths.length) return new Map()
  const listed = await git.run({ cwd, args: ["ls-files", "-s", "-z", "--", ...paths.map((path) => `:(literal)${path}`)], env, read: true })
  const out = new Map<string, string>()
  for (const record of listed.stdout.toString("utf8").split("\0")) {
    if (!record) continue
    const [meta, path] = StagedLine.parse(record.split("\t"))
    out.set(path, meta.split(" ")[0]!)
  }
  return out
}

/** A file new to the repository is executable when its stat says so. */
function executable(rootPath: string, file: PartitionFile, view: JournalView): boolean {
  const stats = [...view.roots()].find((item) => item.root.path === rootPath)?.stats
  return Boolean(((stats?.get(file.path)?.mode ?? 0) & 0o111) !== 0)
}
