import { createHash, randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
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
import { dirname, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { TreeComparison, type Git } from "@mako/git"
import { projectRepositories } from "../git/index.js"
import {
  RewindPlanSchema,
  WorkspaceSnapshotSchema,
  type RewindPlan,
  type RewindPreview,
  type WorkspaceSnapshot,
} from "../contracts/workspace-snapshots.js"

import {
  SnapshotRecordSchema as RecordSchema,
  SnapshotRetentionPolicySchema,
  pruneSnapshotRecords,
  retainedSnapshotBytes,
  type SnapshotRecord,
  type SnapshotRetentionPolicy,
} from "./snapshot-retention.js"

import {
  snapshotGit,
  privateSnapshotObjects,
  sealSnapshotObjects,
  snapshotPayloadBytes,
  importSnapshotObjects,
  reclaimSnapshotOrphans,
  type SnapshotObjects,
} from "./snapshot-git.js"
import { copyGitIndex } from "./index-copy.js"
const OperationSchema = z.object({
  plan: RewindPlanSchema,
  backupId: z.string().uuid(),
  state: z.enum(["applying", "completed"]),
})
type RestoreOperation = z.infer<typeof OperationSchema>
const RowSchema = z.object({ value: z.string() })
/** Files a checkpoint takes at most: Git reads again only the ones whose stat changed, so this is the listing's cost, not hashing's. */
const MAX_FILES = 250_000
/** A staging index kept with each checkpoint, at most. */
const MAX_INDEX_BYTES = 64 * 1024 ** 2
interface ActiveRun {
  scope: string
  snapshotId?: string
  /** Other runs in the same workspace that overlapped this one, by id. */
  shared: Set<string>
  /** The turn is over and its closing checkpoint is being written. */
  ending?: boolean
}
/** Workspace-wide Git checkpoints, with a separate index and a durable restore intent.
 * Restoring never moves HEAD. A retry completes the same fork, or refuses any edits
 * made since the interrupted operation. Native provider history is never rolled back.
 */
/**
 * Two checkpoints' trees in their workspace, and the object stores that hold
 * them; for a workspace of several repositories, each repository's, by its
 * folder in the workspace (`.` for the workspace's own).
 */
export type CheckpointTrees =
  | { scope: string; from: string; to: string; stores: string[] }
  | { scope: string; parts: { path: string; trees: CheckpointTrees }[] }

/** What changed between two checkpoints, file by file, as `TreeComparison` reads one repository's. */
export type CheckpointComparison = Pick<TreeComparison, "root" | "files" | "preview" | "close">

/** A checkpoint of a workspace of several repositories: one of each, by its folder in the workspace. */
const GroupSchema = WorkspaceSnapshotSchema.extend({
  parts: z.array(z.object({ path: z.string().min(1), id: z.string().uuid() })).min(1).max(64),
})
type GroupRecord = z.infer<typeof GroupSchema>

/** Whether one folder holds the other, or is it. */
const overlaps = (left: string, right: string) => {
  const holds = (folder: string, path: string) => {
    const child = relative(folder, path)
    return child === "" || (!child.startsWith("../") && child !== ".." && !child.startsWith("/"))
  }
  return holds(left, right) || holds(right, left)
}

/** A stable id for one repository's share of a rewind across several. */
function partId(forkId: string, part: string): string {
  const hex = createHash("sha256").update(`${forkId}\0${part}`).digest("hex")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${"89ab"[Number.parseInt(hex[16]!, 16) % 4]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/** Submodules nested this deep are taken; deeper ones are left to their own repository. */
const SUBMODULE_DEPTH = 3

export class WorkspaceSnapshots {
  private readonly db: DatabaseSync
  /** Each workspace's checkpoint operations, run one after another. */
  private readonly queues = new Map<string, Promise<unknown>>()
  /** Workspaces whose files a rewind is rewriting. */
  private readonly restoring = new Set<string>()
  private readonly runs = new Map<string, ActiveRun>()
  private readonly orphanBytes = new Map<string, number>()
  private readonly git: Git
  private readonly root: string
  private readonly retention: SnapshotRetentionPolicy
  constructor(git: Git, root: string, retention: Partial<SnapshotRetentionPolicy> = {}) {
    this.git = git
    this.retention = SnapshotRetentionPolicySchema.parse(retention)
    this.root = root
    mkdirSync(root, { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(join(root, "snapshots.sqlite"))
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS snapshots_scope_created
        ON snapshots (json_extract(value, '$.scope'), json_extract(value, '$.createdAt') DESC, id DESC);
      CREATE TABLE IF NOT EXISTS restores (id TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, value TEXT NOT NULL);`)
  }

  close(): void {
    this.db.close()
  }

  /** Rewinds a crash left unfinished; one across several repositories as the whole rewind, which `restore` finishes. */
  pending(): RewindPlan[] {
    const plans = new Map<string, RewindPlan>()
    for (const row of this.db.prepare("SELECT value FROM restores").all()) {
      const operation = OperationSchema.parse(JSON.parse(RowSchema.parse(row).value))
      if (operation.state !== "applying") continue
      const { whole, ...plan } = operation.plan
      if (whole) plans.set(whole.forkId, { ...plan, fork: { ...plan.fork, id: whole.forkId }, targetId: whole.targetId, expectedId: whole.expectedId })
      else plans.set(plan.fork.id, plan)
    }
    return [...plans.values()]
  }

  async assertAvailable(cwd: string): Promise<void> {
    const path = await realpath(cwd)
    const scopes = [
      ...this.restoring,
      ...this.pending().map((plan) => this.scopeOf(plan.targetId)),
    ]
    if (scopes.some((scope) => overlaps(scope, path)))
      throw new Error(
        "A rewind of this workspace is unfinished. Wait for it to finish before starting another turn."
      )
  }

  /**
   * The checkpoint before a turn. Another turn already running in the same
   * workspace (Threads in one main checkout) doesn't stop it: both are
   * captured, and each records the other, so a rewind to either says whose
   * each changed file is. Restoring still waits until none runs.
   */
  async beginRun(id: string, cwd: string): Promise<WorkspaceSnapshot> {
    const { scope } = await this.workspace(cwd)
    const run: ActiveRun = { scope, shared: new Set() }
    for (const [otherId, other] of this.runs) {
      if (!overlaps(other.scope, scope) || other.ending) continue
      other.shared.add(id)
      run.shared.add(otherId)
    }
    this.runs.set(id, run)
    const snapshot = await this.capture(scope, run.shared)
    run.snapshotId = snapshot.id
    return snapshot
  }

  /** The checkpoint after a turn, naming every run that shared the workspace with it. */
  async endRun(id: string): Promise<WorkspaceSnapshot> {
    const run = this.runs.get(id)
    if (!run)
      throw new Error("No workspace checkpoint was captured before this turn")
    run.ending = true
    try {
      return await this.capture(run.scope, run.shared)
    } finally {
      this.runs.delete(id)
    }
  }

  abandonRun(id: string): void {
    this.runs.delete(id)
  }

  private assertIdle(scope: string): void {
    if ([...this.runs.values()].some((run) => overlaps(run.scope, scope)))
      throw new Error(
        "Wait for every agent using this workspace to finish before rewinding"
      )
  }

  /**
   * A checkpoint of the workspace `cwd` is in: its repository, or each
   * repository of a project folder and each submodule, one after another.
   */
  async capture(cwd: string, shared?: ReadonlySet<string>): Promise<WorkspaceSnapshot> {
    const workspace = await this.workspace(cwd)
    if (workspace.repositories.length === 1 && workspace.repositories[0] === workspace.scope) return this.captureRepository(workspace.scope, shared)
    const parts: GroupRecord["parts"] = []
    let files = 0
    for (const repository of workspace.repositories) {
      const part = await this.captureRepository(repository)
      parts.push({ path: relative(workspace.scope, repository) || ".", id: part.id })
      files += part.files
    }
    return this.saveGroup({ id: randomUUID(), scope: workspace.scope, createdAt: Date.now(), files, parts, ...(shared?.size && { shared: [...shared].slice(0, 64) }) })
  }

  private async captureRepository(cwd: string, shared?: ReadonlySet<string>): Promise<WorkspaceSnapshot> {
    const scope = await this.scope(cwd)
    return this.locked(scope, async (gitDir) => {
      this.assertNoPending(scope)
      const record = await this.captureLocked(scope, gitDir, "retained", shared)
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
        const output = await this.snapshotGit(scope, [
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
          await this.snapshotGit(
            scope,
            ["update-ref", "--no-deref", "--stdin"],
            undefined,
            ["start", ...commands, "prepare", "commit", ""].join("\n")
          )
      },
    })
  }

  async preview(targetId: string): Promise<RewindPreview> {
    const group = this.group(targetId)
    if (group) return this.previewGroup(group)
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
    const groups = [this.group(fromId), this.group(toId)]
    if (groups[0] || groups[1]) {
      const [from, to] = groups
      if (!from || !to || from.scope !== to.scope || from.parts.map((part) => part.path).join("\0") !== to.parts.map((part) => part.path).join("\0"))
        throw new Error("These checkpoints belong to different workspaces")
      return { scope: from.scope, parts: from.parts.map((part, index) => ({ path: part.path, trees: this.trees(part.id, to.parts[index]!.id) })) }
    }
    const from = this.get(fromId)
    const to = this.get(toId)
    if (from.scope !== to.scope) throw new Error("These checkpoints belong to different workspaces")
    this.retain(from)
    this.retain(to)
    return { scope: from.scope, from: from.tree, to: to.tree, stores: this.objects(from, to).read }
  }

  /** The two trees `trees` gave, compared through one object reader that sees their stores; each repository's, for several. */
  compare(trees: CheckpointTrees): CheckpointComparison {
    if ("parts" in trees) return new GroupComparison(trees.scope, trees.parts.map((part) => ({ path: part.path, comparison: this.compare(part.trees) })))
    return new TreeComparison(this.git, { root: trees.scope, from: trees.from, to: trees.to, stores: trees.stores })
  }

  /** A Git command for a checkpoint: its own index and object stores, and Mako as author. */
  private snapshotGit(cwd: string, args: string[], index?: string, input?: string, objects?: SnapshotObjects): Promise<string> {
    return snapshotGit(this.git, cwd, args, index, input, objects)
  }

  async restore(input: RewindPlan, complete: () => void): Promise<void> {
    const plan = RewindPlanSchema.parse(input)
    const group = this.group(plan.targetId)
    if (group) return this.restoreGroup(plan, group, complete)
    if (this.operation(plan)?.state === "completed") {
      complete()
      return
    }
    const target = this.get(plan.targetId)
    this.assertIdle(target.scope)
    if (this.restoring.has(target.scope))
      throw new Error("Another rewind of this workspace is running")
    this.restoring.add(target.scope)
    try {
      await this.restoreLocked(plan, target, complete)
    } finally {
      this.restoring.delete(target.scope)
    }
  }

  private restoreLocked(plan: RewindPlan, target: SnapshotRecord, complete: () => void): Promise<void> {
    return this.locked(target.scope, async (gitDir) => {
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

  /**
   * A rewind across several repositories: each restored in turn, each its
   * own durable operation that names the whole, so recovery after a crash
   * finishes the whole. When one fails, those already restored are put back
   * before the error surfaces, and the fork is never made.
   */
  private async restoreGroup(plan: RewindPlan, group: GroupRecord, complete: () => void): Promise<void> {
    const expected = this.group(plan.expectedId)
    if (!expected || expected.scope !== group.scope || expected.parts.map((part) => part.path).join("\0") !== group.parts.map((part) => part.path).join("\0"))
      throw new Error("The workspace changed after the preview. Review a new preview before rewinding.")
    this.assertIdle(group.scope)
    const whole = { targetId: plan.targetId, expectedId: plan.expectedId, forkId: plan.fork.id }
    const parts = group.parts.map((part, index): RewindPlan => ({
      ...plan,
      fork: { ...plan.fork, id: partId(plan.fork.id, part.path) },
      targetId: part.id,
      expectedId: expected.parts[index]!.id,
      whole,
    }))
    const done: RewindPlan[] = []
    try {
      for (const part of parts) {
        await this.restore(part, () => {})
        done.push(part)
      }
    } catch (error) {
      const failures: Error[] = []
      for (const part of done.reverse()) {
        const back = { sourceId: part.sourceId, fork: { ...part.fork, id: partId(part.fork.id, "put back") }, targetId: part.expectedId, expectedId: part.targetId }
        await this.restore(back, () => {}).catch((failure: Error) => failures.push(failure))
      }
      if (failures.length)
        throw new AggregateError([error, ...failures], "Rewind failed part way and some repositories could not be put back. Their saved checkpoints have been retained.", { cause: error })
      throw error
    }
    complete()
  }

  private async previewGroup(group: GroupRecord): Promise<RewindPreview> {
    this.assertIdle(group.scope)
    const previews: RewindPreview[] = []
    for (const part of group.parts) previews.push(await this.preview(part.id))
    const prefix = (path: string, file: string) => (path === "." ? file : `${path}/${file}`)
    const current = this.saveGroup({
      id: randomUUID(),
      scope: group.scope,
      createdAt: Date.now(),
      files: previews.reduce((sum, preview) => sum + preview.current.files, 0),
      parts: group.parts.map((part, index) => ({ path: part.path, id: previews[index]!.current.id })),
    })
    return {
      target: this.groupSummary(group),
      current,
      changedFiles: group.parts.flatMap((part, index) => previews[index]!.changedFiles.map((file) => prefix(part.path, file))).slice(0, 100),
      changedFileCount: previews.reduce((sum, preview) => sum + preview.changedFileCount, 0),
      stagingChanged: previews.some((preview) => preview.stagingChanged),
    }
  }

  private group(id: string): GroupRecord | undefined {
    const row = this.db.prepare("SELECT value FROM groups WHERE id=?").get(id)
    return row ? GroupSchema.parse(JSON.parse(RowSchema.parse(row).value)) : undefined
  }

  private saveGroup(group: GroupRecord): WorkspaceSnapshot {
    this.db.prepare("INSERT OR REPLACE INTO groups VALUES (?, ?)").run(group.id, JSON.stringify(group))
    // A group whose repositories' checkpoints are all gone is forgotten with them.
    for (const row of this.db.prepare("SELECT id, value FROM groups WHERE json_extract(value, '$.scope')=?").all(group.scope)) {
      const kept = GroupSchema.parse(JSON.parse(RowSchema.parse(row).value))
      if (kept.parts.every((part) => !this.db.prepare("SELECT 1 FROM snapshots WHERE id=?").get(part.id)))
        this.db.prepare("DELETE FROM groups WHERE id=?").run(kept.id)
    }
    return this.groupSummary(group)
  }

  /** What a group shows as a checkpoint: its parts stay in the catalog (the schema strips them). */
  private groupSummary(group: GroupRecord): WorkspaceSnapshot {
    return WorkspaceSnapshotSchema.parse(group)
  }

  /** The workspace a checkpoint is of: one repository's, or a group's folder. */
  private scopeOf(id: string): string {
    return this.group(id)?.scope ?? this.get(id).scope
  }

  /**
   * The workspace `cwd` is in and its repositories: the repository holding
   * it and its checked-out submodules; or, for a project folder, each
   * repository it holds and theirs.
   */
  private async workspace(cwd: string): Promise<{ scope: string; repositories: string[] }> {
    const inside = await this.snapshotGit(cwd, ["rev-parse", "--show-toplevel"]).then((top) => realpath(top.trim()), () => undefined)
    if (inside) return { scope: inside, repositories: await this.withSubmodules(inside, 0) }
    const folder = await realpath(cwd)
    const found = await projectRepositories(this.git, folder)
    if (!("roots" in found)) throw new Error("Rewind needs Git: this folder isn't a repository and holds none, or holds more than Mako looks through.")
    const repositories: string[] = []
    for (const root of found.roots) repositories.push(...(await this.withSubmodules(await realpath(root), 0)))
    return { scope: folder, repositories }
  }

  /** A repository and the submodules checked out in it, each its own repository. */
  private async withSubmodules(repository: string, depth: number): Promise<string[]> {
    if (depth >= SUBMODULE_DEPTH || !existsSync(join(repository, ".gitmodules"))) return [repository]
    const listed = await this.snapshotGit(repository, ["config", "--file", ".gitmodules", "-z", "--get-regexp", "^submodule\\..*\\.path$"]).catch(() => "")
    const out = [repository]
    for (const entry of listed.split("\0")) {
      const path = entry.slice(entry.indexOf("\n") + 1)
      const folder = resolve(repository, path)
      if (!entry || !overlaps(repository, folder) || folder === repository || !existsSync(join(folder, ".git"))) continue
      out.push(...(await this.withSubmodules(await realpath(folder), depth + 1)))
    }
    return out
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
        (await this.snapshotGit(cwd, ["rev-parse", "--show-toplevel"])).trim()
      )
    } catch (error) {
      throw new Error(
        "Workspace checkpoints currently require a Git repository.",
        { cause: error }
      )
    }
  }
  /** Runs `work` once the workspace's earlier checkpoint operations here have finished. */
  private locked<T>(
    scope: string,
    work: (gitDir: string) => Promise<T>
  ): Promise<T> {
    const run = (this.queues.get(scope) ?? Promise.resolve()).then(() => this.lockedNow(scope, work))
    const settled = run.catch(() => undefined)
    this.queues.set(scope, settled)
    void settled.then(() => {
      if (this.queues.get(scope) === settled) this.queues.delete(scope)
    })
    return run
  }

  private async lockedNow<T>(
    scope: string,
    work: (gitDir: string) => Promise<T>
  ): Promise<T> {
    const repository = await this.git.openRepository(scope)
    if (!repository) throw new Error("Workspace checkpoints currently require a Git repository.")
    return repository.withLockedIndex(async () => {
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
      return work(repository.gitDir)
    })
  }
  private async head(scope: string): Promise<string> {
    const branch = (
      await this.snapshotGit(scope, ["symbolic-ref", "-q", "HEAD"]).catch(() => "detached")
    ).trim()
    const revision = (
      await this.snapshotGit(scope, ["rev-parse", "--verify", "HEAD"]).catch(() => "unborn")
    ).trim()
    return `${branch}:${revision}`
  }
  private async validateRepository(record: SnapshotRecord): Promise<void> {
    if (
      (await this.scope(record.scope)) !== record.scope ||
      (await this.snapshotGit(record.scope, ["rev-parse", "--absolute-git-dir"])).trim() !==
        record.gitDir ||
      (await this.head(record.scope)) !== record.head
    )
      throw new Error(
        "The Git branch or HEAD changed since this checkpoint. Rewinding files across that change is not supported."
      )
    await this.snapshotGit(
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
      // HEAD's own objects are there while HEAD is (checked above): only what staging adds to it needs looking for.
      const base = /:([a-f0-9]{40,64})$/.exec(record.head)?.[1]
      const savedIndex = join(this.root, record.id, "index")
      const objects = base
        ? this.stagedObjects(await this.snapshotGit(record.scope, ["diff-index", "--cached", "--no-renames", "--raw", "-z", base], savedIndex))
        : (await this.snapshotGit(record.scope, ["ls-files", "--stage", "-z"], savedIndex))
            .split("\0")
            .filter(Boolean)
            .flatMap((entry) => {
              const match = /^(\d+) ([a-f0-9]{40,64}) 0\t/.exec(entry)
              if (!match)
                throw new Error("The saved staging checkpoint is damaged.")
              // A submodule's commit is in its own repository, which its own checkpoint covers.
              return match[1] === "160000" ? [] : [match[2]!]
            })
      if (objects.length) {
        const available = await this.snapshotGit(
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
  /** The blobs a saved index adds to HEAD, from `diff-index --raw -z`: an unmerged entry means it's damaged. */
  private stagedObjects(raw: string): string[] {
    const fields = raw.split("\0")
    const out: string[] = []
    for (let at = 0; at + 1 < fields.length; at += 2) {
      const match = /^:\d+ (\d+) [a-f0-9]+ ([a-f0-9]{40,64}) ([A-Z])/.exec(fields[at]!)
      if (!match || match[3] === "U") throw new Error("The saved staging checkpoint is damaged.")
      if (match[3] !== "D" && match[1] !== "160000") out.push(match[2]!)
    }
    return out
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
    lifetime: "retained" | "temporary" = "retained",
    shared?: ReadonlySet<string>
  ): Promise<SnapshotRecord> {
    const sparse =
      (
        await this.snapshotGit(scope, ["config", "--bool", "core.sparseCheckout"]).catch(() => "false")
      ).trim() === "true"
    // One listing of the index: each entry's tag (lower case when assumed unchanged, S when skipped), mode and stage.
    let entries = 0
    const flagged: string[] = []
    for (const line of (await this.snapshotGit(scope, ["ls-files", "--stage", "-v", "-z"])).split("\0")) {
      if (!line) continue
      const tab = line.indexOf("\t")
      const [tag = "", , , stage] = line.slice(0, tab).split(" ")
      if (stage !== "0") throw new Error("Resolve this workspace's merge conflicts before a checkpoint can be taken")
      entries++
      // A sparse checkout's skipped entries aren't on disk, and Git itself clears the flag of one that is.
      if (/[a-z]/.test(tag) || (tag === "S" && !sparse)) flagged.push(line.slice(tab + 1))
    }
    const untracked = (await this.snapshotGit(scope, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
    // A repository inside this one, untracked, lists as its folder: it is its own workspace, never this one's files.
    const embedded = untracked.filter((path) => path.endsWith("/"))
    if (entries + untracked.length > MAX_FILES)
      throw new Error(`This workspace has more than ${MAX_FILES.toLocaleString("en-US")} files, past what a checkpoint holds`)
    // Only what Git must read again costs a checkpoint anything: untracked files, tracked ones whose stat changed, and those it was told not to look at.
    const modified = (await this.snapshotGit(scope, ["diff-files", "--name-only", "-z"])).split("\0").filter(Boolean)
    const reread = [...new Set([...untracked.filter((path) => !path.endsWith("/")), ...modified, ...flagged])]
    let bytes = 0
    for (let offset = 0; offset < reread.length; offset += 64) {
      const sizes = await Promise.all(
        reread.slice(offset, offset + 64).map(async (path) => {
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
        throw new Error("This turn's new and changed files exceed the 256 MB a checkpoint holds")
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
            Math.min(MAX_INDEX_BYTES, this.retention.maxSnapshotBytes))
      )
        throw new Error(
          "The checkpoint exceeds its object storage limit. No workspace files were changed."
        )
      const objects = await privateSnapshotObjects(this.git, scope, directory)
      const captureGit = (args: string[], index?: string) =>
        this.snapshotGit(scope, args, index, undefined, objects)
      if (hasIndex) {
        await copyGitIndex(userIndex, index)
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
      if (hasIndex) await copyGitIndex(index, workingIndex)
      // The working copy looks at every file that is there: a flag that tells Git not to would leave a change out.
      const present = (
        await Promise.all(flagged.map(async (path) => ((await lstat(join(scope, path)).catch(() => null)) ? path : undefined)))
      ).filter((path): path is string => path !== undefined)
      // Git applies one such option a run.
      if (present.length)
        for (const option of ["--no-assume-unchanged", "--no-skip-worktree"])
          await this.snapshotGit(scope, ["update-index", option, "-z", "--stdin"], workingIndex, `${present.join("\0")}\0`, objects)
      const indexDigest = hasIndex
        ? createHash("sha256")
            .update(await readFile(index))
            .digest("hex")
        : "absent"
      await captureGit(
        ["add", "-A", ...(sparse ? ["--sparse"] : []), "--", ".", ...embedded.map((path) => `:(exclude,literal)${path.slice(0, -1)}`)],
        workingIndex
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
        this.git,
        scope,
        directory,
        commit,
        objects,
        this.retention.maxSnapshotBytes,
        /:([a-f0-9]{40,64})$/.exec(head)?.[1]
      )
      // A temporary state's working index is what a restore from it starts with (`restoreFiles`).
      if (lifetime !== "temporary") await rm(workingIndex, { force: true })
      const payloadBytes = await snapshotPayloadBytes(directory)
      if (payloadBytes > this.retention.maxSnapshotBytes)
        throw new Error(
          "The checkpoint exceeds its object storage limit. No workspace files were changed."
        )
      record = {
        id,
        scope,
        createdAt: Date.now(),
        files: entries + untracked.length,
        gitDir,
        head,
        tree,
        commit,
        storage: { kind: "private", bytes: payloadBytes },
        indexDigest,
      }
      if (shared?.size) record.shared = [...shared].slice(0, 64)
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
      await this.snapshotGit(
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
      await this.snapshotGit(
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
        await importSnapshotObjects(this.git, target.scope, join(this.root, target.id))
      // The current state's own working index knows each file's stat, so Git rewrites only the files that differ;
      // an index read from its tree knows none, and Git would read every file again.
      const working = join(this.root, current.id, "working-index")
      if (existsSync(working)) await copyGitIndex(working, index)
      else
        await this.snapshotGit(
          target.scope,
          ["read-tree", current.tree],
          index,
          undefined,
          this.objects(current, target)
        )
      await this.snapshotGit(
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

/** A workspace of several repositories compared repository by repository, their files under each one's folder. */
class GroupComparison implements CheckpointComparison {
  readonly root: string
  private readonly parts: { path: string; comparison: CheckpointComparison }[]

  constructor(root: string, parts: { path: string; comparison: CheckpointComparison }[]) {
    this.root = root
    // The deepest folder first, so a submodule's file is its own, not its parent's.
    this.parts = [...parts].sort((left, right) => right.path.length - left.path.length)
  }

  async files(): ReturnType<TreeComparison["files"]> {
    const listed = await Promise.all(this.parts.map(async (part) => (await part.comparison.files()).map((file) => ({ ...file, path: part.path === "." ? file.path : `${part.path}/${file.path}` }))))
    return listed.flat().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  }

  preview(path: string): ReturnType<TreeComparison["preview"]> {
    const part = this.parts.find((candidate) => candidate.path === "." || path.startsWith(`${candidate.path}/`))
    if (!part) return Promise.resolve({ kind: "unavailable", reason: "This file isn't in any of the workspace's repositories." })
    return part.comparison.preview(part.path === "." ? path : path.slice(part.path.length + 1))
  }

  close(): void {
    for (const part of this.parts) part.comparison.close()
  }
}
