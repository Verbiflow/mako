import type { Git } from "@mako/git"
import { createReadStream, readdirSync, realpathSync } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { z } from "zod"
import type { RootPath, TrackerChangeListener, TrackerEventSource, TrackerFileStat, TrackerFileSystem } from "@mako/protocol"
import type { TrackerRepository } from "./tracker.js"

/*
 * The tracker's ports on this machine: Node's file system, the host's one
 * watcher child and the system's history (FSEvents ids), and Git through
 * `@mako/git`. The host composes them; tests pass fakes of the same ports.
 */

const Errno = z.object({ code: z.string() })
/** Nothing there, or not a file or folder the path can reach. */
const MISSING = new Set(["ENOENT", "ENOTDIR", "ELOOP"])

export function nodeFileSystem(): TrackerFileSystem {
  return {
    async stat(path) {
      try {
        const stat = await lstat(path, { bigint: true })
        const kind: TrackerFileStat["kind"] = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "other"
        return { kind, dev: Number(stat.dev), ino: Number(stat.ino), size: Number(stat.size), mode: Number(stat.mode), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs }
      } catch (error) {
        if (MISSING.has(Errno.safeParse(error).data?.code ?? "")) return null
        throw error
      }
    },
    async read(path) {
      try {
        return await readFile(path)
      } catch (error) {
        const code = Errno.safeParse(error).data?.code ?? ""
        if (MISSING.has(code) || code === "EISDIR") return null
        throw error
      }
    },
    stream: (path) => createReadStream(path, { highWaterMark: 1024 * 1024 }),
    async walk(root, skip) {
      const out: RootPath[] = []
      const visit = async (folder: string, prefix: string) => {
        let entries
        try {
          entries = await readdir(folder, { withFileTypes: true })
        } catch (error) {
          if (MISSING.has(Errno.safeParse(error).data?.code ?? "")) return
          throw error
        }
        for (const entry of entries) {
          const path = prefix ? `${prefix}/${entry.name}` : entry.name
          if (skip(path)) continue
          if (entry.isDirectory()) await visit(join(folder, entry.name), path)
          else if (entry.isFile()) out.push(path)
        }
      }
      await visit(root, "")
      return out
    },
  }
}

/**
 * The links at the top of the file system and where they lead, such as
 * `/tmp` to `/private/tmp` on macOS: the system's history reports the
 * target, while harnesses name paths as people type them.
 */
export function rootLinks(): [link: string, target: string][] {
  return readdirSync("/", { withFileTypes: true }).flatMap((entry): [string, string][] => {
    if (!entry.isSymbolicLink()) return []
    try {
      return [[`/${entry.name}`, realpathSync(`/${entry.name}`)]]
    } catch (error) {
      if (MISSING.has(Errno.safeParse(error).data?.code ?? "")) return []
      throw error
    }
  })
}

/** A watch of one folder, as the host's tree watcher gives it: paths relative to it. */
export type TreeWatcher = (
  root: string, changed: (paths: string[]) => void, gone: () => void, dropped: (why: "dropped" | "polling" | "listening") => void,
) => { readonly ready: Promise<void>; close(): void } | undefined

/** The system's history, as the host's watcher child reads it (FSEvents, macOS only). */
export interface SystemHistory {
  mark(): Promise<{ id: string; at: string }>
  since(
    mark: { id: string; at: string }, roots: readonly string[], options?: { ignore?: readonly string[]; exclude?: readonly string[] },
  ): Promise<{ paths: string[]; lost: string[]; ignored: number[] }>
}

const Mark = z.string().regex(/^\d+:\d+$/)

/**
 * The host's watcher and history as the tracker's event source. A watch
 * polling because delivery went silent is `muted` until it listens again,
 * and rescanned once then, not on the way in as well. `own` names Mako's
 * own folders, which no history read needs: fseventsd leaves them out
 * before they're replayed.
 */
export function watcherEvents(watch: TreeWatcher, history: SystemHistory | undefined, own: () => readonly string[] = () => []): TrackerEventSource {
  return {
    async watch(root, listener: TrackerChangeListener) {
      const dropped = (why: "dropped" | "polling" | "listening") => (why === "listening" ? listener.heard() : listener.lost(why === "polling" ? "muted" : "dropped"))
      const watching = watch(root, (paths) => listener.changed(paths), () => listener.lost("gone"), dropped)
      if (!watching) throw new Error(`${root} can't be watched.`)
      await watching.ready
      return watching
    },
    async mark() {
      if (!history) return null
      try {
        const mark = await history.mark()
        return `${mark.id}:${mark.at}`
      } catch {
        return null
      }
    },
    async since(mark, root, options) {
      if (!history || !Mark.safeParse(mark).success) return null
      const [id = "", at = ""] = mark.split(":")
      try {
        const found = await history.since({ id, at }, [root], { ...options, exclude: own() })
        return { paths: found.paths, complete: found.lost.length === 0, ignored: found.ignored }
      } catch {
        return null
      }
    },
  }
}

const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
/** Refs each worktree keeps for itself; every other is in the repository's common folder. */
const OWN_REF = /^(?:[A-Z_]+|refs\/(?:bisect|worktree|rewritten)\/.*)$/

/**
 * The commit a checkout's HEAD names, read from Git's own files: its `.git` folder (a linked worktree's `.git` file
 * says where that is), HEAD there, and the branch it names as a file of its own or a line of `packed-refs`. Null
 * before the first commit. Undefined when the files can't say (no `.git`, a ref store kept as a reftable, a ref that
 * reads as neither): the caller asks Git. The tracker reads HEAD after every move of Git's files and around each
 * shell reconciliation, and asking Git each time was a process each time.
 */
export async function headFromFiles(root: string): Promise<string | null | undefined> {
  const text = (path: string) => readFile(path, "utf8").then((found) => found.trim(), () => undefined)
  try {
    let folder = join(root, ".git")
    if ((await lstat(folder)).isFile()) {
      const linked = /^gitdir: (.+)$/.exec((await text(folder)) ?? "")
      if (!linked) return undefined
      folder = resolve(root, linked[1]!)
    }
    const shared = await text(join(folder, "commondir"))
    const common = shared === undefined ? folder : resolve(folder, shared)
    if (await lstat(join(common, "reftable")).then(() => true, () => false)) return undefined
    let ref = await text(join(folder, "HEAD"))
    for (let hops = 0; ref !== undefined && hops < 5; hops++) {
      if (OID.test(ref)) return ref
      const name = /^ref: (.+)$/.exec(ref)?.[1]
      if (!name || name.includes("..")) return undefined
      const loose = await text(join(OWN_REF.test(name) ? folder : common, name))
      if (loose !== undefined) {
        ref = loose
        continue
      }
      const packed = (await text(join(common, "packed-refs")))?.split("\n").find((line) => line.endsWith(` ${name}`) && !line.startsWith("#") && !line.startsWith("^"))
      const oid = packed?.slice(0, packed.indexOf(" "))
      return oid === undefined ? null : OID.test(oid) ? oid : undefined
    }
    return undefined
  } catch {
    return undefined
  }
}

/** Git's view of a repository for the tracker, through the host's `Git`. */
export function gitRepository(git: Git, root: string, watchGitDir?: (folder: string, moved: () => void) => { close(): void }): TrackerRepository {
  const opened = git.openRepository(root)
  const list = async (args: readonly string[], codes?: number[]) => {
    const result = await git.run({ cwd: root, args, read: true, maxBytes: 256 * 1024 * 1024, codes })
    return result.stdout.toString("utf8").split("\0").filter(Boolean)
  }
  const head = async () => {
    const found = await headFromFiles(root)
    if (found !== undefined) return found
    const result = await git.run({ cwd: root, args: ["rev-parse", "--verify", "-q", "HEAD"], codes: [1], read: true })
    return result.code === 0 ? result.stdout.toString("utf8").trim() : null
  }
  return {
    head,
    async inventory(includeTracked = true) {
      const commit = await head()
      // Before the first commit there's no base: everything there is new.
      if (!commit) {
        const [tracked, untracked] = await Promise.all([list(["ls-files", "-z"]), list(["ls-files", "-z", "--others", "--exclude-standard"])])
        return { tracked: [], untracked: [...tracked, ...untracked], changed: [] }
      }
      // One reading of the index and one walk for both lists: `ls-files --others` and `diff HEAD` each made their own.
      // A path staged and then put back is listed as changed here though it holds HEAD's content; reading it finds no change.
      const [tracked, status] = await Promise.all([includeTracked ? list(["ls-files", "-z"]) : Promise.resolve([]), list(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"])])
      const untracked: string[] = []
      const changed: string[] = []
      for (const entry of status) (entry.startsWith("?? ") ? untracked : changed).push(entry.slice(3))
      return { tracked, untracked, changed }
    },
    async ignored(paths) {
      if (!paths.length) return new Set()
      const result = await git.run({ cwd: root, args: ["check-ignore", "-z", "--stdin"], input: `${paths.join("\0")}\0`, codes: [1], read: true })
      return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean))
    },
    // `--directory` names a folder Git ignores whole once, without reading what's in it.
    ignoredEntries: () => list(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]),
    async read(commit, path) {
      const repository = await opened
      const found = repository ? await repository.objects.contents(`${commit}:${path}`) : null
      return found?.type === "blob" ? found.data : null
    },
    async changed(from, to) {
      if (!from) return list(["ls-tree", "-r", "-z", "--name-only", to])
      return list(["diff", "--name-only", "-z", "--no-renames", from, to, "--"])
    },
    watchHead: watchGitDir && ((moved: () => void) => watchGitDir(root, moved)),
  }
}
