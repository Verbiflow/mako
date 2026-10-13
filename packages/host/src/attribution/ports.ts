import type { Git } from "@mako/git"
import { createReadStream, readdirSync, realpathSync } from "node:fs"
import { lstat, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
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
export type TreeWatcher = (root: string, changed: (paths: string[]) => void, gone: () => void, dropped: () => void) => { readonly ready: Promise<void>; close(): void } | undefined

/** The system's history, as the host's watcher child reads it (FSEvents, macOS only). */
export interface SystemHistory {
  mark(): Promise<{ id: string; at: string }>
  since(mark: { id: string; at: string }, roots: readonly string[], options?: { ignore?: readonly string[] }): Promise<{ paths: string[]; lost: string[]; ignored: number[] }>
}

const Mark = z.string().regex(/^\d+:\d+$/)

/** The host's watcher and history as the tracker's event source. */
export function watcherEvents(watch: TreeWatcher, history: SystemHistory | undefined): TrackerEventSource {
  return {
    async watch(root, listener: TrackerChangeListener) {
      const watching = watch(root, (paths) => listener.changed(paths), () => listener.lost("gone"), () => listener.lost("dropped"))
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
        const found = await history.since({ id, at }, [root], options)
        return { paths: found.paths, complete: found.lost.length === 0, ignored: found.ignored }
      } catch {
        return null
      }
    },
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
    const result = await git.run({ cwd: root, args: ["rev-parse", "--verify", "-q", "HEAD"], codes: [1], read: true })
    return result.code === 0 ? result.stdout.toString("utf8").trim() : null
  }
  return {
    head,
    async inventory() {
      const commit = await head()
      const [tracked, untracked] = await Promise.all([list(["ls-files", "-z"]), list(["ls-files", "-z", "--others", "--exclude-standard"])])
      // Before the first commit there's no base: everything there is new.
      if (!commit) return { tracked: [], untracked: [...tracked, ...untracked], changed: [] }
      const changed = await list(["diff", "--name-only", "-z", "--no-renames", "HEAD", "--"])
      return { tracked, untracked, changed }
    },
    async ignored(paths) {
      if (!paths.length) return new Set()
      const result = await git.run({ cwd: root, args: ["check-ignore", "-z", "--stdin"], input: `${paths.join("\0")}\0`, codes: [1], read: true })
      return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean))
    },
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
