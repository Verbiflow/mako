import { locate, type Git } from "@mako/git"
import type { ContentRef, MakoWrite, MakoWriting } from "@mako/protocol"
import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises"
import { join, relative } from "node:path"
import { contentRef, decodeText, isText, splitLines, type ShownPair, type UndoPlan } from "../attribution/index.js"
import { hostLog } from "../base/host-log.js"
import type { GitDiff, GitFile } from "../contracts/git-workspace-search.js"
import type { LiveRequest } from "../contracts/live-conversations.js"
import { countedChanges, type TurnChangedFile } from "../contracts/turn-changes.js"
import type { TurnFileWriters, TurnUndone, TurnUndoPreview, TurnUndoResult, TurnUndoScope, WriterRun } from "../contracts/turn-review.js"
import { treeDiff, treeFiles } from "../git/index.js"
import { MovePlanSchema, MoveRefused, resumeMove, rewriteInPlace, type CheckpointComparison, type InPlaceFile, type MovePlan } from "../workspaces/index.js"

/*
 * Changes › Turn and "Undo this turn", for any turn of a conversation, live
 * or reopened. A turn's files are its request's record (`LiveRequest.changes`);
 * each one's diff is drawn from the turn's checkpoints when both were saved,
 * else from the journal's versions either side of the turn's entries; who
 * wrote each changed line, the diff with only the turn's lines, and an
 * undo's plan all come from the journal (`attribution/turn-lines.ts`). A
 * turn from before the record is read from its checkpoints, as it always was.
 */

/** What the review and the undo ask of the attribution journal. */
export interface TurnReviewLedger {
  placement(conversationId: string): { thread: string; session: string } | undefined
  settled(): Promise<void>
  blob(ref: ContentRef): Uint8Array | undefined
  turnWriters(thread: string, turn: string, file: TurnChangedFile, shown?: ShownPair): WriterRun[] | undefined
  turnOnly(thread: string, turn: string, file: TurnChangedFile): { before: string | null; after: string | null } | undefined
  undoPlan(thread: string, scope: TurnUndoScope, checkout: string): UndoPlan
  running(checkout: string): { thread: string; kind: "turn" | "background" } | undefined
  mako(write: MakoWrite): MakoWriting
}

export interface TurnReviewHost {
  /** Absent where Git isn't (a test's host): the review reads, and an undo is refused. */
  git?: Git
  ledger(): TurnReviewLedger | undefined
  /** A request as its conversation keeps it, resident or not. */
  request(id: string, requestId: string): LiveRequest | undefined
  /** The folder the conversation works in. */
  cwd(id: string): string | undefined
  /** The turn's two checkpoints, compared, with the folder they saved; undefined unless both were saved. */
  checkpoints(id: string, requestId: string): { scope: string; comparison: CheckpointComparison } | undefined
  /** Whether a conversation of this host is running or about to in `folder`. */
  busy(folder: string): boolean
  /** Keep an undo on the requests `pick` names, in the conversation's journal, and send them to the windows. */
  undone(id: string, pick: (requests: readonly LiveRequest[]) => ReadonlySet<string>, undone: TurnUndone): void
  /** Where an undo keeps its plan while it writes, for a start after a crash to finish or undo it. */
  plans: string
}

/** Bodies read lately: the review reads a file's diff and its writers together. */
const BODIES = 16

interface Body {
  diff: GitDiff
  /** The lines the diff shows, when they're the checkpoints' rather than the journal's. */
  shown?: ShownPair
  body: TurnFileWriters["body"]
}

const BUSY = "An agent is working in this checkout. Undo once it finishes."

export class LiveTurnReview {
  private readonly host: TurnReviewHost
  private readonly bodies = new Map<string, Promise<Body>>()

  constructor(host: TurnReviewHost) {
    this.host = host
  }

  private record(id: string, requestId: string) {
    const request = this.host.request(id, requestId)
    if (!request) throw new Error("This turn is unavailable")
    return countedChanges(request.changes)
  }

  /** The turn's files in one repository: `workspace`, or the first its record names. */
  async files(id: string, requestId: string, workspace?: string): Promise<{ root: string; files: GitFile[] }> {
    const record = this.record(id, requestId)
    if (!record) {
      const turn = this.host.checkpoints(id, requestId)
      if (!turn) throw new Error("This turn has no checkpoints to compare")
      return { root: turn.scope, files: await treeFiles(turn.comparison) }
    }
    const roots = [...new Set(record.files.map(rootOf))]
    const root = workspace && roots.includes(workspace) ? workspace : roots[0] ?? workspace ?? ""
    return { root, files: record.files.filter((file) => rootOf(file) === root).map(gitFile) }
  }

  private file(id: string, requestId: string, path: string): TurnChangedFile | undefined {
    return this.record(id, requestId)?.files.find((file) => file.relative === path)
  }

  /** One file's diff: the checkpoints' when both were saved, else the journal's; with `only`, the turn's own lines alone. */
  async diff(id: string, requestId: string, path: string, options: { only?: boolean } = {}): Promise<GitDiff> {
    const file = this.file(id, requestId, path)
    if (!file) {
      const turn = this.host.checkpoints(id, requestId)
      if (!turn) throw new Error("This turn has no checkpoints to compare")
      return treeDiff(turn.comparison, path)
    }
    if (options.only) {
      const placed = this.placed(id)
      const pair = placed.ledger.turnOnly(placed.thread, requestId, file)
      if (pair) return textDiff(path, file, pair.before, pair.after)
    }
    return (await this.body(id, requestId, file, path)).diff
  }

  /** Who wrote each changed line of the file's diff; null when it's binary or a version isn't kept. */
  async writers(id: string, requestId: string, path: string): Promise<TurnFileWriters | null> {
    const file = this.file(id, requestId, path)
    if (!file) return null
    const placed = this.placed(id)
    const body = await this.body(id, requestId, file, path)
    if (body.diff.binary || body.diff.preview) return null
    const runs = placed.ledger.turnWriters(placed.thread, requestId, file, body.shown)
    return runs ? { path, runs, body: body.body } : null
  }

  private placed(id: string) {
    const ledger = this.host.ledger()
    if (!ledger) throw new Error("Mako's record of changes isn't open yet. Try again in a moment.")
    const placed = ledger.placement(id)
    if (!placed) throw new Error("This conversation isn't in a Thread, so Mako has no record of whose its changes are.")
    return { ledger, thread: placed.thread }
  }

  private body(id: string, requestId: string, file: TurnChangedFile, path: string): Promise<Body> {
    const key = `${id}\0${requestId}\0${path}`
    const held = this.bodies.get(key)
    if (held) {
      this.bodies.delete(key)
      this.bodies.set(key, held)
      return held
    }
    const read = this.readBody(id, requestId, file, path)
    read.catch(() => this.bodies.delete(key))
    this.bodies.set(key, read)
    for (const oldest of this.bodies.keys()) {
      if (this.bodies.size <= BODIES) break
      this.bodies.delete(oldest)
    }
    return read
  }

  private async readBody(id: string, requestId: string, file: TurnChangedFile, path: string): Promise<Body> {
    // A rename's checkpoints hold two unrelated paths; the journal holds the file whole.
    const turn = file.kind === "rename" ? undefined : this.host.checkpoints(id, requestId)
    const inside = turn && relative(turn.scope, file.path)
    let checkpoints: GitDiff | undefined
    if (turn && inside && !inside.startsWith("..")) {
      checkpoints = await treeDiff(turn.comparison, inside)
      if (checkpoints.binary) return { diff: { ...checkpoints, path }, body: "checkpoints" }
      if (!checkpoints.preview) {
        const lines = (side: { contents: string } | null) => (side ? splitLines(side.contents) : null)
        return { diff: { ...checkpoints, path }, shown: { before: lines(checkpoints.oldFile), after: lines(checkpoints.newFile) }, body: "checkpoints" }
      }
    }
    // The checkpoints' diff of a large file is a shortened patch; the journal keeps it whole, up to its limit.
    const ledger = this.host.ledger()
    const read = (ref: ContentRef | null) => (ref === null ? null : ledger?.blob(ref))
    const before = read(file.before)
    const after = read(file.after)
    if (before === undefined || after === undefined) {
      if (checkpoints) return { diff: { ...checkpoints, path }, body: "checkpoints" }
      return { diff: { path, binary: false, oldFile: null, newFile: null, preview: { kind: "unavailable", reason: "Mako's record of this turn doesn't keep this file's content." } }, body: "journal" }
    }
    if ((before && !isText(before)) || (after && !isText(after)))
      return { diff: { path, binary: true, oldFile: null, newFile: null, before: before ? { bytes: before.byteLength } : null, after: after ? { bytes: after.byteLength } : null }, body: "journal" }
    return { diff: textDiff(path, file, before && decodeText(before), after && decodeText(after)), body: "journal" }
  }

  /** The Thread, its journal, the checkout an undo writes in, and why it can't now. */
  private async target(id: string) {
    const placed = this.placed(id)
    const cwd = this.host.cwd(id)
    const git = this.host.git
    if (!cwd) throw new Error("This conversation is unavailable")
    if (!git) throw new Error("Undo needs Git, which this host doesn't run.")
    const checkout = (await locate(git, cwd).catch(() => null))?.root ?? cwd
    const running = this.host.busy(checkout) || placed.ledger.running(checkout)
    return { ...placed, git, checkout, refused: running ? BUSY : undefined }
  }

  /** What undoing a turn, or the Thread, would do in its checkout now. */
  async undoPreview(id: string, scope: TurnUndoScope): Promise<TurnUndoPreview> {
    const target = await this.target(id)
    await target.ledger.settled()
    const plan = target.ledger.undoPlan(target.thread, scope, target.checkout)
    const refused = this.undoneAlready(id, scope) ?? target.refused
    return { scope, checkout: target.checkout, undo: plan.undo, kept: plan.kept, left: plan.left, token: plan.token, ...(refused && { refused }) }
  }

  /** Why a turn can't be undone again: it was, and its record says so. */
  private undoneAlready(id: string, scope: TurnUndoScope): string | undefined {
    const undone = scope.kind === "turn" ? this.host.request(id, scope.requestId)?.undone : undefined
    if (!undone) return undefined
    return `This turn was undone already: its lines came out of ${undone.files === 1 ? "1 file" : `${undone.files} files`}${undone.backup ? `, and the checkout from before is kept as ${undone.backup}` : ""}. Rewind puts the whole workspace back instead.`
  }

  /**
   * Undo as the preview read `token` said: refused while an agent works in
   * the checkout, or when the files changed since the preview. Written all or
   * nothing with the move's writer, the checkout kept under a backup ref first.
   */
  async undo(id: string, scope: TurnUndoScope, token: string): Promise<TurnUndoResult> {
    const target = await this.target(id)
    const refused = this.undoneAlready(id, scope) ?? target.refused
    if (refused) throw new MoveRefused(refused)
    const { ledger, thread, checkout, git } = target
    await ledger.settled()
    // The watcher hears a write some milliseconds after it lands: a file the journal hasn't caught up with is read again.
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) {
        await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
        await ledger.settled()
      }
      const plan = ledger.undoPlan(thread, scope, checkout)
      if (plan.token !== token) throw new MoveRefused("The files changed since this preview. Look at it again before undoing.")
      const repositories = await this.read(git, plan, ledger)
      if (!repositories) continue
      if (!repositories.length) return { files: 0, backup: "", left: plan.left }
      const undoId = randomUUID()
      const done = await rewriteInPlace({
        git,
        ledger,
        id: undoId,
        thread,
        project: checkout,
        repositories,
        message: `Mako: the checkout before undoing ${scope.kind === "turn" ? `turn ${scope.requestId}` : "every change"} of Thread ${thread}`,
        save: (saved) => this.save(undoId, saved),
        log: (message, facts) => hostLog("turn-undo", message, facts),
      })
      hostLog("turn-undo", "undid", { thread, scope: scope.kind, files: done.outcome.came.files, lines: done.outcome.came.lines, left: plan.left.length })
      const result = { files: done.outcome.came.files, backup: done.outcome.backup ?? "", left: plan.left }
      if (result.files) this.host.undone(id, (requests) => undoneTurns(requests, scope, checkout), { at: Date.now(), scope: scope.kind, files: result.files, left: result.left.length, backup: result.backup })
      return result
    }
    throw new MoveRefused("Files Mako was undoing were still changing, so nothing changed. Try again in a moment.")
  }

  /** Each write's bytes now and after, by repository; undefined when a file isn't what the journal holds yet. */
  private async read(git: Git, plan: UndoPlan, ledger: TurnReviewLedger) {
    const byRoot = new Map<string, InPlaceFile[]>()
    for (const write of plan.writes) {
      const absolute = join(write.rootPath, write.path)
      const stat = await lstat(absolute).catch(() => null)
      if (stat && !stat.isFile()) throw new MoveRefused(`${write.path} isn't a file any more, so nothing changed.`)
      const before = stat ? await readFile(absolute) : null
      if ((before ? contentRef(before) : null) !== write.current) return undefined
      const after = write.next.kind === "absent" ? null : write.next.kind === "text" ? Buffer.from(write.next.text, "utf8") : ledger.blob(write.next.ref)
      if (after === undefined) throw new MoveRefused(`Mako's record no longer keeps the version of ${write.path} to put back, so nothing changed.`)
      const files = byRoot.get(write.rootPath) ?? []
      files.push({ path: write.path, before, ...(stat && { perm: stat.mode & 0o777 }), after: after && Buffer.from(after) })
      byRoot.set(write.rootPath, files)
    }
    const out: { repoRoot: string; head: string; files: InPlaceFile[] }[] = []
    for (const [repoRoot, files] of byRoot) {
      const head = await git.output(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => null)
      if (!head) throw new MoveRefused(`Undo keeps the checkout's state as a Git commit first, and ${repoRoot} has no commit to keep it on.`)
      out.push({ repoRoot, head, files })
    }
    return out
  }

  /** Keep an undo's plan while it writes; drop it once it needs no finishing. */
  private async save(id: string, plan: MovePlan | undefined): Promise<void> {
    const target = join(this.host.plans, `${id}.json`)
    if (!plan) {
      await rm(target, { force: true })
      return
    }
    await mkdir(this.host.plans, { recursive: true, mode: 0o700 })
    const pending = `${target}.${randomUUID()}.tmp`
    await writeFile(pending, JSON.stringify(plan), { mode: 0o600 })
    await rename(pending, target)
  }

  /** At start: an undo a host died in the middle of is finished, or put back, from its saved plan. */
  async resume(): Promise<void> {
    const git = this.host.git
    if (!git) return
    const names = await readdir(this.host.plans).catch(() => [])
    for (const name of names) {
      if (!name.endsWith(".json")) continue
      const path = join(this.host.plans, name)
      const plan = MovePlanSchema.safeParse(JSON.parse(await readFile(path, "utf8").catch(() => "null"))).data
      if (plan)
        await resumeMove(git, this.host.ledger(), plan, (message, facts) => hostLog("turn-undo", message, facts)).then(
          () => hostLog("turn-undo", "finished an undo cut short", { thread: plan.thread }),
          (error: Error) => hostLog("turn-undo", "an undo cut short was put back", { thread: plan.thread, error: error.message }),
        )
      await rm(path, { force: true })
    }
  }
}

/**
 * The turns an undo took back: the one it named, or, for every change of
 * the Thread, each turn of the conversation whose own lines are in the
 * checkout. A turn undone before keeps its first undo.
 */
export function undoneTurns(requests: readonly LiveRequest[], scope: TurnUndoScope, checkout: string): Set<string> {
  if (scope.kind === "turn") return new Set(requests.some((request) => request.id === scope.requestId) ? [scope.requestId] : [])
  const inside = (root: string) => root === checkout || root.startsWith(`${checkout}/`) || checkout.startsWith(`${root}/`)
  return new Set(requests.filter((request) => !request.undone && countedChanges(request.changes)?.files.some((file) => file.own !== undefined && inside(rootOf(file)))).map((request) => request.id))
}

/** The repository a record's file is in: its path less the path inside the journal's root. */
const rootOf = (file: TurnChangedFile) => file.path.slice(0, file.path.length - file.relative.length - 1)

/**
 * A record's file as Changes lists it, counted as the turn's line counts it:
 * the Thread's own lines. Lines not sure whose aren't in them (a file with
 * only those counts none); the window names them from the record beside it.
 */
function gitFile(file: TurnChangedFile): GitFile {
  const own = file.own
  return {
    path: file.relative,
    status: file.kind === "create" ? "added" : file.kind === "delete" ? "deleted" : "modified",
    staged: false,
    insertions: own === null ? null : own?.added ?? 0,
    deletions: own === null ? null : own?.removed ?? 0,
    binary: own === null || file.maybe === null,
  }
}

/** A text diff of two versions; a rename's before is named by its old path. */
function textDiff(path: string, file: TurnChangedFile, before: string | null, after: string | null): GitDiff {
  const was = file.from ? relative(rootOf(file), file.from) : path
  return { path, binary: false, oldFile: before === null ? null : { name: was, contents: before }, newFile: after === null ? null : { name: path, contents: after } }
}
