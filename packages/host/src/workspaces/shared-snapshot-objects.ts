import { constants } from "node:fs"
import { chmod, copyFile, link, mkdir, open, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { join } from "node:path"
import { devNull } from "node:os"
import { z } from "zod"
import type { Git } from "@mako/git"
import { withFileLock } from "../base/file-lock.js"
import { onWindows } from "../base/platform.js"
import { snapshotGit, snapshotPayloadBytes, type SnapshotObjects } from "./snapshot-git.js"

const ObjectFormatSchema = z.enum(["sha1", "sha256"])
const OwnerSchema = z.object({
  source: z.string(),
  format: ObjectFormatSchema,
  device: z.string(),
  inode: z.string(),
})
const OwnerIdSchema = z.string().regex(/^[a-f0-9]{64}$/)
type Owner = z.infer<typeof OwnerSchema>
export interface SharedObjectCapture {
  owner: string
  objects: SnapshotObjects & { write: string }
}

/**
 * User objects are read-only capture inputs. A capture writes its own quarantine; the owner lock protects importing
 * its missing graph and publishing a private root. No alternate survives publication: connectivity is checked with
 * only Mako-owned objects. GC will use the same lock; until owner retention lands, roots are conservatively kept.
 */
export class SharedSnapshotObjects {
  private readonly git: Git
  private readonly root: string
  private readonly limit: number

  constructor(git: Git, root: string, limit: number) {
    this.git = git
    this.root = root
    this.limit = limit
  }

  directory(owner: string): string {
    return join(this.root, "repositories", OwnerIdSchema.parse(owner), "git")
  }

  objects(owner: string): string {
    return join(this.directory(owner), "objects")
  }

  private locked<T>(owner: string, work: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.directory(owner), "..", "owner.lock.sqlite"), work)
  }

  private run(cwd: string, args: string[], input?: string, objects?: SnapshotObjects): Promise<string> {
    return snapshotGit(this.git, cwd, ["-c", `core.hooksPath=${devNull}`, "-c", "core.fsync=objects,pack-metadata,reference", "-c", "core.fsyncMethod=fsync", "-c", "pack.writeReverseIndex=false", ...args], undefined, input, { ...objects, noLazyFetch: true })
  }

  async capture(cwd: string, directory: string): Promise<SharedObjectCapture> {
    const source = await realpath((await this.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])).trim())
    const format = ObjectFormatSchema.parse((await this.run(cwd, ["rev-parse", "--show-object-format"])).trim())
    const info = await stat(source, { bigint: true })
    const identity: Owner = { source, format, device: String(info.dev), inode: String(info.ino) }
    const owner = createHash("sha256").update(JSON.stringify(identity)).digest("hex")
    const marker = join(this.directory(owner), "..", "owner.json")
    const initialized = async () => {
      const saved = await readFile(marker, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      if (saved !== undefined) {
        if (JSON.stringify(OwnerSchema.parse(JSON.parse(saved))) !== JSON.stringify(identity))
          throw new Error("The checkpoint object store's repository ownership changed")
        return true
      }
      return false
    }
    // Existing, atomically initialized owners are read-only here. New inputs must not queue behind a prior seal.
    // Cold peers may already be waiting when identity is published. Their initialization lock is independent of a
    // first capture's now-possible import, so even those peers cannot be held behind its packing.
    if (!await initialized()) await withFileLock(join(this.directory(owner), "..", "initialize.lock.sqlite"), async () => {
      if (await initialized()) return
      await this.run(cwd, ["init", "--bare", "--quiet", "--template=", `--object-format=${format}`, this.directory(owner)])
      const prepared = `${marker}.${randomUUID()}.tmp`
      try {
        await writeFile(prepared, JSON.stringify(identity), { mode: 0o600, flag: "wx" })
        await rename(prepared, marker)
      } finally { await rm(prepared, { force: true }) }
    })
    const objects = join(directory, "objects")
    await mkdir(join(objects, "pack"), { recursive: true, mode: 0o700 })
    await mkdir(join(objects, "info"), { mode: 0o700 })
    await writeFile(join(directory, "object-owner.json"), JSON.stringify({ owner }), { mode: 0o600 })
    return { owner, objects: { write: objects, read: [this.objects(owner), source], noLazyFetch: true } }
  }

  /** The caller may publish ready only after this owns the entire working/staged graph and its private root. */
  async seal(cwd: string, directory: string, capture: SharedObjectCapture, id: string, commit: string, importLimit: number): Promise<void> {
    await this.locked(capture.owner, async () => {
      const gitDir = this.directory(capture.owner)
      // Presence in the private store, not reachability from an older commit, proves ownership. In particular, a
      // disconnected checkpoint commit can share an unchanged tree without revision exclusion removing its blobs.
      const reachable = await this.run(cwd, ["rev-list", "--objects", "--no-object-names", commit], undefined, capture.objects)
      const ids = reachable.trim().split("\n")
      const present = (await this.run(cwd, [`--git-dir=${gitDir}`, "cat-file", "--batch-check=%(objectname)"], reachable)).trim().split("\n")
      if (present.length !== ids.length) throw new Error("The checkpoint ownership check was incomplete")
      const missing = ids.filter((oid, at) => {
        if (present[at] === `${oid} missing`) return true
        if (present[at] !== oid) throw new Error("The checkpoint ownership check was invalid")
        return false
      })
      if (!missing.length) {
        await this.verify(cwd, capture.owner, commit)
        await this.publish(cwd, capture.owner, id, commit)
        return
      }
      const input = `${missing.join("\n")}\n`
      const sizes = await this.run(cwd, ["cat-file", "--batch-check=%(objectsize)"], input, capture.objects)
      let bytes = 0
      for (const line of sizes.trim().split("\n")) {
        if (!/^\d+$/.test(line)) throw new Error("A checkpoint dependency is unavailable")
        bytes += Number(line)
        if (bytes > importLimit) throw new Error("The checkpoint import exceeds its object storage limit")
      }
      const prefix = join(directory, "owned")
      const hash = (await this.run(cwd, ["pack-objects", "--window=0", "--no-reuse-delta", "--compression=3", prefix], input, capture.objects)).trim()
      if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("The checkpoint pack could not be created")
      const pack = `${prefix}-${hash}.pack`
      const index = `${prefix}-${hash}.idx`
      try {
        // A conservative physical cap while the separate owner-retention/accounting change is developed.
        const existing = await snapshotPayloadBytes(join(gitDir, ".."))
        const incoming = (await stat(pack)).size + (await stat(index)).size
        if (existing + incoming + 1024 > this.limit) throw new Error("Checkpoint object storage is full")
        await this.install(cwd, gitDir, join(gitDir, "objects"), pack, hash)
        await this.verify(cwd, capture.owner, commit)
        await this.publish(cwd, capture.owner, id, commit)
      } finally {
        await rm(pack, { force: true })
        await rm(index, { force: true })
      }
    })
    await rm(capture.objects.write, { recursive: true, force: true })
  }

  private async install(cwd: string, gitDir: string, objects: string, pack: string, hash: string): Promise<void> {
    // Pack bytes stay on disk: the Git helper's stdin is not a backpressure boundary for a large import.
    const installed = join(objects, "pack", `pack-${hash}.pack`)
    try {
      await link(pack, installed)
    } catch (error) {
      const code = error instanceof Error && "code" in error ? error.code : undefined
      if (code === "EXDEV" || code === "EPERM") {
        const pending = `${installed}.${randomUUID()}.tmp`
        try {
          await copyFile(pack, pending, constants.COPYFILE_EXCL)
          await chmod(pending, 0o600)
          const copied = await open(pending, "r+")
          try { await copied.sync() } finally { await copied.close() }
          await rename(pending, installed)
        } finally { await rm(pending, { force: true }) }
      } else if (code !== "EEXIST") throw error
    }
    const indexed = (await this.run(cwd, [`--git-dir=${gitDir}`, "index-pack", "--strict", installed])).trim()
    if (indexed !== hash) throw new Error("The checkpoint pack's ownership changed")
    if (!onWindows()) {
      const directory = await open(join(objects, "pack"), "r")
      try { await directory.sync() } finally { await directory.close() }
    }
  }

  async verify(cwd: string, owner: string, commit: string): Promise<void> {
    // An independent bare repository, without the user's config, alternates, promisor or object directory.
    await this.run(cwd, [`--git-dir=${this.directory(owner)}`, "rev-list", "--objects", "--quiet", commit])
  }

  private async publish(cwd: string, owner: string, id: string, commit: string): Promise<void> {
    const gitDir = this.directory(owner), ref = `refs/mako/checkpoints/${z.string().uuid().parse(id)}`
    const previous = (await this.run(cwd, [`--git-dir=${gitDir}`, "for-each-ref", "--format=%(objectname)%00%(symref)", ref])).trim()
    if (previous) {
      if (previous !== `${commit}\0`) throw new Error("The checkpoint object root changed; publication was refused")
      return
    }
    await this.run(cwd, [`--git-dir=${gitDir}`, "update-ref", "--no-deref", ref, commit, "0".repeat(commit.length)])
  }

  /** Only the restored staging graph must become readable by the user's index; working-only objects stay private. */
  async importStaging(cwd: string, owner: string, commit: string, directory: string): Promise<() => Promise<void>> {
    const objects = await realpath((await this.run(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])).trim())
    let announce!: () => void, fail!: (error: Error) => void, release!: () => void
    const ready = new Promise<void>((resolve, reject) => { announce = resolve; fail = reject })
    const released = new Promise<void>((resolve) => { release = resolve })
    // Different worktrees and Mako profiles can import the same staging pack. Keep its lease through index
    // publication under one primary-object lock, rather than dropping a keep file another restore still needs.
    const finished = withFileLock(join(objects, "info", "mako-staging.lock.sqlite"), async () => {
      const cleanup = await this.importStagingLocked(cwd, owner, commit, directory, objects)
      try { announce(); await released }
      finally { await cleanup() }
    })
    void finished.catch((cause) => fail(cause instanceof Error ? cause : new Error("The staging import failed", { cause })))
    await ready
    return async () => { release(); await finished }
  }

  private async importStagingLocked(cwd: string, owner: string, commit: string, directory: string, objects: string): Promise<() => Promise<void>> {
    const gitDir = this.directory(owner)
    const staged = (await this.run(cwd, [`--git-dir=${gitDir}`, "rev-parse", `${commit}^1^{tree}`])).trim()
    const prefix = join(directory, "staging")
    const hash = (await this.run(cwd, [`--git-dir=${gitDir}`, "pack-objects", "--revs", "--window=0", "--no-reuse-delta", prefix], `${staged}\n`)).trim()
    if (!/^[a-f0-9]{40,64}$/.test(hash)) throw new Error("The staged checkpoint pack could not be created")
    const destination = (await this.run(cwd, ["rev-parse", "--absolute-git-dir"])).trim()
    const keep = join(objects, "pack", `pack-${hash}.keep`)
    const marker = `Mako staging import ${randomUUID()}\n`
    let held = false
    const release = async () => {
      if (!held) return
      held = false
      const contents = await readFile(keep, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined
        throw error
      })
      // A pre-existing or replaced keep file belongs to its writer, never this restore.
      if (contents === marker) await rm(keep, { force: true })
    }
    try {
      try { await writeFile(keep, marker, { mode: 0o600, flag: "wx" }); held = true }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error }
      await this.install(cwd, destination, objects, `${prefix}-${hash}.pack`, hash)
      await this.run(cwd, ["rev-list", "--objects", "--quiet", staged])
      return release
    } catch (error) {
      await release()
      throw error
    }
  }
}
