import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
} from "node:fs"
import {
  copyFile,
  lstat,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
} from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import {
  RewindPlanSchema,
  WorkspaceSnapshotSchema,
  type RewindPlan,
  type RewindPreview,
  type WorkspaceSnapshot,
} from "./contracts/workspace-snapshots.js"

import {
  SnapshotRecordSchema as RecordSchema,
  SnapshotRetentionPolicySchema,
  pruneSnapshotRecords,
  retainedSnapshotBytes,
  type SnapshotRecord,
  type SnapshotRetentionPolicy,
} from "./workspace-snapshot-retention.js"

import {
  snapshotGit as git,
  privateSnapshotObjects,
  sealSnapshotObjects,
  snapshotPayloadBytes,
  importSnapshotObjects,
  reclaimSnapshotOrphans,
} from "./workspace-snapshot-git.js"
const OperationSchema = z.object({
  plan: RewindPlanSchema,
  backupId: z.string().uuid(),
  state: z.enum(["applying", "completed"]),
})
type RestoreOperation = z.infer<typeof OperationSchema>
const RowSchema = z.object({ value: z.string() })
interface ActiveRun {
  scope: string
  snapshotId?: string
  error?: string
}
const LockSchema = z.object({
  owner: z.literal("mako-snapshots"),
  pid: z.number().int(),
  token: z.string().uuid(),
})

/** Only remove our own abandoned locks. A Git/user lock is never guessed stale. */
function acquireLock(path: string): () => void {
  if (existsSync(path)) {
    const previous = parseLock(path)
    if (previous) {
      try {
        process.kill(previous.pid, 0)
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH")
          unlinkSync(path)
      }
    }
  }
  const value = {
    owner: "mako-snapshots",
    pid: process.pid,
    token: randomUUID(),
  }
  try {
    writeFileSync(path, JSON.stringify(value), { flag: "wx", mode: 0o600 })
  } catch (error) {
    throw new Error(
      "The workspace is busy. Finish the other Git or checkpoint operation and retry.",
      { cause: error }
    )
  }
  return () => {
    const current = parseLock(path)
    if (current && current.token === value.token) unlinkSync(path)
  }
}
function parseLock(path: string): z.infer<typeof LockSchema> | null {
  try {
    const result = LockSchema.safeParse(JSON.parse(readFileSync(path, "utf8")))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

/** Workspace-wide Git checkpoints, with a separate index and a durable restore intent.
 * Restoring never moves HEAD. A retry completes the same fork, or refuses any edits
 * made since the interrupted operation. Native provider history is never rolled back.
 */
/** Two checkpoints' trees in their workspace, and the object stores that hold them. */
export interface CheckpointTrees {
  scope: string
  from: string
  to: string
  stores: string[]
}

export class WorkspaceSnapshots {
  private readonly db: DatabaseSync
  private readonly busy = new Set<string>()
  private readonly runs = new Map<string, ActiveRun>()
  private readonly orphanBytes = new Map<string, number>()
  private readonly root: string
  private readonly retention: SnapshotRetentionPolicy
  constructor(root: string, retention: Partial<SnapshotRetentionPolicy> = {}) {
    this.retention = SnapshotRetentionPolicySchema.parse(retention)
    this.root = root
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(root, "snapshots.sqlite"))
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_scope_created
        ON snapshots (json_extract(value, '$.scope'), json_extract(value, '$.createdAt') DESC, id DESC);
      CREATE TABLE IF NOT EXISTS restores (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }

  close(): void {
    this.db.close()
  }

  pending(): RewindPlan[] {
    return this.db
      .prepare("SELECT value FROM restores")
      .all()
      .map((row) =>
        OperationSchema.parse(JSON.parse(RowSchema.parse(row).value))
      )
      .filter((operation) => operation.state === "applying")
      .map((operation) => operation.plan)
  }

  async assertAvailable(cwd: string): Promise<void> {
    const path = await realpath(cwd)
    const scopes = [
      ...this.busy,
      ...this.pending().map((plan) => this.get(plan.targetId).scope),
    ]
    if (
      scopes.some((scope) => {
        const child = relative(scope, path)
        return child === "" || (!child.startsWith("../") && child !== "..")
      })
    )
      throw new Error(
        "A workspace checkpoint or rewind is unfinished. Wait for it to finish before starting another turn."
      )
  }

  async beginRun(id: string, cwd: string): Promise<WorkspaceSnapshot> {
    const scope = await this.scope(cwd)
    const run: ActiveRun = { scope }
    for (const other of this.runs.values()) {
      if (other.scope !== scope) continue
      other.error =
        "Another agent used this workspace during the turn. A coordinated checkpoint is unavailable."
      run.error = other.error
    }
    this.runs.set(id, run)
    try {
      if (run.error) throw new Error(run.error)
      const snapshot = await this.capture(scope)
      run.snapshotId = snapshot.id
      return snapshot
    } catch (error) {
      run.error = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async endRun(id: string): Promise<WorkspaceSnapshot> {
    const run = this.runs.get(id)
    if (!run)
      throw new Error("No workspace checkpoint was captured before this turn")
    try {
      if (run.error) throw new Error(run.error)
      return await this.capture(run.scope)
    } finally {
      this.runs.delete(id)
    }
  }

  abandonRun(id: string): void {
    this.runs.delete(id)
  }

  private assertIdle(scope: string): void {
    if ([...this.runs.values()].some((run) => run.scope === scope))
      throw new Error(
        "Wait for every agent using this workspace to finish before rewinding"
      )
  }

  async capture(cwd: string): Promise<WorkspaceSnapshot> {
    const scope = await this.scope(cwd)
    return this.locked(scope, async (gitDir) => {
      this.assertNoPending(scope)
      const record = await this.captureLocked(scope, gitDir)
      await this.maintainLocked(record)
      return this.summary(record)
    })
  }

  async prune(cwd: string): Promise<number> {
    const scope = await this.scope(cwd)
    return this.locked(scope, (gitDir) => this.pruneLocked(scope, gitDir))
  }

  private async maintainLocked(record: SnapshotRecord): Promise<void> {
    try {
      await this.pruneLocked(record.scope, record.gitDir, record.id)
    } catch (error) {
      console.warn("Workspace checkpoint retention deferred:", error)
    }
  }

  private pruneLocked(
    scope: string,
    gitDir: string,
    currentId?: string,
    additionalBytes = 0
  ): Promise<number> {
    const protectedIds = new Set(currentId ? [currentId] : [])
    for (const run of this.runs.values()) {
      if (run.snapshotId) protectedIds.add(run.snapshotId)
    }
    for (const row of this.db.prepare("SELECT value FROM restores").iterate()) {
      const operation = OperationSchema.parse(
        JSON.parse(RowSchema.parse(row).value)
      )
      if (operation.state !== "applying") continue
      protectedIds.add(operation.plan.targetId)
      protectedIds.add(operation.plan.expectedId)
      protectedIds.add(operation.backupId)
    }
    return pruneSnapshotRecords({
      db: this.db,
      root: this.root,
      scope,
      gitDir,
      protectedIds,
      policy: this.retention,
      additionalBytes: additionalBytes + (this.orphanBytes.get(scope) ?? 0),
      removeRefs: async (expired) => {
        const records = expired.filter((record) => !record.storage)
        if (!records.length) return
        const output = await git(scope, [
          "for-each-ref",
          "--format=%(refname)%00%(objectname)%00%(tree)%00%(symref)%00%(contents)%00",
          ...records.map((record) => `refs/mako/checkpoints/${record.id}`),
        ])
        const refs = new Map(
          output
            .split("\0\n")
            .filter(Boolean)
            .map((entry) => {
              const [ref, ...fields] = entry.split("\0")
              return [ref, fields]
            })
        )
        const commands: string[] = []
        for (const record of records) {
          const ref = `refs/mako/checkpoints/${record.id}`
          const fields = refs.get(ref)
          if (!fields) continue
          const [commit, tree, symref, message] = fields
          if (
            fields.length !== 4 ||
            symref ||
            tree !== record.tree ||
            message.trim() !== `Mako checkpoint ${record.id}` ||
            (record.commit && record.commit !== commit)
          )
            throw new Error("The checkpoint ref changed. Cleanup was refused.")
          commands.push(`delete ${ref} ${commit}`)
        }
        if (commands.length)
          await git(
            scope,
            ["update-ref", "--no-deref", "--stdin"],
            undefined,
            ["start", ...commands, "prepare", "commit", ""].join("\n")
          )
      },
    })
  }

  async preview(targetId: string): Promise<RewindPreview> {
    const target = this.get(targetId)
    this.assertIdle(target.scope)
    return this.locked(target.scope, async (gitDir) => {
      this.assertNoPending(target.scope)
      await this.validateRepository(target)
      this.retain(target)
      const current = await this.captureLocked(target.scope, gitDir)
      const paths = await this.changedPaths(current, target)
      this.retain(current)
      await this.maintainLocked(current)
      return {
        target: this.summary(target),
        current: this.summary(current),
        changedFiles: paths.slice(0, 100),
        changedFileCount: paths.length,
        stagingChanged: target.indexDigest !== current.indexDigest,
      }
    })
  }

  /**
   * Two checkpoints of one workspace, to compare: their trees and the object
   * stores that hold them. Both are kept past the next prune while read.
   */
  trees(fromId: string, toId: string): CheckpointTrees {
    const from = this.get(fromId)
    const to = this.get(toId)
    if (from.scope !== to.scope) throw new Error("These checkpoints belong to different workspaces")
    this.retain(from)
    this.retain(to)
    return { scope: from.scope, from: from.tree, to: to.tree, stores: this.objects(from, to).read }
  }

  async restore(input: RewindPlan, complete: () => void): Promise<void> {
    const plan = RewindPlanSchema.parse(input)
    if (this.operation(plan)?.state === "completed") {
      complete()
      return
    }
    const target = this.get(plan.targetId)
    this.assertIdle(target.scope)
    await this.locked(target.scope, async (gitDir) => {
      let operation = this.operation(plan)
      if (operation?.state === "completed") {
        complete()
        return
      }
      this.assertNoPending(target.scope, plan.fork.id)
      await this.validateRepository(target)
      this.retain(target)
      this.retain(this.get(plan.expectedId))
      await this.withCurrentState(target.scope, gitDir, async (current) => {
        if (!operation) {
          const expected = this.get(plan.expectedId)
          if (!this.sameState(current, expected))
            throw new Error(
              "The workspace changed after the preview. Review a new preview before rewinding."
            )
          operation = { plan, backupId: expected.id, state: "applying" }
          this.saveOperation(operation)
        }
        const backup = this.get(operation.backupId)
        await this.assertRecoverable(current, backup, target)
        // The intent is durable before the first file changes. If the process dies,
        // recovery validates each path against the two recorded states before proceeding.
        try {
          await this.restoreFiles(current, target)
          complete()
        } catch (error) {
          try {
            await this.withCurrentState(
              target.scope,
              gitDir,
              async (partial) => {
                await this.assertRecoverable(partial, backup, target)
                await this.restoreFiles(partial, backup)
              }
            )
            this.db.prepare("DELETE FROM restores WHERE id=?").run(plan.fork.id)
          } catch (recoveryError) {
            throw new AggregateError(
              [error, recoveryError],
              "Rewind failed and recovery is still required. The saved workspace backup has been retained.",
              { cause: recoveryError }
            )
          }
          throw error
        }
        // A journal commit followed by a receipt-write failure remains pending;
        // recovery repeats the idempotent completion, never undoes a committed fork.
        this.saveOperation({ ...operation, state: "completed" })
        await this.maintainLocked(target)
      })
    })
  }

  private operation(plan: RewindPlan): RestoreOperation | null {
    const row = this.db
      .prepare("SELECT value FROM restores WHERE id=?")
      .get(plan.fork.id)
    if (!row) return null
    const operation = OperationSchema.parse(
      JSON.parse(RowSchema.parse(row).value)
    )
    if (JSON.stringify(operation.plan) !== JSON.stringify(plan))
      throw new Error("This rewind ID belongs to another operation")
    return operation
  }

  private saveOperation(operation: RestoreOperation): void {
    this.db
      .prepare("INSERT OR REPLACE INTO restores VALUES (?, ?)")
      .run(operation.plan.fork.id, JSON.stringify(operation))
  }
  private assertNoPending(scope: string, except?: string): void {
    if (
      this.pending().some(
        (plan) =>
          plan.fork.id !== except && this.get(plan.targetId).scope === scope
      )
    )
      throw new Error(
        "This workspace has an unfinished rewind. Recover it before continuing."
      )
  }
  private get(id: string): SnapshotRecord {
    z.string().uuid().parse(id)
    const row = this.db
      .prepare("SELECT value FROM snapshots WHERE id=?")
      .get(id)
    if (!row)
      throw new Error("This workspace checkpoint is no longer available")
    return RecordSchema.parse(JSON.parse(RowSchema.parse(row).value))
  }
  private summary(record: SnapshotRecord): WorkspaceSnapshot {
    return WorkspaceSnapshotSchema.parse(record)
  }
  private retain(record: SnapshotRecord): void {
    this.db.prepare("UPDATE snapshots SET value=? WHERE id=?").run(
      JSON.stringify({
        ...record,
        retainUntil: Math.max(
          record.retainUntil ?? 0,
          Date.now() + this.retention.previewTtlMs
        ),
      }),
      record.id
    )
  }
  private objects(...records: SnapshotRecord[]) {
    return {
      read: records
        .filter((record) => record.storage)
        .map((record) => join(this.root, record.id, "git/objects")),
    }
  }
  private async scope(cwd: string): Promise<string> {
    try {
      return await realpath(
        (await git(cwd, ["rev-parse", "--show-toplevel"])).trim()
      )
    } catch (error) {
      throw new Error(
        "Workspace checkpoints currently require a Git repository.",
        { cause: error }
      )
    }
  }
  private async locked<T>(
    scope: string,
    work: (gitDir: string) => Promise<T>
  ): Promise<T> {
    if (this.busy.has(scope))
      throw new Error("Another checkpoint operation is using this workspace")
    this.busy.add(scope)
    const releases: (() => void)[] = []
    try {
      const gitDir = (
        await git(scope, ["rev-parse", "--absolute-git-dir"])
      ).trim()
      releases.push(acquireLock(join(gitDir, "mako-snapshots.lock")))
      releases.push(acquireLock(join(gitDir, "index.lock")))
      if (!this.orphanBytes.has(scope)) {
        const known = new Set<string>()
        for (const row of this.db
          .prepare(
            "SELECT id FROM snapshots WHERE json_extract(value, '$.scope')=?"
          )
          .iterate(scope))
          known.add(z.string().uuid().parse(row.id))
        this.orphanBytes.set(
          scope,
          await reclaimSnapshotOrphans(this.root, scope, known)
        )
      }
      return await work(gitDir)
    } finally {
      for (const release of releases.reverse()) release()
      this.busy.delete(scope)
    }
  }
  private async head(scope: string): Promise<string> {
    const branch = (
      await git(scope, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")
    ).trim()
    const revision = (
      await git(scope, ["rev-parse", "--verify", "HEAD"]).catch(() => "unborn")
    ).trim()
    return `${branch}:${revision}`
  }
  private async validateRepository(record: SnapshotRecord): Promise<void> {
    if (
      (await this.scope(record.scope)) !== record.scope ||
      (await git(record.scope, ["rev-parse", "--absolute-git-dir"])).trim() !==
        record.gitDir ||
      (await this.head(record.scope)) !== record.head
    )
      throw new Error(
        "The Git branch or HEAD changed since this checkpoint. Rewinding files across that change is not supported."
      )
    await git(
      record.scope,
      ["cat-file", "-e", `${record.tree}^{tree}`],
      undefined,
      undefined,
      this.objects(record)
    )
    if (record.indexDigest !== "absent") {
      const bytes = await readFile(join(this.root, record.id, "index"))
      if (
        createHash("sha256").update(bytes).digest("hex") !== record.indexDigest
      )
        throw new Error(
          "The saved staging checkpoint is damaged. No files were restored."
        )
      const entries = await git(
        record.scope,
        ["ls-files", "--stage", "-z"],
        join(this.root, record.id, "index")
      )
      const objects = entries
        .split("\0")
        .filter(Boolean)
        .map((entry) => {
          const match = /^\d+ ([a-f0-9]{40,64}) 0\t/.exec(entry)
          if (!match)
            throw new Error("The saved staging checkpoint is damaged.")
          return match[1]
        })
      if (objects.length) {
        const available = await git(
          record.scope,
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          undefined,
          `${objects.join("\n")}\n`,
          this.objects(record)
        )
        if (
          available !==
          `${objects.map((object) => `${object} blob`).join("\n")}\n`
        )
          throw new Error(
            "The saved staging checkpoint has missing Git objects. No files were restored."
          )
      }
    }
  }
  private sameState(left: SnapshotRecord, right: SnapshotRecord): boolean {
    return (
      left.scope === right.scope &&
      left.gitDir === right.gitDir &&
      left.head === right.head &&
      left.tree === right.tree &&
      left.indexDigest === right.indexDigest
    )
  }
  private async withCurrentState<T>(
    scope: string,
    gitDir: string,
    work: (current: SnapshotRecord) => Promise<T>
  ): Promise<T> {
    const current = await this.captureLocked(scope, gitDir, "temporary")
    try {
      return await work(current)
    } finally {
      await rm(join(this.root, current.id), { recursive: true, force: true })
    }
  }
  private async captureLocked(
    scope: string,
    gitDir: string,
    lifetime: "retained" | "temporary" = "retained"
  ): Promise<SnapshotRecord> {
    const sparse = (
      await git(scope, ["config", "--bool", "core.sparseCheckout"]).catch(
        () => "false"
      )
    ).trim()
    if (sparse === "true")
      throw new Error(
        "Workspace checkpoints do not support sparse checkouts yet"
      )
    const flags = await git(scope, ["ls-files", "-v", "-z"])
    if (flags.split("\0").some((entry) => /^[a-zS] /.test(entry)))
      throw new Error(
        "Clear assume-unchanged and skip-worktree flags before using workspace checkpoints"
      )
    const tracked = await git(scope, ["ls-files", "--stage", "-z"])
    if (
      tracked
        .split("\0")
        .some(
          (line) =>
            line.startsWith("160000 ") || /^\d+ [a-f0-9]+ [123]\t/.test(line)
        )
    )
      throw new Error(
        "Resolve index conflicts or remove submodules from this workspace before using checkpoints"
      )
    const paths = [
      ...new Set(
        (
          await git(scope, [
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean)
      ),
    ]
    if (paths.length > 20_000)
      throw new Error("Workspace checkpoint exceeds the 20,000-file limit")
    let bytes = 0
    for (let offset = 0; offset < paths.length; offset += 64) {
      const sizes = await Promise.all(
        paths.slice(offset, offset + 64).map(async (path) => {
          try {
            return (await lstat(join(scope, path))).size
          } catch (error) {
            if (
              error instanceof Error &&
              "code" in error &&
              (error.code === "ENOENT" || error.code === "ENOTDIR")
            )
              return 0
            throw error
          }
        })
      )
      bytes += sizes.reduce((sum, size) => sum + size, 0)
      if (bytes > 256 * 1024 * 1024)
        throw new Error("Workspace checkpoint exceeds the 256 MB file limit")
    }
    const id = randomUUID()
    const directory = join(this.root, id)
    mkdirSync(directory, { mode: 0o700 })
    writeFileSync(
      join(directory, "capture-owner.json"),
      JSON.stringify({
        owner: "mako-checkpoint",
        scope,
        pid: process.pid,
        state: "preparing",
      }),
      { mode: 0o600, flag: "wx" }
    )
    const index = join(directory, "index")
    const workingIndex = join(directory, "working-index")
    const userIndex = join(gitDir, "index")
    const hasIndex = existsSync(userIndex)
    const head = await this.head(scope)
    let record: SnapshotRecord
    try {
      if (
        bytes > this.retention.maxSnapshotBytes ||
        (hasIndex &&
          (await lstat(userIndex)).size >
            Math.min(16 * 1024 ** 2, this.retention.maxSnapshotBytes))
      )
        throw new Error(
          "The checkpoint exceeds its object storage limit. No workspace files were changed."
        )
      const objects = await privateSnapshotObjects(scope, directory)
      const captureGit = (args: string[], index?: string) =>
        git(scope, args, index, undefined, objects)
      if (hasIndex) {
        await copyFile(userIndex, index)
        // Expand split indexes so retained snapshots do not depend on sharedindex GC.
        await captureGit(["update-index", "--no-split-index"], index)
      } else {
        await captureGit(["read-tree", "--empty"], workingIndex)
      }
      // The live index can move on immediately. Keep its saved tree reachable
      // from our checkpoint ref so Git GC cannot discard staged-only blobs.
      const stagedTree = hasIndex
        ? (await captureGit(["write-tree"], index)).trim()
        : undefined
      if (hasIndex) await copyFile(index, workingIndex)
      const indexDigest = hasIndex
        ? createHash("sha256")
            .update(await readFile(index))
            .digest("hex")
        : "absent"
      await captureGit(["add", "-A", "--", "."], workingIndex)
      const stagedEntries = await captureGit(
        ["ls-files", "--stage", "-z"],
        workingIndex
      )
      if (
        stagedEntries.split("\0").some((entry) => entry.startsWith("160000 "))
      )
        throw new Error(
          "Workspace checkpoints cannot include embedded Git repositories"
        )
      const tree = (await captureGit(["write-tree"], workingIndex)).trim()
      if ((await this.head(scope)) !== head)
        throw new Error("Git HEAD changed while capturing the workspace")
      const parents = stagedTree
        ? [
            "-p",
            (
              await captureGit([
                "commit-tree",
                stagedTree,
                "-m",
                `Mako staging checkpoint ${id}`,
              ])
            ).trim(),
          ]
        : []
      const commit = (
        await captureGit([
          "commit-tree",
          tree,
          ...parents,
          "-m",
          `Mako checkpoint ${id}`,
        ])
      ).trim()
      await captureGit([
        `--git-dir=${join(directory, "git")}`,
        "update-ref",
        `refs/mako/checkpoints/${id}`,
        commit,
      ])
      await sealSnapshotObjects(
        scope,
        directory,
        commit,
        objects,
        this.retention.maxSnapshotBytes
      )
      await rm(workingIndex, { force: true })
      const payloadBytes = await snapshotPayloadBytes(directory)
      if (payloadBytes > this.retention.maxSnapshotBytes)
        throw new Error(
          "The checkpoint exceeds its object storage limit. No workspace files were changed."
        )
      record = {
        id,
        scope,
        createdAt: Date.now(),
        files: paths.length,
        gitDir,
        head,
        tree,
        commit,
        storage: { kind: "private", bytes: payloadBytes },
        indexDigest,
      }
      if (lifetime === "temporary") return record
      await this.pruneLocked(scope, gitDir, undefined, payloadBytes)
      if (
        (await retainedSnapshotBytes(this.db, this.root, scope)) +
          (this.orphanBytes.get(scope) ?? 0) +
          payloadBytes >
        this.retention.maxStorageBytes
      )
        throw new Error(
          "Checkpoint storage is full. Active turns and recovery checkpoints were retained; no workspace files were changed."
        )
      this.db
        .prepare("INSERT INTO snapshots VALUES (?, ?)")
        .run(id, JSON.stringify(record))
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
    writeFileSync(
      join(directory, "capture-owner.json"),
      JSON.stringify({
        owner: "mako-checkpoint",
        scope,
        pid: process.pid,
        state: "committed",
      })
    )
    return record
  }
  private async changedPaths(
    from: SnapshotRecord,
    to: SnapshotRecord
  ): Promise<string[]> {
    return (
      await git(
        from.scope,
        [
          "diff-tree",
          "--no-commit-id",
          "--name-only",
          "-r",
          "-z",
          from.tree,
          to.tree,
        ],
        undefined,
        undefined,
        this.objects(from, to)
      )
    )
      .split("\0")
      .filter(Boolean)
  }
  private async treeFiles(
    record: SnapshotRecord
  ): Promise<Map<string, string>> {
    const lines = (
      await git(
        record.scope,
        ["ls-tree", "-rz", record.tree],
        undefined,
        undefined,
        this.objects(record)
      )
    )
      .split("\0")
      .filter(Boolean)
    return new Map(
      lines.map((line) => {
        const separator = line.indexOf("\t")
        return [line.slice(separator + 1), line.slice(0, separator)]
      })
    )
  }
  private async assertRecoverable(
    current: SnapshotRecord,
    backup: SnapshotRecord,
    target: SnapshotRecord
  ): Promise<void> {
    if (
      current.head !== target.head ||
      current.scope !== target.scope ||
      current.gitDir !== target.gitDir
    )
      throw new Error("The workspace identity changed during rewind")
    if (
      current.indexDigest !== backup.indexDigest &&
      current.indexDigest !== target.indexDigest
    )
      throw new Error(
        "Staged changes were modified after rewind began. Recovery has stopped to preserve them."
      )
    const [now, before, after] = await Promise.all(
      [current, backup, target].map((record) => this.treeFiles(record))
    )
    const paths = new Set([...now.keys(), ...before.keys(), ...after.keys()])
    for (const path of paths)
      if (
        now.get(path) !== before.get(path) &&
        now.get(path) !== after.get(path)
      )
        throw new Error(
          `File changed after rewind began: ${path}. Recovery has stopped to preserve it.`
        )
  }
  private async ownedDirectory(
    scope: string,
    path: string,
    files: Map<string, string>
  ): Promise<boolean> {
    const info = await lstat(join(scope, path))
    if (!info.isDirectory()) return false
    const pending = [path]
    let seen = 0
    while (pending.length) {
      const directory = pending.pop()
      if (directory === undefined) break
      for (const entry of await readdir(join(scope, directory), {
        withFileTypes: true,
      })) {
        if (++seen > 20_000) return false
        const child = `${directory}/${entry.name}`
        if (entry.isDirectory()) pending.push(child)
        else if (!files.has(child)) return false
      }
    }
    return true
  }

  private async restoreFiles(
    current: SnapshotRecord,
    target: SnapshotRecord
  ): Promise<void> {
    await this.validateRepository(target)
    const currentFiles = await this.treeFiles(current)
    const targetFiles = await this.treeFiles(target)
    // read-tree --reset may overwrite ignored files. Refuse such collisions before
    // it runs, and never traverse a directory replaced with an outside symlink.
    for (const path of await this.changedPaths(current, target)) {
      let parent = dirname(join(target.scope, path))
      while (parent !== target.scope) {
        const stat = await lstat(parent).catch(() => null)
        if (stat?.isSymbolicLink())
          throw new Error(
            `Cannot rewind through a symbolic-link directory: ${path}`
          )
        parent = dirname(parent)
      }
      if (
        targetFiles.has(path) &&
        !currentFiles.has(path) &&
        existsSync(join(target.scope, path)) &&
        !(await this.ownedDirectory(target.scope, path, currentFiles))
      )
        throw new Error(
          `Rewind would overwrite an ignored or unrecorded path: ${path}`
        )
    }
    const temporary = await mkdtemp(join(this.root, "restore-"))
    try {
      const index = join(temporary, "index")
      if (target.storage)
        await importSnapshotObjects(target.scope, join(this.root, target.id))
      await git(
        target.scope,
        ["read-tree", current.tree],
        index,
        undefined,
        this.objects(current, target)
      )
      await git(
        target.scope,
        ["read-tree", "--reset", "-u", target.tree],
        index,
        undefined,
        this.objects(current, target)
      )
      const destination = join(target.gitDir, "index")
      if (target.indexDigest !== "absent") {
        // The actual index.lock is held by locked(). Rename on the same filesystem.
        const staged = join(target.gitDir, `mako-index-${randomUUID()}`)
        try {
          await copyFile(join(this.root, target.id, "index"), staged)
          const { rename } = await import("node:fs/promises")
          await rename(staged, destination)
        } finally {
          await rm(staged, { force: true })
        }
      } else await rm(destination, { force: true })
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
}
