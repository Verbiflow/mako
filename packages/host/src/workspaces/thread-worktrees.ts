import { inSlices } from "@mako/sessions/slices"
import { summaryRows, summaryTips, summaryChanges } from "./worktree-summary-rows.js"
import { createHash, randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import type { ThreadStore } from "../threads/index.js"
import type { ThreadId } from "../contracts/thread-identity.js"
import { WORKTREE_BRANCH_PREFIX as BRANCH_PREFIX, PROJECT_CHECKOUT_FILE, projectCheckoutText, worktreeCheckout, worktreeSlug } from "../contracts/thread-worktrees.js"
import type { GitDiff } from "../contracts/git-workspace-search.js"
import type { ThreadWorktree, ThreadWorktrees as ThreadWorktreeList, WorktreeDetail, WorktreeInventory, WorktreeLanding, WorktreeBranch, WorktreeMergeCheck, WorktreeReview, WorktreeReviewFile, WorktreeStart, WorktreeStartPoint, WorktreeStep, WorktreeBranchPull, WorktreeSummary, WorktreeSummariesHeld, WorktreeSummaryChanges, WorktreeRemoval, WorktreeUpdate, RetiredWorktree, WorktreeRestored } from "../contracts/thread-worktrees.js"
import { inputsDigest, type PrepareStep } from "./thread-recipe.js"
import { checkoutStatuses, previewDiffs, projectRepositories, type CheckoutStatuses } from "../git/index.js"
import { CheckoutBorrowing } from "./checkout-borrowing.js"
import { carryOutputs, outputNames, removeBelowAgents, type CheckoutSetup, type OutputsCarry } from "./worktree-carry.js"
import { commonDirOf, gitFileText, GitError, NO_INDEX_REFRESH, numstatEntries, untrackedLines, type Git } from "@mako/git"
import { locateGitDir } from "../base/checkout-location.js"
import { CommitAnswers, WorktreeSummaryCache, type HeldPoint, type HeldSummary, type SummaryMemory } from "./worktree-summary-cache.js"
import { storedRefs, WorktreeSizes } from "./worktree-status.js"
import { WorktreeSpares, type Spare } from "./worktree-spares.js"
import { fetchQuietly, WorktreeStarts } from "./worktree-start.js"
import { bringStayed, broughtSentence, MovePlanSchema, MoveOutcomeSchema, moveByAuthor, previewShares, pruneBackups, putBack, resumeMove, returnedSentence, stayedPaths, type AdjustHooks, type StayedPaths, type Adjuster, type MoveLedger, type MovePlan } from "./worktree-move.js"
import type { MoveHaste, MoveOutcome, MoveShares } from "../contracts/workspace-moves.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { mapLimit } from "@mako/protocol/map-limit"
import { githubRepositoryUrl } from "../contracts/cloud-threads.js"
import { fillWorktree, ProjectMissingError, reattachWorktree, workingCheckout } from "./worktree-reattach.js"
import { childBackend, type WatchBackend } from "./watch-backend.js"
import { HEAD_MARKER, REF_MARKERS, INDEX_MARKER, watchGitMarkers, type GitDirWatch } from "./git-dir-watch.js"
import { localWords } from "@mako/protocol/computer-words"

/** Git's own markers for work under way, which a removal would throw away. */
const UNDER_WAY: readonly (readonly [string, string])[] = [
  ["rebase-merge", "rebase"], ["rebase-apply", "rebase"], ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"], ["REVERT_HEAD", "revert"], ["BISECT_LOG", "bisect"],
]
const MAX_REMEMBERED_CARRIES = 64
/** Events in a burst (an agent's `git add` then commit) read the worktree once, this long after the first. */
const SUMMARY_SETTLE_MS = 1_000
/** A worktree whose events keep coming (an agent's own `git status` rewriting its index) is read at most this often. */
const SUMMARY_GAP_MS = 5_000
/**
 * A change of its index alone (a terminal's `git add`, and any `git status` that refreshes it, a Changes panel's as an
 * agent edits) reads a worktree at most this often: read on each, the summaries cost more than the poll they replace.
 */
const SUMMARY_INDEX_GAP_MS = 30_000
/**
 * The host's own pass, while a window listens: what no event says (a pull request on GitHub). A pass asks Git only of
 * what moved (`readListed`), so one that finds everything as it was starts no process.
 */
export const SUMMARY_PASS_MS = 60_000
/**
 * A worktree's `status` is read on its own events: its index or HEAD moved, a turn in it ended, a tool reported a
 * write there, or a file changed in it while a window shows it (`filesHeard`). A worktree no tree watch covers has
 * nothing to say an editor changed a file in it: past this it's read again whatever was heard, an hour, spread by
 * `STATUS_SPREAD` so a hundred worktrees don't come due together. Read every five minutes each, a hundred worktrees
 * were twenty to thirty walks of a checkout a minute with nothing happening in any.
 */
const STATUS_BACKSTOP_MS = 60 * 60_000
const STATUS_SPREAD = 0.25
/**
 * A write to a worktree's files (a tool's reported effect, a file event while a window shows it) reads its status this
 * long after the last one, so a burst of edits is one read. While writes keep coming the wait between reads doubles
 * to `FILES_GAP_MAX_MS`, and starts over once the worktree has been quiet that long: a turn editing two hundred files
 * costs a handful of reads, and the count still moves while it works.
 */
const FILES_SETTLE_MS = 3_000
const FILES_GAP_MAX_MS = 30_000
/** A window coming to focus reads a worktree it shows that no tree watch covers, at most this often. */
const FOCUS_GAP_MS = 60_000
/** A worktree asked of alone (an agent's `worktree_status`) reads its status again past this, whatever was heard. */
const STATUS_FRESH_MS = 15_000
/**
 * When the branch the main checkout has out moves, every open branch's landing is asked again, a merge in memory
 * each. Those a window shows or a conversation works in are read first; the rest one at a time, this far apart.
 */
const LANDING_SPREAD_MS = 150
/** `for-each-ref`'s `ahead-behind`, which counts every branch against a commit in one process, came with Git 2.41. */
const AHEAD_BEHIND_GIT = [2, 41] as const
/** A new Thread's branch search lists this many branches, the most recently committed. */
const LISTED_BRANCHES = 200
const BRANCH_PULLS_EVERY_MS = 60_000

/**
 * The pull request for `branch`: by its head branch, or by number for a
 * fork's pull request fetched as `pr-N`. An open one wins over a closed one;
 * otherwise the newest.
 */
function branchPull(pulls: readonly WorktreeBranchPull[], branch: string): WorktreeBranchPull | null {
  const number = /^pr-(\d+)$/.exec(branch)?.[1]
  const mine = pulls.filter((pull) => pull.branch === branch || (number !== undefined && pull.number === Number(number)))
  return mine.find((pull) => pull.state === "open" || pull.state === "draft") ?? mine[0] ?? null
}

/** Built once: every list checks every receipt's name, and building a schema costs more than using one. */
const ConversationIdSchema = z.string().uuid()

const ReceiptSchema = z.object({
  conversation: ConversationIdSchema,
  /** The folder the Thread was started from, resolved. */
  source: z.string(),
  repoRoot: z.string(),
  path: z.string(),
  cwd: z.string(),
  branch: z.string(),
  base: z.string(),
  state: z.enum(["creating", "ready"]),
  copied: z.number().optional(),
  tookMs: z.number().optional(),
  /** Taken from a checkout made ahead of time. */
  spare: z.boolean().optional(),
  /**
   * What moving the source checkout's uncommitted changes here did, so a
   * repeated request answers the same: the move's id, whose plan stays while
   * what stayed can still be brought, and what came and stayed. `stash` is a
   * move by an earlier version that left its changes in a stash.
   */
  moved: z.union([z.object({ files: z.number(), id: z.string().uuid().optional(), outcome: MoveOutcomeSchema.optional() }), z.object({ stash: z.string() })]).optional(),
  /**
   * Written before a move plans anything, so a start cut short finds it: its
   * saved plan finishes or undoes it, and with no plan nothing was written.
   * `stash` is an earlier version's move through a stash.
   */
  moving: z.union([z.object({ id: z.string().uuid() }), z.object({ stash: z.string(), files: z.number() })]).optional(),
  /** What the person changed in the worktree since its agent last heard, in sentences its next turn opens with. */
  untold: z.array(z.string()).optional(),
  /** The branch existed before the Thread: it works on it, and nothing Mako does deletes it. */
  adopted: z.literal(true).optional(),
  /** Where a new branch started, as a person reads it: `main`, `origin/main`, a short commit. */
  from: z.string().optional(),
  /**
   * Made from a commit its start or move named (`WorktreeFrom` "from"), not the commit its source checkout is on: a
   * move into it carries none of that checkout's changes, which were made on another commit (`wantBranch`).
   */
  based: z.literal(true).optional(),
  /**
   * A project folder holding several repositories, no repository itself:
   * `repoRoot` is the project folder, `path` the folder mirroring it, and
   * each repository has its worktree here, at the same place inside, on
   * `branch`. `base` and `from` are each repository's own.
   */
  members: z.array(z.object({
    repoRoot: z.string(),
    path: z.string(),
    base: z.string(),
    from: z.string(),
    /** The repository had the named branch before the Thread, as `adopted` says of a whole receipt. */
    adopted: z.literal(true).optional(),
  })).min(1).optional(),
})
type Receipt = z.infer<typeof ReceiptSchema>
/** One repository's worktree in a Thread's checkout. */
type Member = { repoRoot: string; path: string; base: string; from?: string; adopted?: true }

/** The worktrees a receipt made: one, or one per repository of a project folder. */
const membersOf = (receipt: Receipt): Member[] =>
  receipt.members ?? [{ repoRoot: receipt.repoRoot, path: receipt.path, base: receipt.base, from: receipt.from, ...(receipt.adopted && { adopted: true as const }) }]

/** A Thread's checkout on this device: the folder it works in, the project folder it mirrors, and a worktree per repository. */
export interface ThreadCheckout {
  path: string
  project: string
  branch: string
  worktrees: ThreadWorktree[]
}
type WorktreeFrom = { kind: "newest" } | { kind: "head" } | WorktreeStart

/** The branch an agent's move names, and the commit it starts from. */
export interface WorktreeWanted {
  branch?: string
  base?: string
}
/** A repository's recent pull requests, newest first; null when GitHub can't answer. */
type PullsOf = (repoRoot: string, liveHeads?: readonly string[], liveBranches?: ReadonlyMap<string, string>) => Promise<WorktreeBranchPull[] | null>

export interface PreparedWorktree {
  /** Where the conversation runs: the worktree, or the same subfolder in it the Thread was started from. */
  cwd: string
  path: string
  branch: string
  /** Files the recipe's `carry` names, copied from the main checkout. */
  copied: number
  tookMs: number
  /** Taken from a checkout made ahead of time rather than checked out on the send. */
  spare: boolean
}

/** Untracked files whose lines a review counts; past this they are listed uncounted. */
const COUNTED_UNTRACKED = 200

/**
 * Why removing the worktree at `path` would lose work, if it would:
 * uncommitted files, a rebase or merge under way, or a detached HEAD on a
 * commit no branch or tag has. Anything committed on a branch stays with it.
 */
async function removalBlocker(git: Git, path: string, status?: string | Promise<string>, remoteProof = false): Promise<string | undefined> {
  const name = basename(path)
  let changes: string
  let gitDir: string
  try {
    ;[changes, gitDir] = await Promise.all([
      status ?? git.readOutput(path, ["status", "--porcelain", "--untracked-files=normal"]),
      // A linked worktree's `.git` file names its Git directory; anything else is asked of Git.
      worktreeGitDir(path).then((named) => named ?? git.output(path, ["rev-parse", "--absolute-git-dir"])),
    ])
  } catch (error) {
    return `Git couldn't read ${name}: ${error instanceof Error ? error.message : String(error)}`
  }
  if (changes) return `${name} has changes that aren't committed. Commit or discard them, then remove the worktree.`
  const underWay = UNDER_WAY.find(([marker]) => existsSync(join(gitDir, marker)))
  if (underWay) return `${name} is in the middle of a ${underWay[1]}. Finish or abort it, then remove the worktree.`
  if (!remoteProof && !(await onBranch(git, path, gitDir))) {
    const kept = await git.output(path, ["for-each-ref", "--count=1", "--contains", "HEAD", "--format=%(refname)", "refs/heads", "refs/tags", "refs/remotes"]).catch(() => "")
    if (!kept) return `${name} is on a commit no branch has. Create a branch there, then remove the worktree.`
  }
  return undefined
}

/** Whether the checkout is on a branch: its `HEAD` file says so, and Git is asked only when the file can't be read. */
async function onBranch(git: Git, path: string, gitDir: string): Promise<boolean> {
  const head = await gitFileText(join(gitDir, "HEAD"))
  if (head) return head.startsWith("ref: ")
  return git.succeeds(path, ["symbolic-ref", "-q", "HEAD"])
}

const inUseBy = (folder: string, users: readonly string[]) =>
  `${basename(folder)} is in use by ${users.join(", ")}. Stop ${users.length === 1 ? "it" : "them"}, then remove the worktree.`

/** What a summaries pass reads once of a repository, however many of its worktrees it summarizes. */
interface RepositoryFacts {
  /** The branch its main checkout has out; empty when it's on none. */
  into: string
  /** Every branch's commit, by name. */
  tips: ReadonlyMap<string, string>
  /** Where new Threads start, by the rule a worktree is updated by. */
  point: WorktreeStartPoint | null
}

interface RepositoryPoints {
  heads: readonly string[]
  branches: ReadonlyMap<string, string>
}

/** A worktree's count of changed files as a `status` read it, with when, and its index's modification time then. */
interface StatusHeld {
  at: number
  index: number
  changes: Promise<number>
}

/** The summaries that changed and the worktrees that went, until they're said together. */
interface UnsaidSummaries {
  changed: Map<string, WorktreeSummary>
  removed: Set<string>
}

/** What an event said of a worktree since its summary was read (`staleSummaries`), and which asks for more. */
type StaleKind = "status" | "files" | "index" | "refs"
const STALE_RANK = { refs: 0, index: 1, files: 2, status: 3 } satisfies Record<StaleKind, number>

/** A path as the watcher spells it: macOS's `/private` is the same folder without it. */
const plainPath = (path: string) => (path.startsWith("/private/") ? path.slice("/private".length) : path)

/** A repository's pull requests being read, and the reading once it's in. */
interface PullsReading {
  pulls: Promise<WorktreeBranchPull[] | null>
  read?: { pulls: WorktreeBranchPull[] | null }
}

/** The commits a landing is asked at. */
interface LandingAt {
  repoRoot: string
  base: string
  into: string
  tip: string
  target: string
}

/**
 * A landing that may wait: `previous` is what the worktree's summary said before, which stands meanwhile when it was
 * merged, and `read` takes the merge to make once the worktrees someone is looking at are read.
 */
interface LaterLanding {
  previous: WorktreeLanding
  read(tip: string, job: () => Promise<WorktreeLanding>): void
}

/** Ends the `refs` of a summary held while its landing waits its turn (`laterLandings`). */
const LANDING_AWAITED = "\nlanding awaited"

const aheadKey = (repoRoot: string, from: string, tip: string) => `ahead\0${repoRoot}\0${from}\0${tip}`
const behindKey = (repoRoot: string, head: string, point: string) => `behind\0${repoRoot}\0${head}\0${point}`

/** `STATUS_BACKSTOP_MS` for one worktree, longer by up to `STATUS_SPREAD` by its path, so those read together don't come due together. */
function statusBackstop(path: string): number {
  let hash = 0
  for (let at = 0; at < path.length; at += 1) hash = (hash * 31 + path.charCodeAt(at)) % 1_000
  return STATUS_BACKSTOP_MS * (1 + STATUS_SPREAD * hash / 1_000)
}


/**
 * The commit a linked worktree has checked out, read from its files rather
 * than a Git process: its `.git` names its folder in the repository, whose
 * `HEAD` names a branch (found in `tips`) or a commit. Undefined when the
 * files don't say, and the caller asks Git.
 */
async function worktreeHead(path: string, tips: ReadonlyMap<string, string>): Promise<string | undefined> {
  try {
    const gitDir = await worktreeGitDir(path)
    if (!gitDir) return undefined
    const head = (await readFile(join(gitDir, "HEAD"), "utf8")).trim()
    if (head.startsWith("ref: refs/heads/")) return tips.get(head.slice("ref: refs/heads/".length))
    return /^[0-9a-f]{40,64}$/.test(head) ? head : undefined
  } catch {
    return undefined
  }
}

/** The actual checked-out branch, which may differ from the branch recorded when this worktree was made. */
async function worktreeBranch(path: string): Promise<string | undefined> {
  const gitDir = await worktreeGitDir(path)
  const head = gitDir && await readFile(join(gitDir, "HEAD"), "utf8").catch(() => "")
  return head?.trim().startsWith("ref: refs/heads/") ? head.trim().slice("ref: refs/heads/".length) : undefined
}

/**
 * The commits a held summary was read at, checked even before the file watcher delivers its event: the worktree's own
 * first (its branch's and its HEAD's), then the main checkout's branch and its commit, and where new Threads start.
 */
function summaryRefs(worktree: ThreadWorktree, facts: RepositoryFacts, head: string | undefined): string {
  return `${ownRefs(worktree, facts, head)}${JSON.stringify([facts.into, facts.tips.get(facts.into), facts.point?.commit, facts.point?.from])}`
}

/** The part of `summaryRefs` only the worktree's own commits move. */
function ownRefs(worktree: ThreadWorktree, facts: RepositoryFacts, head: string | undefined): string {
  return `${JSON.stringify([facts.tips.get(worktree.branch), head])}\n`
}

/** A linked worktree's folder in its repository, from the `gitdir:` line of its `.git` file. */
async function worktreeGitDir(path: string): Promise<string | undefined> {
  const link = /^gitdir: (.+)$/m.exec(await readFile(join(path, ".git"), "utf8").catch(() => ""))?.[1]
  return link && resolve(path, link)
}

/**
 * Work every worktree pays for, one pass at a time: one asking while a pass runs gets the next, which starts once that
 * ends and serves everyone who asked meanwhile, so each answer was read after it was asked.
 */
class SharedPasses<T> {
  private running: Promise<T> | undefined
  private next: Promise<T> | undefined

  ask(read: () => Promise<T>): Promise<T> {
    // First: one that ended leaves its successor promised, not yet started, and a caller it wakes asks in that gap.
    if (this.next) return this.next
    if (!this.running) return this.start(read)
    this.next = this.running.catch(() => undefined).then(() => {
      this.next = undefined
      return this.start(read)
    })
    return this.next
  }

  private start(read: () => Promise<T>): Promise<T> {
    const pass = read().finally(() => {
      if (this.running === pass) this.running = undefined
    })
    this.running = pass
    return pass
  }
}

/**
 * Worktrees for Threads that start in one. Each is a branch `mako/{slug}`
 * checked out under `{root}/{repo}-{hash}/{slug}`, made on the Thread's
 * first send and never on a read. A Thread's checkout is of its project:
 * for a project folder holding several repositories, a folder mirroring it
 * with every repository's worktree inside, all on the one branch
 * (`createProject`). A receipt per conversation makes a repeated start find
 * the worktree the first attempt made, including one cut short between
 * `git worktree add` and the copy.
 *
 * What else a new checkout gets from the main one is the project's recipe's
 * to say, not Mako's: the files its `carry` names, before the agent starts,
 * and its install steps' `outputs` in the background (`carryOutputs`).
 * Without a recipe, a worktree has what Git checks out and nothing more.
 *
 * The send takes a spare checkout when the project has one ready, and the
 * project's spares are topped up behind it (`WorktreeSpares`).
 */
/** A Worktree Thread's running app ends with its worktree: its processes stop before the folder goes, and its data after. */
export interface ThreadEnvironmentEnd {
  stop(thread: ThreadId): Promise<void>
  /** Runs the recipe's cleanup in the worktree, while it's still there under its own name. */
  cleanup?(thread: ThreadId, path: string): Promise<void>
  discard(thread: ThreadId, path: string): Promise<void>
}

/** What the host knows of who is looking at a worktree and of who hears its files, for when its summary is read. */
export interface WorktreeLooking {
  /** Whether a window shows the worktree's row or its Thread now. */
  shown?(path: string): boolean
  /** Whether a tree watch that is delivering covers the worktree, so a file changed there reaches `filesHeard`. */
  heard?(path: string): boolean
}

/** What is open in a checkout being removed, and its conversations going on in the main checkout (`checkoutConversations`). */
export interface CheckoutConversations {
  /**
   * What keeps the checkout from going, as a person would name it: terminals,
   * and conversations that can't move now. `waitingFor`, a conversation whose
   * own turn the removal waits for, counts only if it can't move at all.
   */
  holding(folder: string, waitingFor?: string): Promise<string[]>
  /** Move each open conversation in `from` to the same place under `to`; names those that stayed. */
  leave(from: string, to: string): Promise<string[]>
}

/** The folder of the worktree that has `branch` checked out, from `git worktree list --porcelain`; undefined when none has. */
function worktreeHolding(porcelain: string, branch: string | undefined): string | undefined {
  if (!branch) return undefined
  for (const block of porcelain.split("\n\n")) {
    const lines = block.split("\n")
    if (lines.includes(`branch refs/heads/${branch}`)) return lines.find((line) => line.startsWith("worktree "))?.slice("worktree ".length)
  }
  return undefined
}

/** The worktree a move onto the Thread's own branch would make now, with nothing made: its first repository's folder. */
export interface PlannedCheckout {
  folder: string
  /** The main checkout's repository that folder is made from. */
  repository: string
  /** The branch the worktree would be on, in every repository. */
  branch: string
  /** Every repository of the main checkout the Thread works in (one, or a project folder's), and the folder its worktree would have. */
  repositories: Array<{ root: string; folder: string }>
  /** In a project folder of several repositories, the project worktree holding each one's: where its Sessions would work. */
  project?: string
  /** With `project`: the project folder of the main checkout it mirrors, where the Thread's Sessions work here. */
  projectFrom?: string
}

export class ThreadWorktreeService {
  readonly root: string
  private readonly watch: WatchBackend
  private readonly git: Git
  private readonly threads: ThreadStore
  /** Retired worktrees being made again now, by path (`restoreRetired`): a second asker joins the first. */
  private readonly restoring = new Map<string, Promise<WorktreeRestored | undefined>>()
  private readonly inUse: (path: string) => Promise<string[]>
  private readonly working: (path: string) => Promise<string[]>
  private readonly environment: ThreadEnvironmentEnd | undefined
  private readonly setup: CheckoutSetup | undefined
  /** What a worktree takes from its main checkout, as leases of this device's broker. */
  readonly borrowing: CheckoutBorrowing
  private readonly conversations: CheckoutConversations | undefined
  private readonly ledger: () => MoveLedger | undefined
  private readonly workingFolders: () => Promise<string[]>
  private readonly pending = new Map<string, Promise<Receipt>>()
  private readonly carrying = new Map<string, Promise<OutputsCarry>>()
  private readonly wanting = new Set<Promise<void>>()
  private readonly spares: WorktreeSpares
  private readonly starts: WorktreeStarts
  private readonly skips = new Map<string, () => void>()
  private readonly branchPulls = new Map<string, { at: number; heads: ReadonlySet<string>; branches: ReadonlyMap<string, string>; pulls: Promise<WorktreeBranchPull[] | null> }>()
  /** Each repository's pull requests as last read, kept past `forgetPulls`, for what a Fin's strip says (`heldPulls`). */
  private readonly pullsRead = new Map<string, WorktreeBranchPull[]>()
  /** What each repository's last reading of its pull requests came to, null when GitHub couldn't answer or nobody looked. */
  private readonly pullsSaid = new Map<string, WorktreeBranchPull[] | null>()
  /** Each receipt's `untold`, read without waiting, as a turn is sent. */
  private readonly untold = new Map<string, string[]>()
  private readonly summaryPasses = new SharedPasses<WorktreeSummary[]>()
  /**
   * Each worktree's summary as last read, by path, with when, its index's modification time then and the commits it
   * was read at (`readSummaries`). Kept between hosts (`cache`), so a start answers with them at once.
   */
  private readonly heldSummaries = new Map<string, HeldSummary>()
  /** Summaries held from the file, which this host hasn't looked at yet: said as still being read (`held`). */
  private readonly unchecked = new Set<string>()
  /**
   * Worktrees an event says changed since their summary was read, and what it said: `status` for a turn's end or a
   * moved HEAD, `files` for writes to its files, which are waited out (`FILES_SETTLE_MS`), `index` when all it said is
   * that the index moved, `refs` when a ref every checkout shares moved, which changes no worktree's files and so asks
   * for no `status`.
   */
  private readonly staleSummaries = new Map<string, StaleKind>()
  /** The summaries' answers between hosts, and whether they've been read in (`remember`). */
  private readonly cache: WorktreeSummaryCache
  private remembered: Promise<void> | undefined
  /** Each repository's start point by what it was read at (`WorktreeStarts`), kept between hosts with the rest. */
  private readonly points = new Map<string, HeldPoint>()
  /** Landings waiting their turn after a pass (`laterLandings`), by worktree, and the one drain that reads them. */
  private readonly landingsLater = new Map<string, { refs: string; awaiting: string; tip: string; read: () => Promise<WorktreeLanding> }>()
  private landingDrain: Promise<void> | undefined
  private readonly looking: WorktreeLooking
  /**
   * Worktrees whose files may have changed with nobody looking: a file event while no window showed them, or a status
   * the last host read and this one hasn't. Read once a window shows them, else at the hour's backstop.
   */
  private readonly unseen = new Set<string>()
  /** When each worktree's files were last said to change, and how long its next read waits after the one before (`FILES_SETTLE_MS`). */
  private readonly fileSignals = new Map<string, { last: number; gap: number }>()
  /** Each listed or held worktree by its path as a watcher spells it, to find the worktree a changed file is in. */
  private places = new Map<string, string>()
  /** The pass an inventory started to read what it listed as being refreshed. */
  private refreshing: Promise<void> | undefined
  /** The watches that say so: each worktree's Git directory, and each repository's own. */
  private summaryWatchesClosed = false
  private summaryWatchGeneration = 0
  private closingWatches: Promise<void> | undefined
  private readonly retiredWatches = new Set<Promise<void>>()
  private watchReleaseFailure: { error: unknown } | undefined
  private readonly summaryWatches = new Map<string, GitDirWatch>()
  /** Who hears the summaries when they change (the windows); without one, an event only marks the worktree. */
  private summaryListener: ((summaries: WorktreeSummary[]) => void) | undefined
  private summariesSaid: readonly string[] | undefined
  /** Who hears each summary as it's read, only those that changed (`followSummaryChanges`). */
  private changesListener: ((changes: WorktreeSummaryChanges) => void) | undefined
  /** Each summary as last said to `changesListener`, and what waits to be said in this turn of the loop. */
  private readonly saidRows = new Map<string, string>()
  private unsaid: UnsaidSummaries | undefined
  /**
   * How the windows take the summaries: `changes` once one has asked for them that way and none the other, so the
   * whole list is no longer said on every change; `whole` once a window of an earlier build asked, which knows only
   * that form.
   */
  private summaryForm: "unasked" | "changes" | "whole" = "unasked"
  private summaryTimer: NodeJS.Timeout | undefined
  private summaryTimerAt = 0
  private lastPullsOf: PullsOf | undefined
  /** Each worktree's Git directory, read once (`indexTime`). */
  private readonly gitDirs = new Map<string, string | null>()
  /** The worktrees as the last full pass listed them: an event reads only what it marked, never the list again. */
  private summaryListed: ThreadWorktree[] = []
  private readonly inventoryPasses = new SharedPasses<WorktreeInventory>()
  /** Each worktree's count of changed files as a `status` last read it, with when and its index's modification time then (`statusOf`). */
  private readonly statuses = new Map<string, StatusHeld>()
  /** Each checkout's own size on disk, measured behind an inventory and said when a round of them is in. */
  private readonly sizes: WorktreeSizes
  private sizesListener: (() => void) | undefined
  /** One `status` of a checkout for everyone who asks while it's read. */
  private readonly shared: CheckoutStatuses
  /** Each receipt as last parsed, by the file's modification time and size then (`receipt`). */
  private readonly receiptsRead = new Map<string, { stamp: string; receipt: Receipt }>()
  /** Answers fixed by the commits they were read at (`CommitAnswers`): landings, counts of commits, a commit's tree. */
  private readonly landings = new CommitAnswers<WorktreeLanding>(() => this.keep())
  private readonly counts = new CommitAnswers<number>(() => this.keep())
  private readonly trees = new CommitAnswers<string>(() => this.keep())
  /** What each agent's move asked of its branch (`wantBranch`), by its conversation. */
  private readonly wanted = new Map<string, WorktreeWanted>()

  /**
   * `inUse` names what is open inside a folder, conversations and shells;
   * `working`, the conversations there that are in the middle of a turn;
   * `environment`, what ends a Thread's running app with its worktree;
   * `setup`, the project's recipe and install records, for what a new
   * checkout takes from the main one;
   * `conversations`, what holds a removal and moves the rest out first.
   * Without it, anything `inUse` names holds a removal.
   * `ledger`, who changed what, once the journal is open: a move takes only
   * the Thread's own changes. Without it nothing is attributed, so nothing
   * moves unless the person brings it.
   * `workingFolders`, every folder a conversation is mid-turn in, read once a
   * summaries pass: `working` for each of a hundred worktrees would read every
   * conversation a hundred times.
   * `looking`, whether a window shows a worktree now and whether a tree watch covers it: a shown worktree's landing is
   * read ahead of the others' when the main checkout moves, and its files' events read its status.
   * `chosenBase`, the branch the person chose for a repository's new Threads in Settings › Projects.
   */
  constructor(
    git: Git,
    root: string,
    threads: ThreadStore,
    inUse: (path: string) => Promise<string[]> = async () => [],
    working: (path: string) => Promise<string[]> = async () => [],
    environment?: ThreadEnvironmentEnd,
    setup?: CheckoutSetup,
    conversations?: CheckoutConversations,
    ledger: () => MoveLedger | undefined = () => undefined,
    workingFolders: () => Promise<string[]> = async () => [],
    pullsVisible: () => boolean = () => true,
    pullsChanged: (repoRoot: string) => Promise<void> = async () => {},
    watch: WatchBackend = childBackend(),
    looking: WorktreeLooking = {},
    chosenBase: (repoRoot: string) => Promise<string | undefined> = async () => undefined,
  ) {
    this.looking = looking
    this.watch = watch
    this.git = git
    this.root = root
    this.threads = threads
    this.inUse = inUse
    this.working = working
    this.environment = environment
    this.setup = setup
    this.borrowing = setup?.borrowing ?? CheckoutBorrowing.inMemory(git)
    this.conversations = conversations
    this.ledger = ledger
    this.pullsChanged = pullsChanged
    this.pullsVisible = pullsVisible
    this.workingFolders = workingFolders
    this.cache = new WorktreeSummaryCache(join(root, "summaries.json"))
    this.sizes = new WorktreeSizes(() => this.sizesListener?.())
    this.shared = checkoutStatuses(git)
    this.starts = new WorktreeStarts(git, Date.now, {
      get: (repoRoot) => this.points.get(repoRoot),
      set: (repoRoot, point) => {
        // Over what was held, so a field a newer build keeps beside these goes back to the file with them.
        this.points.set(repoRoot, { ...this.points.get(repoRoot), ...point })
        this.keep()
      },
    }, chosenBase)
    this.spares = new WorktreeSpares(git, root, (repoRoot) => this.projectFolder(repoRoot), setup)
  }

  /**
   * `from`: `newest` starts a new Thread's branch where `startPoint` says;
   * `head`, at the folder's own commit, for a Thread whose uncommitted
   * changes move along and must apply where they were made; a
   * `WorktreeStart`, where the person chose.
   */
  prepare(conversationId: string, cwd: string, name: string | undefined, from: WorktreeFrom = { kind: "newest" }, onStep?: (step: WorktreeStep) => void, branch?: string): Promise<PreparedWorktree> {
    ConversationIdSchema.parse(conversationId)
    let work = this.pending.get(conversationId)
    if (!work) {
      work = this.create(conversationId, cwd, name, from, onStep, branch)
      this.pending.set(conversationId, work)
      void work.finally(() => this.pending.delete(conversationId)).catch(() => {})
    }
    return work.then((receipt) => ({
      cwd: receipt.cwd,
      path: receipt.path,
      branch: receipt.branch,
      copied: receipt.copied ?? 0,
      tookMs: receipt.tookMs ?? 0,
      spare: receipt.spare ?? false,
    }))
  }

  /**
   * `making`, unless the person chose to start in the project folder while
   * it was being made: then undefined at once, and the worktree is given
   * back once its making finishes.
   */
  async unlessSkipped(conversationId: string, making: Promise<PreparedWorktree>): Promise<PreparedWorktree | undefined> {
    const skipped = new Promise<undefined>((resolve) => this.skips.set(conversationId, () => resolve(undefined)))
    try {
      const made = await Promise.race([making, skipped])
      if (!made) void making.then(() => this.abandon(conversationId), () => this.abandon(conversationId)).catch(() => {})
      return made
    } finally {
      this.skips.delete(conversationId)
    }
  }

  /** Start this conversation in its project folder instead of the worktree being made for it; nothing once it's made. */
  skip(conversationId: string): void {
    this.skips.get(conversationId)?.()
  }

  /**
   * The worktree a move of this conversation's Thread onto its own branch would make from `cwd` as `name` now, with
   * nothing made of it: its folder (the first repository's, by path, in a project folder of several) and the repository
   * it's a worktree of. A move makes this one so long as nothing takes the name first: the first of the same names
   * (`reserveSlug`) with no branch of its name and no folder. Undefined when the Thread has its worktree already, the
   * folder holds no repository or one alone inside it, or every name is taken.
   */
  async plannedCheckout(conversationId: string, cwd: string, name: string | undefined): Promise<PlannedCheckout | undefined> {
    if (this.ofConversation(conversationId)) return undefined
    const source = await realpath(cwd).catch(() => undefined)
    if (!source) return undefined
    const repoRoot = await this.git.output(source, ["rev-parse", "--show-toplevel"]).catch(() => "")
    const found = repoRoot ? { roots: [repoRoot] } : await projectRepositories(this.git, source)
    if ("refusal" in found || !found.roots.length || (!repoRoot && found.roots.length < 2)) return undefined
    const parent = this.projectFolder(repoRoot || source)
    const taken = new Set<string>()
    for (const root of found.roots)
      for (const branch of (await this.git.output(root, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`])).split("\n")) taken.add(branch)
    // The last name a start may take is a random one, which nothing can say beforehand.
    const slug = slugCandidates(worktreeSlug(name)).slice(0, -1).find((candidate) => !taken.has(`${BRANCH_PREFIX}${candidate}`) && !existsSync(join(parent, candidate)))
    if (!slug) return undefined
    const path = join(parent, slug)
    const roots = found.roots.map((root) => ({ root, folder: repoRoot ? path : join(path, relative(source, root)) })).sort((left, right) => left.folder.localeCompare(right.folder))
    const [first] = roots
    return first && { folder: first.folder, repository: first.root, branch: `${BRANCH_PREFIX}${slug}`, repositories: roots.map(({ root, folder }) => ({ root, folder })), ...!repoRoot && { project: path, projectFrom: source } }
  }

  /**
   * A worktree for a fork of `sourceId` that joins the source's Thread. A
   * Thread has one worktree per device, so a Thread that has one already is
   * refused; a repeated request finds its first worktree.
   */
  async prepareFork(sourceId: string, forkId: string, cwd: string, name: string | undefined): Promise<PreparedWorktree> {
    if (!this.pending.has(forkId) && !(await this.receipt(forkId))) {
      const current = this.ofConversation(sourceId)
      if (current) throw new Error(`This Thread already works in its own worktree, on ${current.branch}. Move the Session into that one instead.`)
      const source = await realpath(cwd)
      const folder = await this.git.output(source, ["rev-parse", "--show-toplevel"]).catch(() => "") || source
      // With the journal, a move takes only this Thread's files and checks each one before it writes, so others may work on.
      const busy = this.ledger() ? [] : await this.working(folder)
      if (busy.length)
        throw new Error(`${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working in ${basename(folder)}. Moving its changes would pull files from under ${busy.length === 1 ? "it" : "them"}; continue once ${busy.length === 1 ? "it stops" : "they stop"}.`)
    }
    const wanted = this.wanted.get(sourceId)
    this.wanted.delete(sourceId)
    return this.prepare(forkId, cwd, name, wanted?.base ? { kind: "from", ref: wanted.base } : { kind: "head" }, undefined, wanted?.branch)
  }

  /**
   * The branch an agent's move asked for, and the commit to start it from,
   * checked now and used when the move makes the worktree (`prepareFork`).
   * The branch must be new; a base needs a checkout with nothing
   * uncommitted, since a move carries changes onto the commit they were
   * made on.
   */
  async wantBranch(conversationId: string, cwd: string, wanted: WorktreeWanted): Promise<void> {
    if (!wanted.branch && !wanted.base) {
      this.wanted.delete(conversationId)
      return
    }
    const source = await realpath(cwd)
    const roots = await this.git.output(source, ["rev-parse", "--show-toplevel"]).then((root) => [root], async () => {
      const found = await projectRepositories(this.git, source)
      return "refusal" in found ? [] : found.roots
    })
    if (!roots.length) throw new Error("This folder holds no repository, so there's no branch to make.")
    if (wanted.branch !== undefined) {
      if (!(await this.git.succeeds(source, ["check-ref-format", "--branch", wanted.branch])))
        throw new Error(`${wanted.branch} isn't a name Git allows for a branch.`)
      for (const repoRoot of roots)
        if (await this.hasBranch(repoRoot, wanted.branch))
          throw new Error(`${wanted.branch} already exists in ${basename(repoRoot)}. worktree_move makes a new branch; name another, or start a Fin with agents_start and workspace.branch to work on that one.`)
    }
    if (wanted.base !== undefined) {
      if (roots.length > 1) throw new Error("This project holds several repositories, so its worktree starts each at its own commit; leave base out.")
      if (!(await this.git.succeeds(roots[0]!, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${wanted.base}^{commit}`])))
        throw new Error(`${wanted.base} isn't a commit, branch or tag in ${basename(roots[0]!)}.`)
      // In another Thread's worktree (a Fin started in its Apex's), what's uncommitted is that Thread's: the move
      // carries only this Thread's own, so only those hold it to the commit they were made on.
      const own = (await this.otherThreadWorktree(conversationId, source)) && this.ledger() ? await this.shares(conversationId, source).catch(() => undefined) : undefined
      if (own ? own.thread.files + (own.likely?.files ?? 0) > 0 : await this.git.readOutput(source, ["status", "--porcelain", "--untracked-files=no"]))
        throw new Error(own
          ? "This Session has uncommitted changes of its own in this worktree, which a move carries onto the commit they were made on. Leave base out, or commit them first."
          : "This checkout has uncommitted changes, which a move carries onto the commit they were made on. Leave base out, or commit them first.")
    }
    this.wanted.set(conversationId, wanted)
  }

  /**
   * The branches a new Thread in this folder's project can start from or
   * work on, most recently committed first: local ones, and a remote's that
   * have no local branch of the same name.
   */
  async branches(cwd: string): Promise<WorktreeBranch[]> {
    const repoRoot = await realpath(cwd).then((source) => this.git.output(source, ["rev-parse", "--show-toplevel"])).catch(() => "")
    if (!repoRoot) return []
    const [listed, remotes] = await Promise.all([
      this.git.output(repoRoot, ["for-each-ref", "--sort=-committerdate", `--count=${LISTED_BRANCHES * 2}`, "--format=%(refname)%00%(committerdate:unix)%00%(worktreepath)", "refs/heads", "refs/remotes"]),
      this.git.output(repoRoot, ["remote"]).then((text) => text.split("\n").filter(Boolean)),
    ])
    const local = new Set<string>()
    const found: (WorktreeBranch & { short: string })[] = []
    for (const line of listed.split("\n")) {
      const [ref = "", at = "0", checkedOut = ""] = line.split("\0")
      const entry = { at: Number(at) * 1000, checkedOut: checkedOut || null }
      if (ref.startsWith("refs/heads/")) {
        const name = ref.slice("refs/heads/".length)
        local.add(name)
        found.push({ ...entry, name, short: name, remote: false })
        continue
      }
      const name = ref.slice("refs/remotes/".length)
      const remote = remotes.find((candidate) => name.startsWith(`${candidate}/`))
      const short = remote ? name.slice(remote.length + 1) : name
      if (short !== "HEAD") found.push({ ...entry, name, short, remote: true })
    }
    return found.filter((branch) => !branch.remote || !local.has(branch.short)).slice(0, LISTED_BRANCHES)
      .map(({ name, remote, at, checkedOut }) => ({ name, remote, at, checkedOut }))
  }

  /** Where a new Thread of the repository would start by Mako's own rule, whatever the person chose in Settings › Projects. */
  automaticStart(repoRoot: string): Promise<WorktreeStartPoint> {
    return this.starts.automatic(repoRoot, false)
  }

  /** Whether `ref` names a commit in the repository. */
  resolves(repoRoot: string, ref: string): Promise<boolean> {
    return this.starts.resolves(repoRoot, ref)
  }

  /** Where a new Thread's branch in this folder's project would start now; null outside Git or before a first commit. */
  async startPoint(cwd: string, fetch: boolean): Promise<WorktreeStartPoint | null> {
    const repoRoot = await realpath(cwd).then((source) => this.git.output(source, ["rev-parse", "--show-toplevel"])).catch(() => "")
    if (!repoRoot) return null
    return this.starts.point(repoRoot, fetch).catch(() => null)
  }

  /**
   * Where a fork of `sourceId` works when the source's Thread has its
   * worktree already: the same folder inside it. Undefined when the Thread
   * has none, or when this fork made it, so a repeated request finishes the
   * way the first one started.
   */
  async joinFolder(sourceId: string, forkId: string, cwd: string): Promise<string | undefined> {
    if (this.pending.has(forkId) || (await this.receipt(forkId))) return undefined
    const current = this.threadCheckout(sourceId)
    if (!current) return undefined
    const inside = relative(await realpath(current.project).catch(() => current.project), await realpath(cwd).catch(() => cwd))
    const folder = inside && !inside.startsWith("..") && !isAbsolute(inside) ? join(current.path, inside) : current.path
    return existsSync(folder) ? folder : current.path
  }

  /** A worktree of the Thread this conversation's journal joined, on this device; a project of several repositories has one per repository. */
  ofConversation(conversationId: string): ThreadWorktree | undefined {
    return this.threadCheckout(conversationId)?.worktrees[0]
  }

  /** The checkout of the Thread this conversation's journal joined, on this device. */
  threadCheckout(conversationId: string): ThreadCheckout | undefined {
    const placed = this.threads.journalPlacement(conversationId)
    const place = placed && this.threads.placeOf(placed.thread)
    const worktrees = place ? this.threads.worktrees().filter((worktree) => worktree.thread === place) : []
    const first = worktrees[0]
    if (!first) return undefined
    const path = worktreeCheckout(first)
    const project = path === first.path ? first.repoRoot : first.project
    return { path, project, branch: first.branch, worktrees: worktrees.filter((worktree) => worktreeCheckout(worktree) === path) }
  }

  /**
   * The worktree Mako made for another Thread that `folder` is in, on this device: a Fin started without a workspace
   * of its own edits in its Apex's, a linked worktree like one made outside Mako, which it may move out of onto a
   * branch of its own. Undefined when `folder` is in this conversation's Thread's own, or in none Mako made.
   */
  async otherThreadWorktree(conversationId: string, folder: string): Promise<{ path: string; branch: string; thread: string } | undefined> {
    const own = this.threadCheckout(conversationId)?.path
    const source = await realpath(folder).catch(() => folder)
    for (const worktree of this.threads.worktrees()) {
      const path = worktreeCheckout(worktree)
      if (path === own) continue
      const real = await realpath(path).catch(() => path)
      const inside = relative(real, source)
      if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return { path, branch: worktree.branch, thread: worktree.thread }
    }
    return undefined
  }

  /**
   * Makes `folder`, a Thread's worktree here, ready to take the Thread back from the cloud, before the cloud is asked
   * to let it go: as it is when Git reads it; told where its project is now when the project moved; made again from
   * its project, on `branch`, when the folder itself is gone. `project`: the folder the person chose as the project's
   * now, which must be a clone of `repository`. Throws `ProjectMissingError` when there's no project here to come
   * back into, having changed nothing.
   */
  async readyForReturn(input: { thread: ThreadId; folder: string; branch?: string; repository: string; project?: string }): Promise<void> {
    const { folder, project } = input
    if (project === undefined && (await workingCheckout(this.git, folder))) return
    const row = this.threads.worktrees().find((worktree) => worktree.path === folder)
    const recorded = row?.repoRoot ?? (await this.receiptsList()).find(({ receipt }) => membersOf(receipt).some((member) => member.path === folder))?.receipt.repoRoot
    let repoRoot = recorded
    if (project !== undefined) {
      // The folder as the person named it, or the repository it's inside.
      const up = await this.git.output(project, ["rev-parse", "--show-cdup"]).catch(() => undefined)
      repoRoot = up === undefined ? undefined : up ? resolve(project, up) : project
      const named = repoRoot ? githubRepositoryUrl(await this.git.output(repoRoot, ["remote", "get-url", "origin"]).catch(() => "")) : undefined
      if (!repoRoot || named !== input.repository)
        throw new ProjectMissingError(`${project} isn't a clone of ${input.repository.replace(/^https:\/\//, "")}, the repository this Thread works in. Choose the folder its project is in now.`, { folder, ...recorded && { project: recorded } })
    }
    if (!repoRoot) throw new ProjectMissingError(`Mako has no record of the project ${folder} was made from, so it has nowhere to come back to. It goes on in the cloud.`, { folder })
    if (!(await this.git.succeeds(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])))
      throw new ProjectMissingError(localWords(`Its project, ${repoRoot}, isn't on this Mac anymore: it was moved or deleted. It goes on in the cloud.`), { folder, project: repoRoot })
    await reattachWorktree(this.git, repoRoot, folder, input.branch ?? row?.branch)
    if (row && row.repoRoot !== repoRoot) {
      const inside = relative(row.repoRoot, row.project)
      this.threads.rehomeWorktree(folder, repoRoot, inside && !inside.startsWith("..") ? join(repoRoot, inside) : repoRoot)
    } else if (!row) {
      const base = await this.git.output(folder, ["rev-parse", "HEAD"])
      this.threads.attachWorktree({ path: folder, thread: input.thread, repoRoot, project: repoRoot, branch: input.branch ?? (await this.git.output(folder, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")), base })
    }
    hostLog("worktrees", "a Thread's worktree was made ready to come back into", { folder, repoRoot, ...recorded !== repoRoot && { was: recorded ?? "unrecorded" } })
  }

  /**
   * The folder's project is about to start a worktree Thread (its composer
   * is set to Worktree): keep spares of it ready. Returns once recorded.
   * A project folder of several repositories keeps spares of all of them together.
   */
  async want(cwd: string): Promise<void> {
    const folder = await realpath(cwd)
    const repoRoot = await this.git.output(folder, ["rev-parse", "--show-toplevel"]).catch(() => "")
    if (repoRoot) {
      if (await this.git.succeeds(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])) await this.spares.want(this.homeOf(repoRoot))
      return
    }
    const found = await projectRepositories(this.git, folder)
    if ("roots" in found && (await Promise.all(found.roots.map((root) => this.git.succeeds(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])))).every(Boolean))
      await this.spares.want(this.homeOf(folder))
  }

  /**
   * At start and every hour: give back spares that are idle or were half-made
   * by a host that died, make again those a project still wants that are
   * gone or no longer fit its lockfile, and empty the trash; finish or undo
   * moves a host was making when it died; drop move backups past 14 days.
   */
  async tidy(): Promise<void> {
    await this.spares.sweep()
    await this.spares.refill()
    const repositories = new Set<string>()
    for (const { id, receipt } of await this.receiptsList()) {
      for (const member of membersOf(receipt)) repositories.add(member.repoRoot)
      if (receipt.untold?.length) this.untold.set(id, receipt.untold)
      if (receipt.moving && "id" in receipt.moving) {
        await this.finishCutShort(receipt).catch((error: Error) => hostLog("worktree-move", "a move cut short couldn't be finished", { conversation: id, error: error.message }))
        continue
      }
      const plan = receipt.moved && "id" in receipt.moved && receipt.moved.id ? await this.readPlan(receipt.moved.id).catch(() => undefined) : undefined
      const adjusting = plan?.adjusting
      if (!adjusting) continue
      // An agent's own call that a restart cut short: it never heard the result, so it hears it as its next turn begins.
      const resumed = adjusting.by === "agent" ? { by: "agent" as const, tell: true } : {}
      const finished = adjusting.kind === "bring" ? this.bringStayed(id, { ...resumed, ...adjusting.paths && { only: adjusting.paths } }) : this.putBack(id, adjusting.paths, resumed)
      await finished.then(
        () => hostLog("worktree-move", "finished an adjustment cut short", { conversation: id, kind: adjusting.kind }),
        (error: Error) => hostLog("worktree-move", "an adjustment cut short couldn't be finished", { conversation: id, kind: adjusting.kind, error: error.message }),
      )
    }
    for (const repoRoot of repositories) await pruneBackups(this.git, repoRoot).catch(() => 0)
  }

  /** Resolves once spares being made and outputs being cloned are in place. */
  async settled(): Promise<void> {
    await Promise.all([...this.wanting, ...this.carrying.values()])
    await this.spares.settled()
    await this.refreshing
    await this.sizes.settled()
    await Promise.all(this.retiredWatches)
    if (this.watchReleaseFailure) throw this.watchReleaseFailure.error
  }

  /**
   * Every worktree with what decides whether it can go: uncommitted files, what runs there, whether its branch landed,
   * and its own size. Whoever asks during one shares the next. The list is drawn from what's held and asks Git
   * nothing: a worktree's changed files are those its summary counted, while nothing has signalled a change since
   * (`statusCurrent`); its landing is kept by its commits; what else holds it is read from its files. One with no
   * count that still stands is listed with the last one and `refreshing`, and read behind the answer, as its size is
   * measured behind it (`WorktreeSizes`); `followSizes` hears when either is in. A `status` and a `du` of every
   * worktree used to come before any answer. What the list offers isn't what decides: a removal reads the checkout
   * as it is then (`removal`, `remove`).
   */
  inventory(): Promise<WorktreeInventory> {
    return this.inventoryPasses.ask(() => this.readInventory())
  }

  /** Hears that what an inventory was waiting on is in, sizes measured or statuses read: the next inventory has them. */
  followSizes(listener: () => void): void {
    this.sizesListener = listener
  }

  private async readInventory(): Promise<WorktreeInventory> {
    const [{ worktrees }] = await Promise.all([this.list(), this.remember()])
    const attached = new Set(worktrees.map((worktree) => worktree.path))
    // Starts that failed or were cut short after their worktree was made: no Thread lists these.
    const loose = new Map<string, Omit<WorktreeDetail, "changes" | "held" | "landing" | "users" | "bytes">>()
    for (const { receipt, createdAt } of await this.receiptsList()) {
      if (receipt.state !== "ready") continue
      for (const { path, repoRoot, base } of membersOf(receipt)) {
        if (attached.has(path) || !existsSync(join(path, ".git"))) continue
        loose.set(path, { path, thread: null, repoRoot, project: receipt.source, branch: receipt.branch, base, createdAt })
      }
    }
    const skipped = new Map<string, Promise<string[]>>()
    const outputsOf = (repoRoot: string) => {
      let names = skipped.get(repoRoot)
      if (!names) skipped.set(repoRoot, names = (this.setup?.recipe(repoRoot) ?? Promise.resolve(undefined)).then(outputNames, () => []))
      return names
    }
    const facts = new Map<string, Promise<RepositoryFacts | undefined>>()
    const factsOf = (repoRoot: string) => {
      let known = facts.get(repoRoot)
      if (!known) facts.set(repoRoot, known = this.repositoryFacts(repoRoot, false, worktrees).catch(() => undefined))
      return known
    }
    const now = Date.now()
    let behind = false
    const detailed = await mapLimit([...worktrees, ...loose.values()], 4, async (worktree): Promise<WorktreeDetail> => {
      const [counted, landing, users, names] = await Promise.all([
        attached.has(worktree.path) ? this.changesHeld(worktree.path, now) : this.shared.read(worktree.path, { fresh: true }).then((status) => ({ changes: status ? status.split("\n").length : 0, refreshing: false }), () => ({ changes: 0, refreshing: false })),
        factsOf(worktree.repoRoot).then((known) => this.landing(worktree, known)),
        this.inUse(worktree.path),
        outputsOf(worktree.repoRoot),
      ])
      if (counted.refreshing) {
        behind = true
        this.mark(worktree.path, "status")
      }
      const held = await removalBlocker(this.git, worktree.path, counted.changes ? "changed" : "") ?? null
      return { ...worktree, changes: counted.changes, held, landing, users, bytes: this.sizes.of(worktree.path, await this.sizeStamp(worktree.path), names), ...counted.refreshing && { refreshing: true as const } }
    })
    const spares = await this.spares.recorded()
    const spareBytes = await Promise.all(spares.map(async (spare) => this.sizes.of(spare.path, `${spare.createdAt}:${spare.state}`, await outputsOf(spare.repoRoot))))
    this.sizes.keep(new Set([...detailed.map((worktree) => worktree.path), ...spares.map((spare) => spare.path)]))
    this.sizes.begin()
    // What was listed as being refreshed is read by a pass behind the answer, which reads only what's marked or moved.
    if (behind) {
      const reading: Promise<void> = this.summaries().then(() => this.sizesListener?.(), () => undefined).finally(() => {
        if (this.refreshing === reading) this.refreshing = undefined
      })
      this.refreshing = reading
    }
    const known = spareBytes.filter((bytes) => bytes !== null)
    return { worktrees: detailed, spares: { count: spares.length, bytes: known.length ? known.reduce((sum, bytes) => sum + bytes, 0) : null } }
  }

  /**
   * A worktree's count of changed files for the list, from what's held: the count its summary read, while its index
   * is as it was then and nothing has signalled a change since. Else the last count known, `refreshing`.
   */
  private async changesHeld(path: string, now: number): Promise<{ changes: number; refreshing: boolean }> {
    const known = this.statuses.get(path)
    if (known && !this.staleSummaries.has(path) && !this.unseen.has(path) && await this.statusCurrent(path, now)) return { changes: await known.changes, refreshing: false }
    return { changes: this.heldSummaries.get(path)?.summary.changes ?? 0, refreshing: true }
  }

  /** What a checkout's size was measured at: its HEAD and when its index was written, which every commit, checkout and staging moves. */
  private async sizeStamp(path: string): Promise<string> {
    const gitDir = await worktreeGitDir(path)
    return `${await this.indexTime(path)}:${gitDir ? await gitFileText(join(gitDir, "HEAD")) ?? "" : ""}`
  }

  /**
   * Whether the branch's work is in the branch the main checkout is on. A
   * merge, a fast-forward and a rebase leave the branch's commits reachable;
   * a squash doesn't, so a branch whose merge would leave the target's tree
   * as it is has landed too.
   */
  private async landing(worktree: Pick<ThreadWorktree, "repoRoot" | "branch" | "base">, known?: RepositoryFacts, idle = false, ahead?: number, later?: LaterLanding): Promise<WorktreeLanding> {
    const into = known ? known.into : await this.git.readOutput(worktree.repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
    if (!into) return { kind: "unknown" }
    const tip = known?.tips.get(worktree.branch)
    const target = known?.tips.get(into)
    // Whether a branch landed is fixed by the commits it's asked at: asked again only once one of them moves.
    if (!tip || !target) return this.readLanding(worktree, into, idle)
    const key = `landing\0${worktree.repoRoot}\0${worktree.base}\0${tip}\0${into}\0${target}`
    const at: LandingAt = { repoRoot: worktree.repoRoot, base: worktree.base, into, tip, target }
    // A read that failed (a timeout under load) says nothing of the commits: asked again next time.
    const decided = (landing: WorktreeLanding) => landing.kind !== "unknown"
    if (!later || this.landings.has(key)) return this.landings.ask(key, async () => await this.countedLanding(at, ahead, idle) ?? this.mergedLanding(at, idle), decided)
    const counted = await this.countedLanding(at, ahead, idle)
    if (counted) return this.landings.ask(key, async () => counted, decided)
    // Only a merge in memory can tell, and nobody is looking at this one: it takes its turn after the pass.
    later.read(tip, () => this.landings.ask(key, () => this.mergedLanding(at, idle), decided))
    return later.previous.kind === "merged" ? later.previous : { kind: "open", into, commits: await this.commitsSince(at, idle).catch(() => 0) }
  }

  /** Commits on the branch since it started: fixed by the two commits, so counted once. */
  private commitsSince(at: LandingAt, idle: boolean): Promise<number> {
    return this.counts.ask(`commits\0${at.repoRoot}\0${at.base}\0${at.tip}`, () =>
      (idle ? this.git.idleOutput(at.repoRoot, ["rev-list", "--count", `${at.base}..${at.tip}`]) : this.git.readOutput(at.repoRoot, ["rev-list", "--count", `${at.base}..${at.tip}`])).then(Number))
  }

  /**
   * What counting commits says of a landing: nothing committed, or every commit reachable from the target (`ahead`
   * is 0: a merge, a fast-forward, a rebase onto it). Undefined when only a merge in memory can tell a squash from
   * work still open.
   */
  private async countedLanding(at: LandingAt, ahead: number | undefined, idle: boolean): Promise<WorktreeLanding | undefined> {
    try {
      const commits = await this.commitsSince(at, idle)
      if (commits === 0) return { kind: "empty" }
      const reachable = ahead !== undefined
        ? ahead === 0
        : await (idle ? this.git.idleOutput(at.repoRoot, ["merge-base", "--is-ancestor", at.tip, at.target]) : this.git.readOutput(at.repoRoot, ["merge-base", "--is-ancestor", at.tip, at.target])).then(() => true, () => false)
      if (reachable) return { kind: "merged", into: at.into }
      // A squash merge shows only through an in-memory merge, which older Git can't do.
      return await this.git.mergesWithoutCheckout() ? undefined : { kind: "open", into: at.into, commits }
    } catch {
      return { kind: "unknown" }
    }
  }

  /**
   * A squash's landing: merging the branch would leave the target's tree as it is. The merge is made in memory, as
   * a read (it takes a read slot, an idle one in a pass, and no lock), and the target's tree is read once per commit.
   */
  private async mergedLanding(at: LandingAt, idle: boolean): Promise<WorktreeLanding> {
    try {
      const [commits, merged, target] = await Promise.all([
        this.commitsSince(at, idle),
        this.git.run({ cwd: at.repoRoot, args: ["merge-tree", "--write-tree", at.target, at.tip], read: true, idle, maxBytes: 16 * 1024 * 1024 }).then((result) => result.stdout.toString("utf8").trim(), () => ""),
        this.trees.ask(`tree\0${at.repoRoot}\0${at.target}`, () => (idle ? this.git.idleOutput(at.repoRoot, ["rev-parse", `${at.target}^{tree}`]) : this.git.readOutput(at.repoRoot, ["rev-parse", `${at.target}^{tree}`]))),
      ])
      return merged === target ? { kind: "merged", into: at.into } : { kind: "open", into: at.into, commits }
    } catch {
      return { kind: "unknown" }
    }
  }

  /** A landing by the branches' names, for a repository whose files don't say its commits: asked of Git each time. */
  private async readLanding(worktree: Pick<ThreadWorktree, "repoRoot" | "branch" | "base">, into: string, idle = false): Promise<WorktreeLanding> {
    const read = (args: string[]) => (idle ? this.git.idleOutput(worktree.repoRoot, args) : this.git.readOutput(worktree.repoRoot, args))
    try {
      const commits = Number(await read(["rev-list", "--count", `${worktree.base}..${worktree.branch}`]))
      if (commits === 0) return { kind: "empty" }
      if (await read(["merge-base", "--is-ancestor", worktree.branch, into]).then(() => true, () => false)) return { kind: "merged", into }
      // A squash merge shows only through an in-memory merge, which older Git can't do.
      if (!await this.git.mergesWithoutCheckout()) return { kind: "open", into, commits }
      const [merged, target] = await Promise.all([
        this.git.run({ cwd: worktree.repoRoot, args: ["merge-tree", "--write-tree", into, worktree.branch], read: true, idle, maxBytes: 16 * 1024 * 1024 }).then((result) => result.stdout.toString("utf8").trim(), () => ""),
        read(["rev-parse", `${into}^{tree}`]),
      ])
      return merged === target ? { kind: "merged", into } : { kind: "open", into, commits }
    } catch {
      return { kind: "unknown" }
    }
  }

  /** Reads in what the last host held (`cache`), once: nothing read since then is replaced. */
  private remember(): Promise<void> {
    return this.remembered ??= this.cache.load().then((memory) => {
      this.landings.restore(memory.landings)
      this.counts.restore(memory.counts)
      this.trees.restore(memory.trees)
      for (const [path, held] of memory.worktrees) {
        if (this.heldSummaries.has(path)) continue
        this.heldSummaries.set(path, held)
        this.unchecked.add(path)
        // Read by a host that has stopped: nothing heard what changed there since.
        this.unseen.add(path)
        this.places.set(plainPath(path), path)
        if (!this.statuses.has(path)) this.statuses.set(path, { at: held.statusAt, index: held.index, changes: Promise.resolve(held.summary.changes) })
      }
      for (const [repoRoot, pulls] of memory.pulls) if (!this.pullsRead.has(repoRoot)) this.pullsRead.set(repoRoot, pulls)
      for (const [repoRoot, point] of memory.points) if (!this.points.has(repoRoot)) this.points.set(repoRoot, point)
    })
  }

  /** What's held changed: the file follows soon. */
  private keep(): void {
    this.cache.changed((): SummaryMemory => ({ landings: this.landings.known, counts: this.counts.known, trees: this.trees.known, worktrees: this.heldSummaries, pulls: this.pullsRead, points: this.points }))
  }

  /**
   * How every worktree's branch stands: commits main doesn't have, uncommitted
   * files, whether it landed, and its pull request. `pullsOf` lists a
   * repository's pull requests, newest first, and is asked at most once a
   * minute per repository.
   *
   * This runs a pass and answers when it ends: callers share passes, so one asking while a pass runs gets the next
   * one, which starts once that ends and serves everyone who asked meanwhile, and at most one pass runs. A pass asks
   * Git only of what moved since it was last read (`readListed`). A window doesn't wait for one: it takes what's held
   * (`heldNow`) and hears the rest as it's read.
   */
  summaries(pullsOf?: PullsOf): Promise<WorktreeSummary[]> {
    if (pullsOf) this.lastPullsOf = pullsOf
    return this.summaryPasses.ask(() => this.readSummaries(pullsOf ?? this.lastPullsOf))
  }

  /**
   * Every summary held now, at once, and the worktrees still being read: those never read, and those whose summary
   * the last host left and this one hasn't looked at yet. A pass starts behind the answer and says each as it's read
   * (`followSummaryChanges`). Waiting for the pass instead, a window had no marks in its rail for as long as the
   * first pass after a start took, 12 to 31 minutes in one log. `form` is how the asker takes what follows: `changes`,
   * or the `whole` list a window of an earlier build knows. `focus`: the window asks because it came to the front
   * (`look`).
   */
  async heldNow(pullsOf?: PullsOf, form: "whole" | "changes" = "whole", focus = false): Promise<WorktreeSummariesHeld> {
    if (pullsOf) this.lastPullsOf = pullsOf
    if (form === "whole") this.summaryForm = "whole"
    else if (this.summaryForm === "unasked") this.summaryForm = "changes"
    await this.remember()
    this.look(focus)
    const rows = this.threads.worktrees()
    const summaries = rows.flatMap((row) => this.heldSummaries.get(row.path)?.summary ?? [])
    const reading = rows.flatMap((row) => (!this.heldSummaries.has(row.path) || this.unchecked.has(row.path) ? [row.path] : []))
    void this.summaries(pullsOf).catch(() => undefined)
    return { summaries, reading }
  }

  /**
   * Hears every worktree's summaries, the whole list, whenever one changes: the form windows knew before
   * `followSummaryChanges`, said until a window asks for changes and none for the whole list (`heldNow`).
   */
  followSummaries(listener: (summaries: WorktreeSummary[]) => void): void {
    this.summaryListener = listener
    this.summaryWatchesClosed = false
    this.closingWatches = undefined
    this.cache.resume()
  }

  /**
   * Hears each summary as it's read, when it isn't what was last said, and the worktrees that went: read on each
   * worktree's own events, and by the host's pass. What's read in one turn of the loop is said together.
   */
  followSummaryChanges(listener: (changes: WorktreeSummaryChanges) => void): void {
    this.changesListener = listener
    this.summaryWatchesClosed = false
    this.closingWatches = undefined
    this.cache.resume()
  }

  /** A turn in `folder` ended: what it left there is read again. */
  turnEnded(folder: string): void {
    for (const path of this.heldSummaries.keys()) if (folder === path || folder.startsWith(`${path}/`)) this.summaryStale([path])
  }

  /**
   * A tool call reported writing these files, or running a command in these folders (`mako:tool-effects`): the
   * worktrees they're in have their status read once the writes settle (`FILES_SETTLE_MS`), a window showing them or not.
   */
  wrote(paths: Iterable<string>): void {
    const found = new Set<string>()
    for (const path of paths) {
      const worktree = this.worktreeAt(path)
      if (worktree) found.add(worktree)
    }
    for (const path of found) this.filesChanged(path)
  }

  /**
   * A tree watch the host already keeps heard files change under `root` (`WatchedTrees`): `paths`, absolute, or
   * undefined when anything under it may have. A worktree a window shows has its status read once the changes settle.
   * One nobody shows is only marked (`unseen`), and read when a window does show it: no status is read for a row
   * nobody sees, and no watch is started here for any worktree.
   */
  filesHeard(root: string, paths: readonly string[] | undefined): void {
    const found = new Set<string>()
    if (paths) for (const path of paths) {
      const worktree = this.worktreeAt(path)
      if (worktree) found.add(worktree)
    } else {
      const within = this.worktreeAt(root)
      if (within) found.add(within)
      else for (const [plain, path] of this.places) if (plain.startsWith(`${root}/`)) found.add(path)
    }
    for (const path of found) {
      if (this.shows(path)) this.filesChanged(path)
      else {
        this.unseen.add(path)
        this.shared.touched(path)
      }
    }
  }

  /** The worktree a path is in, as a watcher or a tool spells it; undefined outside every one, and for Git's own folder. */
  private worktreeAt(path: string): string | undefined {
    for (let folder = plainPath(path); ; folder = dirname(folder)) {
      const found = this.places.get(folder)
      if (found) return found
      if (dirname(folder) === folder) return undefined
    }
  }

  private filesChanged(path: string): void {
    const now = Date.now()
    const known = this.fileSignals.get(path)
    // Quiet for as long as the longest wait: the next write is read as soon as it settles.
    this.fileSignals.set(path, { last: now, gap: known && now - known.last < FILES_GAP_MAX_MS ? known.gap : FILES_SETTLE_MS })
    this.summaryStale([path], FILES_SETTLE_MS, "files")
  }

  /** Whether a window shows the worktree's row or has it open in a tab, whose watcher then keeps its status (`Repository.watched`). */
  private shows(path: string): boolean {
    return this.looking.shown?.(path) === true || this.git.knownRepository(path)?.watched === true
  }

  /**
   * How long a worktree's status answers with nothing heard. For good while a tree watch covers it and nothing was
   * heard there unseen: an edit would have been said. Else the hour's backstop.
   */
  private backstop(path: string): number {
    return this.looking.heard?.(path) === true && !this.unseen.has(path) ? Infinity : statusBackstop(path)
  }

  /**
   * A window asked, coming to focus or not: the worktrees it shows whose files changed unseen are read, and on focus
   * those no tree watch covers, each at most every `FOCUS_GAP_MS`, since nothing else would say an editor changed a
   * file there. The pass behind the answer reads them.
   */
  private look(focus: boolean): void {
    const now = Date.now()
    for (const { path } of this.summaryListed) {
      if (!this.shows(path)) continue
      const uncovered = focus && this.looking.heard?.(path) !== true && now - (this.statuses.get(path)?.at ?? 0) > FOCUS_GAP_MS
      if (this.unseen.has(path) || uncovered) this.mark(path, "status")
    }
  }

  /** Marks a worktree as changed since its summary was read; the most an event asks for stands. */
  private mark(path: string, kind: StaleKind): void {
    const marked = this.staleSummaries.get(path)
    if (!marked || STALE_RANK[kind] > STALE_RANK[marked]) this.staleSummaries.set(path, kind)
    // Its files, index or HEAD may have moved: the status held for those who only show it no longer stands.
    if (kind !== "refs") this.shared.touched(path)
  }

  private summaryStale(paths: Iterable<string>, after = SUMMARY_SETTLE_MS, kind: StaleKind = "status"): void {
    for (const path of paths) this.mark(path, kind)
    if (!this.summaryListener && !this.changesListener) return
    // One timer, at the soonest any event asks: a turn's end doesn't wait behind an index's half minute.
    const at = performance.now() + after
    if (this.summaryTimer && this.summaryTimerAt <= at) return
    clearTimeout(this.summaryTimer)
    this.summaryTimerAt = at
    this.summaryTimer = setTimeout(() => {
      this.summaryTimer = undefined
      void this.summaryPasses.ask(() => this.readStale()).catch(() => undefined)
    }, after)
    this.summaryTimer.unref()
  }

  /**
   * What events marked, read again from the last full pass's list; said if it changed. One whose files may have
   * changed is read at most every `SUMMARY_GAP_MS`; one marked only because a shared ref moved is looked at at once,
   * which reads its commits' files and asks Git nothing unless they moved.
   */
  private async readStale(): Promise<WorktreeSummary[]> {
    const now = Date.now()
    const dueAt = (path: string) => {
      const kind = this.staleSummaries.get(path)
      const read = this.heldSummaries.get(path)?.at ?? 0
      const files = kind === "files" ? this.fileSignals.get(path) : undefined
      // Writes still coming are waited out, and read no sooner after the last read than their wait says.
      if (files) return Math.max(files.last + FILES_SETTLE_MS, read + files.gap)
      return read + (kind === "refs" ? 0 : kind === "index" ? SUMMARY_INDEX_GAP_MS : SUMMARY_GAP_MS)
    }
    const due = this.summaryListed.filter((worktree) => this.staleSummaries.has(worktree.path) && now >= dueAt(worktree.path))
    const reading = new Set(due.map((worktree) => worktree.path))
    for (const path of reading) {
      const files = this.staleSummaries.get(path) === "files" ? this.fileSignals.get(path) : undefined
      if (files) files.gap = Math.min(files.gap * 2, FILES_GAP_MAX_MS)
    }
    const listed = new Set(this.summaryListed.map((worktree) => worktree.path))
    let soonest: number | undefined
    for (const path of this.staleSummaries.keys()) {
      if (!listed.has(path)) this.staleSummaries.delete(path)
      else if (!reading.has(path)) soonest = Math.min(soonest ?? Infinity, dueAt(path) - now)
    }
    await this.readListed(this.summaryListed, due, this.lastPullsOf, () => false)
    // Asked again once the first of them is due, not a whole gap from now.
    if (soonest !== undefined) this.summaryStale([], Math.max(SUMMARY_SETTLE_MS, soonest))
    const summaries = this.listedSummaries()
    await this.sayIfChanged(summaries)
    return summaries
  }

  /** The summaries held for the worktrees the last full pass listed, in its order. */
  private listedSummaries(): WorktreeSummary[] {
    return this.summaryListed.flatMap((worktree) => this.heldSummaries.get(worktree.path)?.summary ?? [])
  }

  /** The whole list, to a listener that takes it that way, when any of it changed. */
  private async sayIfChanged(summaries: WorktreeSummary[]): Promise<void> {
    if (!this.summaryListener || this.summaryForm === "changes") return
    const { said, changed } = await inSlices(summaryRows(summaries, this.summariesSaid))
    this.summariesSaid = said
    if (changed) this.summaryListener(summaries)
  }

  /** Holds a worktree's summary as just read, and says it if it isn't what was last said. */
  private hold(path: string, summary: WorktreeSummary, refs: string): void {
    const status = this.statuses.get(path)
    // Over what was held, so a field a newer build keeps beside these goes back to the file with them.
    this.heldSummaries.set(path, { ...this.heldSummaries.get(path), summary, at: Date.now(), statusAt: status?.at ?? 0, index: status?.index ?? 0, refs })
    this.unchecked.delete(path)
    this.say(summary)
    this.keep()
  }

  private say(summary: WorktreeSummary): void {
    const row = JSON.stringify(summary)
    if (this.saidRows.get(summary.path) === row) return
    this.saidRows.set(summary.path, row)
    const unsaid = this.sayingSoon()
    unsaid.removed.delete(summary.path)
    unsaid.changed.set(summary.path, summary)
  }

  /** What changed in this turn of the loop, said together at its end. */
  private sayingSoon(): UnsaidSummaries {
    if (this.unsaid) return this.unsaid
    const unsaid: UnsaidSummaries = this.unsaid = { changed: new Map(), removed: new Set() }
    queueMicrotask(() => {
      if (this.unsaid === unsaid) this.unsaid = undefined
      this.changesListener?.({ changed: [...unsaid.changed.values()], removed: [...unsaid.removed] })
    })
    return unsaid
  }

  /** Landings put off by a pass, read one at a time, `LANDING_SPREAD_MS` apart; resolves once none waits. */
  private laterLandings(): Promise<void> {
    if (!this.landingsLater.size) return this.landingDrain ?? Promise.resolve()
    return this.landingDrain ??= (async () => {
      for (let first = true; ; first = false) {
        const [path, job] = this.landingsLater.entries().next().value ?? []
        if (path === undefined || !job) return
        this.landingsLater.delete(path)
        if (this.summaryWatchesClosed) continue
        if (!first) await delay(LANDING_SPREAD_MS)
        const landing = await job.read().catch(() => undefined)
        const held = this.heldSummaries.get(path)
        // Read at commits that moved since: the read that follows them has its own answer. One Git couldn't make
        // leaves the summary marked as waiting, so the next pass asks again.
        if (!landing || landing.kind === "unknown" || !held || held.refs !== job.awaiting) continue
        const pull = held.summary.pull
        const squashedThere = landing.kind === "open" && pull?.state === "merged" && pull.head === job.tip
        this.hold(path, { ...held.summary, landing: squashedThere ? { kind: "merged", into: landing.into } : landing }, job.refs)
      }
    })().finally(() => {
      this.landingDrain = undefined
    })
  }

  /** Watches each listed worktree's Git directory and each repository's, and lets go of the rest. */
  private async watchSummaries(worktrees: readonly ThreadWorktree[]): Promise<void> {
    if (this.summaryWatchesClosed) return
    const generation = this.summaryWatchGeneration
    const wanted = new Map<string, { gitDir: () => Promise<string | undefined>; paths: () => string[]; kind: StaleKind; markers: readonly string[]; roots: readonly string[] }>()
    const shared = new Map<string, { paths: string[]; roots: Set<string>; branches: Set<string> }>()
    for (const worktree of worktrees) {
      const own = () => [worktree.path]
      wanted.set(worktree.path, { gitDir: () => worktreeGitDir(worktree.path), paths: own, kind: "status", markers: HEAD_MARKER, roots: [] })
      wanted.set(`index\0${worktree.path}`, { gitDir: () => worktreeGitDir(worktree.path), paths: own, kind: "index", markers: INDEX_MARKER, roots: [] })
      const common = commonDirOf(worktree.repoRoot)
      let group = shared.get(common)
      if (!group) shared.set(common, group = { paths: [], roots: new Set(), branches: new Set() })
      group.paths.push(worktree.path)
      group.roots.add(worktree.repoRoot)
      group.branches.add(worktree.branch)
      const current = await worktreeBranch(worktree.path)
      if (current) group.branches.add(current)
    }
    for (const [common, group] of shared) {
      const remotes = new Set(["origin", ...await readdir(join(common, "refs", "remotes")).catch(() => [])])
      const local = [...new Set([join("refs", "heads"), ...[...group.branches].map(branch => dirname(join("refs", "heads", branch)))])]
      const remote = [...new Set([...REF_MARKERS, ...[...remotes].flatMap(name => [join("refs", "remotes", name), ...[...group.branches].map(branch => dirname(join("refs", "remotes", name, branch)))])])]
      // Local moves stale summaries, but only remote-ref changes invalidate GitHub's five-minute list.
      for (const [kind, markers, roots] of [["local", local, []], ["remote", remote, [...group.roots]]] as const) {
        const key = `${kind}\0${common}\0${[...markers, ...group.paths].sort().join("\0")}`
        // A ref every checkout shares changes no worktree's files: its worktrees' commits are looked at, no status read.
        wanted.set(key, { gitDir: async () => common, paths: () => group.paths, kind: "refs", markers, roots })
      }
    }
    for (const [key, watch] of this.summaryWatches) if (!wanted.has(key)) {
      this.retireWatch(watch)
      this.summaryWatches.delete(key)
    }
    await Promise.all([...wanted].map(async ([key, { gitDir: locate, paths, kind, markers, roots }]) => {
      if (this.summaryWatches.has(key)) return
      const gitDir = await locate()
      if (this.summaryWatchesClosed || generation !== this.summaryWatchGeneration) return
      if (!gitDir || this.summaryWatches.has(key)) return
      const invalidate = () => {
        for (const repoRoot of roots) this.invalidatePulls(repoRoot)
        this.summaryStale(paths(), SUMMARY_SETTLE_MS, kind)
      }
      let reachedReady = false
      const retire = () => {
        if (this.summaryWatches.get(key) !== watch) return
        this.summaryWatches.delete(key)
        this.retireWatch(watch)
        if (!this.summaryWatchesClosed && generation === this.summaryWatchGeneration) {
          if (reachedReady) invalidate()
          else this.summaryStale(paths(), SUMMARY_SETTLE_MS, kind)
        }
      }
      // An injected port may report loss during subscribe, before the proxy has been published in the map.
      const watch = watchGitMarkers(gitDir, invalidate, markers, this.watch, () => queueMicrotask(retire))
      this.summaryWatches.set(key, watch)
      let timedOut = false
      const ready = watch.ready.then(() => {
        reachedReady = true
        // A slow close in the child can hold its next subscribe. Keep that late owner and reread what it missed.
        if (timedOut && this.summaryWatches.get(key) === watch && !this.summaryWatchesClosed && generation === this.summaryWatchGeneration)
          invalidate()
      }, retire)
      let deadline: NodeJS.Timeout | undefined
      try {
        await Promise.race([ready, new Promise<void>((resolve) => {
          deadline = setTimeout(() => {
            timedOut = true
            if (this.summaryWatches.get(key) === watch && !this.summaryWatchesClosed && generation === this.summaryWatchGeneration)
              invalidate()
            resolve()
          }, 2_000)
        })])
      } finally { clearTimeout(deadline) }
    }))
  }

  /** When a worktree's index was last written; 0 when it has none to read. */
  private async indexTime(path: string): Promise<number> {
    let gitDir = this.gitDirs.get(path)
    if (gitDir === undefined) {
      gitDir = await worktreeGitDir(path) ?? null
      this.gitDirs.set(path, gitDir)
    }
    return gitDir ? stat(join(gitDir, "index")).then(({ mtimeMs }) => mtimeMs, () => 0) : 0
  }

  private retireWatch(watch: GitDirWatch): void {
    const released = (async () => {
      try { await watch.close() } catch (error) { this.watchReleaseFailure ??= { error } }
    })()
    this.retiredWatches.add(released)
    void released.then(() => this.retiredWatches.delete(released))
  }

  /** Refuses late rearming immediately; completion joins every proxy release. */
  closeSummaries(): Promise<void> {
    this.summaryWatchesClosed = true
    this.summaryWatchGeneration++
    clearTimeout(this.summaryTimer)
    this.summaryTimer = undefined
    for (const watch of this.summaryWatches.values()) this.retireWatch(watch)
    this.summaryWatches.clear()
    this.summaryListener = undefined
    this.changesListener = undefined
    this.landingsLater.clear()
    const saved = this.cache.stop()
    return this.closingWatches ??= (async () => {
      await saved
      await Promise.all(this.retiredWatches)
      if (this.watchReleaseFailure) throw this.watchReleaseFailure.error
    })()
  }

  /**
   * One pass: the worktrees listed, each repository's facts read from its files, and each worktree asked of Git only
   * where what it was read at moved (`readListed`). One that finds everything as it was starts no process.
   */
  private async readSummaries(pullsOf: PullsOf | undefined): Promise<WorktreeSummary[]> {
    const [{ worktrees }] = await Promise.all([this.list(), this.remember()])
    const listed = new Set(worktrees.map((worktree) => worktree.path))
    for (const path of this.statuses.keys()) if (!listed.has(path)) this.statuses.delete(path)
    const working = await this.workingFolders().catch(() => [])
    const atWork = ({ path }: ThreadWorktree) => working.some((folder) => folder === path || folder === dirname(path) || folder.startsWith(`${path}/`))
    await this.watchSummaries(worktrees)
    this.summaryListed = worktrees
    this.places = new Map(worktrees.map((worktree) => [plainPath(worktree.path), worktree.path]))
    this.shared.follow(listed)
    for (const path of this.unseen) if (!listed.has(path)) this.unseen.delete(path)
    for (const path of this.fileSignals.keys()) if (!listed.has(path)) this.fileSignals.delete(path)
    let gone = false
    for (const path of this.heldSummaries.keys()) if (!listed.has(path)) {
      this.heldSummaries.delete(path)
      this.unchecked.delete(path)
      gone = true
    }
    for (const path of this.gitDirs.keys()) if (!listed.has(path)) this.gitDirs.delete(path)
    for (const path of this.saidRows.keys()) if (!listed.has(path)) {
      this.saidRows.delete(path)
      const unsaid = this.sayingSoon()
      unsaid.changed.delete(path)
      unsaid.removed.add(path)
    }
    if (gone) this.keep()
    await this.readListed(worktrees, worktrees, pullsOf, atWork)
    const summaries = this.listedSummaries()
    await this.sayIfChanged(summaries)
    return summaries
  }

  /**
   * Reads `targets`, some of the worktrees in `all`, each only as far as it moved. A summary stands while the commits
   * it was read at are the ones its files name now (`summaryRefs`) and its `status` still answers (`statusCurrent`):
   * such a worktree costs a few reads of small files. One whose commits moved is counted again, with every other of
   * its repository in one process (`countBranches`); one whose index or HEAD moved, or that an event marked, has its
   * `status` read too. Each is held and said as it's read, not when the pass ends.
   *
   * GitHub isn't waited for: a worktree is said with the pull request last read, and again if the reading now under
   * way has another. A landing only a merge can tell, of a worktree nobody shows or works in, waits until the others
   * are read (`laterLandings`).
   */
  private async readListed(all: readonly ThreadWorktree[], targets: readonly ThreadWorktree[], pullsOf: PullsOf | undefined, atWork: (worktree: ThreadWorktree) => boolean): Promise<void> {
    if (!targets.length) return this.laterLandings()
    const now = Date.now()
    const facts = new Map<string, RepositoryFacts>()
    // Pull requests are read at most once a minute a repository (`pullsIn`); one that changed is the worktree's event too.
    const pulls = new Map<string, PullsReading>()
    for (const repoRoot of new Set(targets.map((worktree) => worktree.repoRoot))) {
      const known = await this.repositoryFacts(repoRoot, true, all)
      facts.set(repoRoot, known)
      const reading: PullsReading = { pulls: this.pullsIn(repoRoot, pullsOf, await this.repositoryPoints(repoRoot, all, known)) }
      void reading.pulls.then((read) => {
        reading.read = { pulls: read }
        this.pullsSaid.set(repoRoot, read)
      })
      pulls.set(repoRoot, reading)
    }
    // A reading kept from the last minute, or none while no window looks, is in by the next turn of the loop.
    await Promise.race([Promise.all([...pulls.values()].map((reading) => reading.pulls)), new Promise((resolve) => setImmediate(resolve))])
    const plans = await mapLimit(targets, 12, async (worktree) => {
      const known = facts.get(worktree.repoRoot)!
      const head = await worktreeHead(worktree.path, known.tips)
      const refs = summaryRefs(worktree, known, head)
      const held = this.heldSummaries.get(worktree.path)
      // An event while it's read marks it again. One that says its files may have changed reads its status afresh: a
      // turn's edits leave the index as it was, which is all a status's own standing looks at. So does a branch or
      // HEAD moved from outside the worktree, which leaves its files and index behind.
      const marked = this.staleSummaries.get(worktree.path)
      this.staleSummaries.delete(worktree.path)
      // Files changed there with nobody looking, and now a window shows it.
      const seenNow = this.unseen.has(worktree.path) && this.shows(worktree.path)
      if (marked === "status" || marked === "files" || marked === "index" || seenNow || (held && !held.refs.startsWith(ownRefs(worktree, known, head)))) this.statuses.delete(worktree.path)
      const asRead = held !== undefined && held.refs === refs && await this.statusCurrent(worktree.path, now)
      return { worktree, head, refs, asRead }
    })
    for (const [repoRoot, known] of facts)
      await this.countBranches(repoRoot, known, plans.filter((plan) => !plan.asRead && plan.worktree.repoRoot === repoRoot), true)
    const afterPulls: (() => Promise<void>)[] = []
    // Nobody waits on a pass as it's made (windows take what's held): its reads go behind every other (`Git.idleOutput`).
    await mapLimit(plans, 6, async ({ worktree, head, refs, asRead }) => {
      const known = facts.get(worktree.repoRoot)!
      const reading = pulls.get(worktree.repoRoot)!
      const read = async (from: readonly WorktreeBranchPull[] | null) => {
        const before = this.heldSummaries.get(worktree.path)
        // Its own commits as they were, so only the main checkout moved: its landing can wait unless someone is looking.
        const waits = before !== undefined && before.refs.startsWith(ownRefs(worktree, known, head)) && !this.shows(worktree.path) && !atWork(worktree)
        // A summary whose landing waits is held as read at `awaiting`, which no commits are: a pass before the landing
        // is in, or a host that starts before it is, asks for it again rather than taking the summary as read.
        const awaiting = `${refs}${LANDING_AWAITED}`
        let putOff = false
        const later: LaterLanding | undefined = waits ? {
          previous: before.summary.landing,
          read: (tip, job) => {
            putOff = true
            this.landingsLater.set(worktree.path, { refs, awaiting, tip, read: job })
          },
        } : undefined
        const summary = await this.summarize(worktree, from, known, head, { fresh: false, idle: true, later })
        if (!putOff) this.landingsLater.delete(worktree.path)
        this.hold(worktree.path, summary, putOff ? awaiting : refs)
      }
      const pullMoved = (from: readonly WorktreeBranchPull[] | null) =>
        JSON.stringify(branchPull(from ?? [], worktree.branch) ?? null) !== JSON.stringify(this.heldSummaries.get(worktree.path)?.summary.pull ?? null)
      const again = async () => {
        const from = await reading.pulls
        if (pullMoved(from)) await read(from)
      }
      if (asRead) {
        const held = this.heldSummaries.get(worktree.path)
        if (held) {
          // Held from the last host and as it was: looked at now, and said to whoever hasn't heard it.
          this.unchecked.delete(worktree.path)
          this.say(held.summary)
        }
        if (!reading.read) afterPulls.push(again)
        else if (pullMoved(reading.read.pulls)) await read(reading.read.pulls)
        return
      }
      if (reading.read) return read(reading.read.pulls)
      // Said with what GitHub last answered, none included, so a reading that says the same changes nothing twice.
      await read(this.pullsSaid.has(worktree.repoRoot) ? this.pullsSaid.get(worktree.repoRoot) ?? null : this.pullsRead.get(worktree.repoRoot) ?? null)
      afterPulls.push(again)
    })
    await mapLimit(afterPulls, 6, (work) => work())
    await this.laterLandings()
  }

  /** Whether the `status` held for a worktree still answers: its index as it was when read, and read within `STATUS_BACKSTOP_MS`. */
  private async statusCurrent(path: string, now: number): Promise<boolean> {
    const status = this.statuses.get(path)
    // An index time of 0 is a checkout with no index to stat: nothing says it's unchanged.
    return status !== undefined && status.index !== 0 && now - status.at < this.backstop(path) && status.index === await this.indexTime(path)
  }

  /**
   * `ahead` and `behind` for several worktrees of a repository, counted by one `for-each-ref` (`ahead-behind`, Git
   * 2.41) against the main checkout's branch and the start point, and kept by their commits for `summarize` to find.
   * When the main checkout moves, every worktree's counts move with it: asked a worktree at a time that was two
   * processes each, a couple of hundred at once on a Mac with a hundred worktrees. Older Git, or a worktree off its
   * branch, is counted by `summarize` itself.
   */
  private async countBranches(repoRoot: string, facts: RepositoryFacts, wanted: readonly { worktree: ThreadWorktree; head: string | undefined }[], idle: boolean): Promise<void> {
    const target = facts.into ? facts.tips.get(facts.into) : undefined
    const point = facts.point?.commit
    const missing = wanted.filter(({ worktree, head }) => {
      const tip = facts.tips.get(worktree.branch)
      if (!tip || head !== tip) return false
      return (target !== undefined && !this.counts.has(aheadKey(repoRoot, target, tip))) || (point !== undefined && !this.counts.has(behindKey(repoRoot, tip, point)))
    })
    if (!missing.length || !(await this.git.atLeast(...AHEAD_BEHIND_GIT))) return
    // Counted once where new Threads start at the main checkout's own commit, as they do unless its upstream is ahead.
    const against = [...new Set([target, point].flatMap((commit) => (commit ? [commit] : [])))]
    const args = ["for-each-ref", `--format=%(refname)%00%(objectname)%00${against.map((commit) => `%(ahead-behind:${commit})`).join("%00")}`, ...new Set(missing.map(({ worktree }) => `refs/heads/${worktree.branch}`))]
    const listed = await (idle ? this.git.idleOutput(repoRoot, args) : this.git.readOutput(repoRoot, args)).catch(() => "")
    for (const line of listed.split("\n")) {
      const [ref = "", tip = "", ...pairs] = line.split("\0")
      // A branch that moved while it was counted is counted at the commit it has now, by the read that follows.
      if (!ref.startsWith("refs/heads/") || facts.tips.get(ref.slice("refs/heads/".length)) !== tip) continue
      const counted = pairs.map((pair) => pair.split(" ").map(Number))
      const ahead = target ? counted[against.indexOf(target)]?.[0] : undefined
      const behind = point ? counted[against.indexOf(point)]?.[1] : undefined
      if (target && ahead !== undefined && Number.isInteger(ahead)) this.counts.set(aheadKey(repoRoot, target, tip), ahead)
      if (point && behind !== undefined && Number.isInteger(behind)) this.counts.set(behindKey(repoRoot, tip, point), behind)
    }
  }

  /** The same repository-wide input for full, stale and single-summary PR reads. */
  private async repositoryPoints(repoRoot: string, worktrees: readonly ThreadWorktree[], facts: RepositoryFacts): Promise<RepositoryPoints> {
    const points = await Promise.all(worktrees.filter(worktree => worktree.repoRoot === repoRoot).map(async worktree => ({
      head: await worktreeHead(worktree.path, facts.tips), branch: await worktreeBranch(worktree.path),
    })))
    return {
      heads: points.flatMap(point => point.head ? [point.head] : []),
      branches: new Map(points.flatMap(point => point.branch && point.head ? [[point.branch, point.head] as const] : [])),
    }
  }

  /**
   * What every worktree of a repository shares: the branch its main checkout has out, the commit of each branch
   * `worktrees` are on, where new Threads start. Read from Git's files, which starts no process; a repository whose
   * files can't say (`storedFacts`) is asked of Git, every branch's commit with one `for-each-ref`.
   */
  private async repositoryFacts(repoRoot: string, idle: boolean, worktrees: readonly Pick<ThreadWorktree, "repoRoot" | "branch" | "path">[]): Promise<RepositoryFacts> {
    const point = this.starts.point(repoRoot, false).catch(() => null)
    const stored = await this.storedFacts(repoRoot, worktrees).catch(() => undefined)
    if (stored) return { ...stored, point: await point }
    const read = (args: string[]) => (idle ? this.git.idleOutput(repoRoot, args) : this.git.readOutput(repoRoot, args))
    const [into, refs] = await Promise.all([
      read(["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => ""),
      read(["for-each-ref", "--format=%(objectname) %(refname:short)", "refs/heads"]).catch(() => ""),
    ])
    const tips = await inSlices(summaryTips(refs))
    return { into, tips, point: await point }
  }

  /**
   * The main checkout's branch and the commits of the branches `worktrees` are on, from the repository's files.
   * Undefined when they can't say: no HEAD to read, a branch with no commit yet, refs kept another way.
   */
  private async storedFacts(repoRoot: string, worktrees: readonly Pick<ThreadWorktree, "repoRoot" | "branch" | "path">[]): Promise<Pick<RepositoryFacts, "into" | "tips"> | undefined> {
    const gitDir = await locateGitDir(repoRoot)
    const head = gitDir ? await gitFileText(join(gitDir, "HEAD")) : undefined
    if (!head) return undefined
    const into = head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : ""
    if (!into && !/^[0-9a-f]{40,64}$/.test(head)) return undefined
    const branches = new Set(into ? [into] : [])
    await Promise.all(worktrees.map(async (worktree) => {
      if (worktree.repoRoot !== repoRoot) return
      branches.add(worktree.branch)
      const on = await worktreeBranch(worktree.path)
      if (on) branches.add(on)
    }))
    const stored = await storedRefs(commonDirOf(repoRoot), [...branches].map((branch) => `refs/heads/${branch}`))
    if (!stored || (into && !stored.has(`refs/heads/${into}`))) return undefined
    return { into, tips: new Map([...stored].map(([ref, commit]) => [ref.slice("refs/heads/".length), commit])) }
  }

  /**
   * How many files a worktree's `git status` lists, for its summary: read again when its index changed, when an
   * event dropped what was held (`readListed`), or once the answer is `STATUS_BACKSTOP_MS` old; `fresh`, for a
   * worktree asked of alone, past `STATUS_FRESH_MS`. Each read is a spawn, which holds the host's thread (hundreds of
   * milliseconds each on a loaded Linux machine), and walks the worktree in the kernel.
   */
  private async statusOf(path: string, fresh: boolean, idle: boolean): Promise<number> {
    const index = await this.indexTime(path)
    const known = this.statuses.get(path)
    if (known && index !== 0 && known.index === index && Date.now() - known.at < (fresh ? STATUS_FRESH_MS : this.backstop(path))) return known.changes
    // Read because something moved or its answer aged out: whatever is held for those who only show it goes too.
    this.shared.touched(path)
    this.unseen.delete(path)
    const read: StatusHeld = {
      at: Date.now(),
      index,
      // A read that failed (a timeout under load) counts nothing and isn't kept: the next look reads it again.
      changes: this.shared.read(path, { idle, fresh }).then((status) => inSlices(summaryChanges(status)), () => {
        if (this.statuses.get(path) === read) this.statuses.delete(path)
        return 0
      }),
    }
    this.statuses.set(path, read)
    return read.changes
  }

  /** One worktree's summary, with where its branch started; undefined for a folder that isn't one of Mako's worktrees. */
  async summary(path: string, pullsOf?: PullsOf): Promise<(WorktreeSummary & { startedFrom: string | null }) | undefined> {
    const { worktrees } = await this.list()
    const worktree = worktrees.find(entry => entry.path === path)
    if (!worktree) return undefined
    await this.remember()
    const facts = await this.repositoryFacts(worktree.repoRoot, false, worktrees)
    const head = await worktreeHead(worktree.path, facts.tips)
    const pulls = await this.pullsIn(worktree.repoRoot, pullsOf, await this.repositoryPoints(worktree.repoRoot, worktrees, facts))
    return { ...await this.summarize(worktree, pulls, facts, head, { fresh: true, idle: false }), startedFrom: worktree.start?.from ?? null }
  }

  /** Where a worktree's new branch started (`origin/main`); null on a branch that existed already, or a folder that isn't one of Mako's worktrees. */
  async startedFrom(path: string): Promise<string | null> {
    return (await this.list()).worktrees.find((entry) => entry.path === path)?.start?.from ?? null
  }

  /** Forget the pull requests read, after something here opened or merged one, so the next summaries ask GitHub again. */
  forgetPulls(): void {
    this.branchPulls.clear()
  }

  /** The pull requests whose head is `branch`, as the summaries last read `repoRoot`'s: no read of GitHub, none before the first. */
  heldPulls(repoRoot: string, branch: string): WorktreeBranchPull[] {
    return (this.pullsRead.get(repoRoot) ?? []).filter((pull) => pull.branch === branch)
  }

  private readonly pullsChanged: (repoRoot: string) => Promise<void>
  private readonly pullInvalidations = new Map<string, Promise<void>>()

  private invalidatePulls(repoRoot: string): void {
    this.branchPulls.delete(repoRoot)
    if (this.pullInvalidations.has(repoRoot)) return
    const pending = Promise.resolve().then(() => this.pullsChanged(repoRoot)).finally(() => {
      if (this.pullInvalidations.get(repoRoot) === pending) this.pullInvalidations.delete(repoRoot)
    })
    this.pullInvalidations.set(repoRoot, pending)
    void pending.catch(() => hostWarn("git", "PR cache invalidation failed"))
  }

  private readonly pullsVisible: () => boolean

  private pullsIn(repoRoot: string, pullsOf: PullsOf | undefined, { heads: liveHeads, branches: liveBranches }: RepositoryPoints) {
    // Local file and Thread events still update summaries with no window; GitHub waits for a viewer.
    if (!this.pullsVisible()) return Promise.resolve(this.pullsRead.get(repoRoot) ?? null)
    const now = Date.now()
    const cached = this.branchPulls.get(repoRoot)
    // A shell push can precede its file event. Changed local facts must reach the per-PR reader now,
    // while an unchanged HEAD still shares the minute cache and the broad list keeps its five-minute TTL.
    // A commit on a branch with no open pull request changes nothing GitHub would say of it: with a hundred
    // worktrees, every commit in any of them asked GitHub about all of them again.
    if (cached && now - cached.at < BRANCH_PULLS_EVERY_MS) {
      const read = this.pullsRead.get(repoRoot)
      const moved = [...liveBranches].filter(([branch, head]) => cached.branches.get(branch) !== head)
      const movedHeads = new Set(moved.map(([, head]) => head))
      const pullOpen = ([branch]: readonly [string, string]) => {
        const pull = read && branchPull(read, branch)
        return read === undefined || pull?.state === "open" || pull?.state === "draft"
      }
      if (liveHeads.every((head) => cached.heads.has(head) || movedHeads.has(head)) && !moved.some(pullOpen)) return cached.pulls
    }
    const pulls = Promise.resolve(this.pullInvalidations.get(repoRoot)).then(() => pullsOf?.(repoRoot, liveHeads, liveBranches) ?? null).catch(() => null)
    this.branchPulls.set(repoRoot, { at: now, heads: new Set(liveHeads), branches: new Map(liveBranches), pulls })
    void pulls.then((read) => {
      if (!read || this.branchPulls.get(repoRoot)?.pulls !== pulls) return
      this.pullsRead.set(repoRoot, read)
      this.keep()
    })
    return pulls
  }

  /**
   * A worktree's summary at the commits `facts` and `head` name. Its counts and its landing are kept by those commits
   * (`CommitAnswers`), and its `status` while its index stands (`statusOf`), so only what moved is asked of Git.
   */
  private async summarize(worktree: ThreadWorktree, pulls: readonly WorktreeBranchPull[] | null, facts: RepositoryFacts, head: string | undefined, how: { fresh: boolean; idle: boolean; later?: LaterLanding }): Promise<WorktreeSummary> {
    const { into, point } = facts
    const { repoRoot } = worktree
    const tip = facts.tips.get(worktree.branch) ?? ""
    const from = into ? facts.tips.get(into) : worktree.base
    const count = (cwd: string, range: string) => (how.idle ? this.git.idleOutput(cwd, ["rev-list", "--count", range]) : this.git.readOutput(cwd, ["rev-list", "--count", range])).then(Number)
    const aheadRange = into ? `${into}..${worktree.branch}` : `${worktree.base}..${worktree.branch}`
    const [changes, aheadRead, behindBy] = await Promise.all([
      this.statusOf(worktree.path, how.fresh, how.idle),
      (tip && from ? this.counts.ask(aheadKey(repoRoot, from, tip), () => count(repoRoot, `${from}..${tip}`)) : count(repoRoot, aheadRange)).catch(() => undefined),
      point && (head ? this.counts.ask(behindKey(repoRoot, head, point.commit), () => count(repoRoot, `${head}..${point.commit}`)) : count(worktree.path, `HEAD..${point.commit}`)).catch(() => null),
    ])
    // A count against the main checkout's branch that came back 0 says the branch is in it; one that failed says nothing.
    const landing = await this.landing(worktree, facts, how.idle, into && tip && from ? aheadRead : undefined, how.later)
    const behind = point && behindBy !== null ? { from: point.from, commit: point.commit, commits: behindBy } : null
    const pull = branchPull(pulls ?? [], worktree.branch)
    const squashedThere = landing.kind === "open" && pull?.state === "merged" && pull.head === tip
    return {
      path: worktree.path,
      into: into || null,
      ahead: aheadRead ?? 0,
      changes,
      landing: squashedThere ? { kind: "merged", into: landing.into } : landing,
      pull,
      behind: behind && { from: behind.from, commits: behind.commits },
    }
  }

  /** Commits on a worktree's branch since the commit it started at; undefined for a folder that isn't one of Mako's worktrees. */
  async ahead(path: string): Promise<number | undefined> {
    const worktree = this.threads.worktrees().find((entry) => entry.path === path)
    if (!worktree || !existsSync(path)) return undefined
    return Number(await this.git.output(path, ["rev-list", "--count", `${worktree.base}..HEAD`]))
  }

  private known(path: string): ThreadWorktree {
    const worktree = this.threads.worktrees().find((entry) => entry.path === path)
    if (!worktree || !existsSync(path)) throw new Error("Mako didn't make this worktree.")
    return worktree
  }

  /**
   * The worktree's work since it branched, committed and uncommitted, against
   * where it meets the branch the main checkout has out, and whether merging
   * it there is safe now.
   */
  async review(path: string): Promise<WorktreeReview> {
    const worktree = this.known(path)
    const into = await this.git.output(worktree.repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "") || null
    const base = into ? await this.git.output(path, ["merge-base", into, "HEAD"]).catch(() => worktree.base) : worktree.base
    const [commits, diffed, untracked, status, behind] = await Promise.all([
      this.git.output(path, ["rev-list", "--count", `${base}..HEAD`]).then(Number),
      this.git.run({ cwd: path, args: [...NO_INDEX_REFRESH, "diff", "--numstat", "-z", "-M", "--no-ext-diff", base, "--"], read: true }).then((result) => numstatEntries(result.stdout)),
      this.git.output(path, ["ls-files", "--others", "--exclude-standard", "-z"]),
      // Whether it can be merged is decided on this: read as of now.
      this.shared.read(path, { fresh: true }),
      this.behind(worktree.repoRoot, path, false),
    ])
    const files = diffed.map(({ path: file, from, lines }) => {
      const entry: WorktreeReviewFile = { path: file, insertions: lines?.insertions ?? null, deletions: lines?.deletions ?? null }
      if (from) entry.from = from
      return entry
    })
    const added = untracked.split("\0").filter(Boolean)
    const counted = await untrackedLines(path, added.slice(0, COUNTED_UNTRACKED))
    for (const file of added) {
      const lines = counted.get(file) ?? null
      files.push({ path: file, insertions: lines?.insertions ?? null, deletions: lines ? 0 : null })
    }
    return {
      path, branch: worktree.branch, into, base, commits, files,
      merge: await this.mergeCheck(worktree, into, commits, status !== ""),
      behind: behind && { from: behind.from, commits: behind.commits },
    }
  }

  /** What the start point has that the worktree's `HEAD` doesn't, by the same rule a new Thread starts by. */
  private async behind(repoRoot: string, path: string, fetch: boolean): Promise<{ from: string; commit: string; commits: number } | null> {
    try {
      const point = await this.starts.point(repoRoot, fetch)
      return { from: point.from, commit: point.commit, commits: Number(await this.git.output(path, ["rev-list", "--count", `HEAD..${point.commit}`])) }
    } catch {
      return null
    }
  }

  /**
   * Merge what the start point has into the worktree's branch. A worktree
   * with uncommitted changes, or mid-operation, is refused. A conflict
   * leaves the merge in progress, so the person or the Thread's agent can
   * resolve it, continue or abort it in the Changes panel.
   */
  async update(path: string): Promise<WorktreeUpdate> {
    const worktree = this.known(path)
    if (await this.git.readOutput(path, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable"))
      throw new Error("Commit or stash your changes first.")
    const gitDir = await this.git.output(path, ["rev-parse", "--absolute-git-dir"])
    const underWay = UNDER_WAY.find(([marker]) => existsSync(join(gitDir, marker)))
    if (underWay) throw new Error(`Finish or abort the ${underWay[1]} first.`)
    if (!(await this.git.succeeds(path, ["symbolic-ref", "-q", "HEAD"]))) throw new Error("The worktree isn't on its branch.")
    const behind = await this.behind(worktree.repoRoot, path, true)
    if (!behind) throw new Error("Git couldn't tell which branch new Threads start from.")
    if (behind.commits === 0) return { kind: "current", from: behind.from }
    try {
      await this.git.output(path, ["merge", "--no-edit", "-m", `Merge ${behind.from} into ${worktree.branch}`, behind.commit])
      return { kind: "updated", from: behind.from, commits: behind.commits }
    } catch (error) {
      const conflicted = (await this.git.output(path, ["diff", "--name-only", "--diff-filter=U", "-z"]).catch(() => "")).split("\0").filter(Boolean)
      if (conflicted.length) return { kind: "conflicts", from: behind.from, files: conflicted }
      await this.git.output(path, ["merge", "--abort"]).catch(() => undefined)
      throw new Error(`Git couldn't merge ${behind.from}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
  }

  private async mergeCheck(worktree: ThreadWorktree, into: string | null, commits: number, dirty: boolean): Promise<WorktreeMergeCheck> {
    if (!into) return { ok: false, reason: "The main checkout isn't on a branch." }
    if (dirty) return { ok: false, reason: "Commit or discard this worktree's changes first." }
    if (commits === 0) return { ok: false, reason: `Nothing is committed here that ${into} doesn't have.` }
    const main = await this.git.readOutput(worktree.repoRoot, ["status", "--porcelain", "--untracked-files=no"]).catch(() => "unreadable")
    if (main) return { ok: false, reason: `The main checkout has uncommitted changes on ${into}.` }
    const busy = await this.working(worktree.repoRoot)
    if (busy.length) return { ok: false, reason: `${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} working in the main checkout. Merge once ${busy.length === 1 ? "it stops" : "they stop"}.` }
    // Merged in memory first: a conflict is found without touching either checkout. Older Git
    // can't, and then the merge itself finds it and is aborted.
    if (await this.git.mergesWithoutCheckout() && !await this.git.succeeds(worktree.repoRoot, ["merge-tree", "--write-tree", into, worktree.branch]))
      return { ok: false, reason: `It conflicts with ${into}. Update it from ${into} and resolve the conflict here, or open a pull request.` }
    return { ok: true, into }
  }

  /** The review's files, the commit it started from against the worktree as it is, for the diff viewer. */
  async reviewDiffs(path: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    const review = await this.review(path)
    return previewDiffs(this.git, path, review.files, { kind: "since", oid: review.base })
  }

  /**
   * Merge the worktree's branch into the branch the main checkout has out,
   * only when the review says it is safe; a merge Git stops is aborted, so
   * the main checkout is left as it was.
   */
  async merge(path: string): Promise<{ branch: string; into: string }> {
    const review = await this.review(path)
    if (!review.merge.ok) throw new Error(review.merge.reason)
    const { repoRoot } = this.known(path)
    try {
      await this.git.output(repoRoot, ["merge", "--no-edit", review.branch])
    } catch (error) {
      await this.git.output(repoRoot, ["merge", "--abort"]).catch(() => undefined)
      throw new Error(`Git stopped the merge and ${review.merge.into} was left as it was. ${error instanceof Error ? error.message : String(error)}`, { cause: error })
    }
    return { branch: review.branch, into: review.merge.into }
  }

  /** What the recipe's install steps' outputs did for a conversation's worktree, once it finishes. */
  outputs(conversationId: string): Promise<OutputsCarry> | undefined {
    return this.carrying.get(conversationId)
  }

  /** Record a started conversation's worktree against the Thread its journal joined. */
  async attach(conversationId: string): Promise<void> {
    const receipt = await this.receipt(conversationId)
    const placed = this.threads.journalPlacement(conversationId)
    if (receipt?.state !== "ready" || !placed) return
    this.threads.attachWorktree({
      path: receipt.path,
      thread: placed.thread,
      repoRoot: receipt.repoRoot,
      project: receipt.source,
      branch: receipt.branch,
      base: receipt.base,
    }, receipt.members?.map(({ path, repoRoot, base }) => ({ path, repoRoot, base })))
  }

  /**
   * This device's worktrees. One deleted outside Mako is forgotten here, and
   * a receipt whose start finished before the host stopped is attached.
   */
  async list(): Promise<ThreadWorktreeList> {
    const known = new Set(this.threads.worktrees().map((worktree) => worktree.path))
    const receipts = await readdir(this.receipts()).catch(() => [])
    const made = new Map<string, { receipt: Receipt; member: Member }>()
    for (const file of receipts) {
      const id = file.endsWith(".json") ? file.slice(0, -5) : ""
      if (!ConversationIdSchema.safeParse(id).success) continue
      const receipt = await this.receipt(id).catch(() => undefined)
      if (!receipt) continue
      const members = membersOf(receipt)
      if (receipt.state === "ready") for (const member of members) made.set(member.path, { receipt, member })
      if (members.some((member) => !known.has(member.path) && existsSync(member.path))) await this.attach(id)
    }
    const worktrees: ThreadWorktree[] = []
    const rows = this.threads.worktrees()
    // Looked for all at once, off the host's thread: a list is asked for every few seconds, of a hundred worktrees.
    const present = await Promise.all(rows.map((worktree) => stat(worktree.path).then(() => true, () => false)))
    for (const [index, worktree] of rows.entries()) {
      if (!present[index]) {
        this.threads.detachWorktree(worktree.path)
        continue
      }
      const start = made.get(worktree.path)
      worktrees.push(start ? {
        ...worktree,
        start: { from: start.member.from ?? null, adopted: start.receipt.adopted ?? false, tookMs: start.receipt.tookMs ?? 0, copied: start.receipt.copied ?? 0, spare: start.receipt.spare ?? false },
      } : worktree)
    }
    return { root: this.root, worktrees }
  }

  /**
   * The worktree at `path` as Mako made it, with the checkout it's part of,
   * every worktree in that checkout, and `home`, the main checkout's folder
   * the checkout mirrors: a project folder's worktrees go together, since
   * its Thread works in all of them.
   */
  private async made(path: string) {
    const attached = this.threads.worktrees().find((candidate) => candidate.path === path)
    const receipts = (await this.receiptsList()).filter(({ receipt }) => membersOf(receipt).some((member) => member.path === path))
    const members = receipts.flatMap(({ receipt }) => membersOf(receipt))
    const repoRoot = attached?.repoRoot ?? members.find((member) => member.path === path)?.repoRoot
    if (!repoRoot) throw new Error("Mako didn't make this worktree, so it won't remove it.")
    const project = receipts.find(({ receipt }) => receipt.members)?.receipt
    const checkout = attached ? worktreeCheckout(attached) : project?.path ?? path
    const home = checkout === path ? repoRoot : attached?.project ?? project?.repoRoot ?? repoRoot
    const together = new Map<string, { path: string; repoRoot: string }>([[path, { path, repoRoot }]])
    if (checkout !== path) {
      for (const row of this.threads.worktrees())
        if (row.thread === attached?.thread && worktreeCheckout(row) === checkout) together.set(row.path, row)
      for (const member of members) together.set(member.path, member)
    }
    return { attached, receipts, repoRoot, checkout, home, together: [...together.values()] }
  }

  /** Fresh retirement proof. The current worktree HEAD must still be its recorded branch tip. */
  /** One bounded, non-interactive fetch per common repository in a retirement pass. */
  async retirementFetch(common: string): Promise<void> {
    await fetchQuietly(this.git, common, ["--all", "--prune"])
  }

  /** Current HEAD is recoverable remotely, even when detached, switched or squash-merged. */
  async retirementRepository(worktree: ThreadWorktree, refresh: (common: string) => Promise<void>): Promise<{ head: string; blocked: string | null; remote: boolean; ignored: string[] }> {
    const head = await this.git.readOutput(worktree.path, ["rev-parse", "HEAD"])
    const blocked = await removalBlocker(this.git, worktree.path, undefined, true)
    if (blocked) return { head, blocked, remote: false, ignored: [] }
    const common = await this.git.readOutput(worktree.path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    await refresh(common)
    const remotes = (await this.git.readOutput(worktree.path, ["remote"])).split("\n").filter(Boolean)
    const refs = remotes.length ? await this.git.readOutput(worktree.path, ["for-each-ref", "--contains", head, "--format=%(refname)", ...remotes.map(remote => `refs/remotes/${remote}/`)]) : ""
    const ignored = (await this.git.readOutput(worktree.path, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]))
      .split("\0").slice(0, -1).filter((entry) => !entry.split("/").includes("node_modules"))
    return { head, blocked: null, remote: Boolean(refs), ignored }
  }

  /** Why the checkout cannot go: live users or work a removal would lose. */
  private async held(checkout: string, worktrees: readonly { path: string }[], waitingFor?: string, preview = false): Promise<string | null> {
    const users = await (this.conversations ? this.conversations.holding(checkout, waitingFor) : this.inUse(checkout))
    if (users.length) return inUseBy(checkout, users)
    for (const { path } of worktrees) {
      // What a removal would meet is read as of now, shared with whoever else asks that at this moment; the removal reads its own.
      const blocked = existsSync(path) ? await removalBlocker(this.git, path, preview ? this.shared.read(path, { fresh: true }) : undefined) : undefined
      if (blocked) return blocked
    }
    return null
  }

  /**
   * What removing the worktree at `path` would meet, without removing it: a
   * removal can wait for an Undo, or for `waitingFor`'s turn, and still say
   * what it will do.
   */
  async removal(path: string, waitingFor?: string): Promise<WorktreeRemoval> {
    const { attached, receipts, repoRoot, checkout, together } = await this.made(path)
    const made = attached ?? membersOf(receipts[0]!.receipt).find((member) => member.path === path)
    const branch = attached?.branch ?? receipts[0]?.receipt.branch
    const [held, landing] = await Promise.all([
      this.held(checkout, together, waitingFor, true),
      // By the commits its repository's files name, so one the summaries or the list already read isn't asked of Git again.
      made && branch
        ? this.repositoryFacts(repoRoot, false, [{ repoRoot, branch, path }]).then((known) => this.landing({ repoRoot, branch, base: made.base }, known), () => this.landing({ repoRoot, branch, base: made.base }))
        : Promise.resolve({ kind: "unknown" as const }),
    ])
    return { held, landing }
  }

  /**
   * Remove a worktree that nothing runs in and nothing is uncommitted in,
   * with the rest of its checkout for a project folder of several
   * repositories. Its idle conversations go on in the main checkout first.
   * Branches stay, so committed work is never lost. Folders
   * are moved aside at once and deleted in the background, so tens of
   * thousands of installed files don't hold the answer up.
   *
   * `retirement`: removed by the retention pass, which runs no project cleanup and deletes no Thread data. `"finished"`
   * is that for a Fin Mako closed as finished: what the worktree was is kept first (`retireWorktree`), and its
   * conversations stay where they are, asleep in a folder that's gone, because the next thing to reach the Fin makes the
   * worktree again at that path (`restoreRetired`) and it goes on there, on its branch, never in the main checkout.
   */
  async remove(path: string, retirement: boolean | "finished" = false): Promise<ThreadWorktreeList> {
    const { attached, receipts, checkout, home, together } = await this.made(path)
    const held = await this.held(checkout, together)
    if (held) throw new Error(held)
    if (retirement === "finished") {
      if (!attached || checkout !== path || together.length !== 1) throw new Error("Only one repository's worktree is made again by itself; this checkout was kept.")
      const head = await this.git.readOutput(path, ["rev-parse", "HEAD"])
      const branch = await this.git.output(path, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
      this.threads.retireWorktree({ path, thread: attached.thread, repoRoot: attached.repoRoot, project: attached.project, recorded: attached.branch, ...(branch && { branch }), head, base: attached.base, at: Date.now() })
    } else {
      const stayed = await this.conversations?.leave(checkout, home) ?? []
      if (stayed.length) throw new Error(inUseBy(checkout, stayed))
    }
    if (attached && !retirement) {
      await this.environment?.stop(attached.thread)
      if (existsSync(checkout)) await this.environment?.cleanup?.(attached.thread, checkout)
    }
    for (const worktree of together) {
      if (existsSync(worktree.path)) await this.spares.setAside(worktree.repoRoot, worktree.path)
      else await this.git.output(worktree.repoRoot, ["worktree", "prune"]).catch(() => {})
    }
    if (checkout !== path) await this.trashFolder(checkout)
    await this.borrowing.forget(checkout)
    if (attached) {
      for (const worktree of together) this.threads.detachWorktree(worktree.path)
      // Automatic worktree retirement never runs a project's arbitrary cleanup or deletes Thread data.
      if (!retirement) await this.environment?.discard(attached.thread, checkout)
    }
    for (const { id } of receipts) {
      this.untold.delete(id)
      await rm(join(this.receipts(), `${id}.json`), { force: true })
    }
    return this.list()
  }

  /**
   * Makes a worktree retired from under a finished Fin again (`remove`'s `"finished"`), at its own path, for whatever
   * runs in `folder` next: on its branch where the repository still has it and no other checkout holds it; on that
   * branch made again at the commit it was at, when it was deleted since (a merged pull request's usually is); detached
   * at that commit when another checkout holds the branch. Its files are its commit's: installed packages and build
   * output went with the folder. Undefined when `folder` is in no retired worktree, or the worktree is there. A failure
   * says exactly why, changes nothing, and keeps the record for the next try: its project gone from this Mac, or its
   * commit gone from the repository. One at a time per path.
   */
  restoreRetired(folder: string): Promise<WorktreeRestored | undefined> {
    const retired = this.threads.retiredWorktrees().find((each) => folder === each.path || folder.startsWith(`${each.path}/`))
    if (!retired) return Promise.resolve(undefined)
    const going = this.restoring.get(retired.path)
    if (going) return going
    const restoring = this.restore(retired).finally(() => this.restoring.delete(retired.path))
    this.restoring.set(retired.path, restoring)
    return restoring
  }

  private async restore(retired: RetiredWorktree): Promise<WorktreeRestored | undefined> {
    const { path, repoRoot, head } = retired
    // There already (another host made it again, or it was never gone), or its Thread is gone: nothing to make.
    if ((await workingCheckout(this.git, path)) || !this.threads.thread(retired.thread)) {
      this.threads.forgetRetiredWorktree(path)
      return undefined
    }
    const failed = (why: string): WorktreeRestored => {
      hostWarn("worktrees", "a finished Fin's worktree couldn't be made again", { path, repoRoot, why })
      return { kind: "failed", path, why }
    }
    if (!(await this.git.succeeds(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"])))
      return failed(localWords(`its project, ${repoRoot}, isn't a repository on this Mac anymore: it was moved or deleted.`))
    if (existsSync(path) && (await readdir(path)).length) return failed(`${path} holds other files now, which Mako won't write over.`)
    await this.git.output(repoRoot, ["worktree", "prune"]).catch(() => "")
    const branch = retired.branch
    const has = branch !== undefined && (await this.git.succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))
    const known = await this.git.succeeds(repoRoot, ["cat-file", "-e", `${head}^{commit}`])
    if (!has && !known) return failed(`${branch ? `its branch ${branch} was deleted and ` : ""}the commit it was at (${head.slice(0, 8)}) is no longer in ${repoRoot}.`)
    const elsewhere = has ? worktreeHolding(await this.git.output(repoRoot, ["worktree", "list", "--porcelain"]), branch) : undefined
    let note: string
    let on: string | undefined
    try {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 })
      if (branch && has && !elsewhere) {
        await this.git.output(repoRoot, ["worktree", "add", "--quiet", "--no-checkout", path, branch])
        on = branch
        note = `on its branch ${branch}`
      } else if (branch && !has) {
        await this.git.output(repoRoot, ["worktree", "add", "--quiet", "--no-checkout", "-b", branch, path, head])
        on = branch
        note = `on its branch ${branch}, which was deleted since and is made again at ${head.slice(0, 8)}, the commit it was at`
      } else {
        await this.git.output(repoRoot, ["worktree", "add", "--quiet", "--no-checkout", "--detach", path, has && branch ? branch : head])
        note = elsewhere ? `detached at the tip of ${branch}, because ${elsewhere} has that branch checked out` : `detached at ${head.slice(0, 8)}, as it was`
      }
      await fillWorktree(this.git, path)
    } catch (error) {
      // Half made, it would read as there with no files in it: taken out again, so the next try starts from nothing.
      await this.git.output(repoRoot, ["worktree", "remove", "--force", path]).catch(() => "")
      return failed(`Git couldn't add it to ${repoRoot}: ${error instanceof Error ? error.message : "unknown error"}`)
    }
    const now = await this.git.readOutput(path, ["rev-parse", "HEAD"])
    this.threads.attachWorktree({ path, thread: retired.thread, repoRoot, project: retired.project, branch: on ?? retired.recorded, base: retired.base })
    this.threads.forgetRetiredWorktree(path)
    hostLog("worktrees", "a finished Fin's worktree was made again", { path, repoRoot, ...(on && { branch: on }), head: now })
    return { kind: "restored", path, ...(on && { branch: on }), head: now, note: `${note}. Its files are that commit's: installed packages and build output went with the folder, so install again before you build or test.` }
  }

  /** A project checkout's own folder, once its worktrees are set aside: what the recipe carried into it, deleted in the background. */
  private async trashFolder(folder: string): Promise<void> {
    if (!existsSync(folder)) return
    await mkdir(this.trash(), { recursive: true, mode: 0o700 })
    const aside = join(this.trash(), randomUUID())
    if (await rename(folder, aside).then(() => true, () => false)) void removeBelowAgents(aside)
  }

  /**
   * Move this Thread's uncommitted work from the checkout the worktree was
   * made from into the worktree, which starts at the same commit: each line
   * its last writer is the Thread, its created, deleted and renamed files,
   * and with `bring`, what might be its and what nobody can be named for
   * (`worktree-move.ts`). The main checkout keeps everyone else's. A
   * repeated request answers the same.
   */
  async moveChanges(conversationId: string, options: { thread?: string; bring?: boolean; haste?: MoveHaste } = {}): Promise<MoveOutcome> {
    const receipt = await this.receipt(conversationId)
    if (receipt?.state !== "ready") throw new Error("This conversation has no worktree to move changes into.")
    if (receipt.moved) {
      if ("stash" in receipt.moved) throw this.kept(receipt, receipt.moved.stash)
      return receipt.moved.outcome ?? legacyOutcome(receipt.moved.files)
    }
    if (receipt.moving && "stash" in receipt.moving) {
      // An earlier version's move through a stash was cut short: its changes are in that stash, or already here.
      await this.save({ ...receipt, moving: undefined, moved: { stash: receipt.moving.stash } })
      throw this.kept(receipt, receipt.moving.stash)
    }
    if (receipt.moving) {
      const finished = await this.finishCutShort(receipt)
      if (finished) return finished
    }
    const ledger = this.ledger()
    // Without the journal nobody is named, so the Thread isn't needed to divide anything.
    const thread = options.thread ?? this.threads.journalPlacement(conversationId)?.thread ?? (ledger ? undefined : "")
    if (thread === undefined) throw new Error("Mako doesn't know this conversation's Thread, so it can't tell its changes from others'.")
    if (receipt.based) return this.basedMove(receipt, thread)
    const id = randomUUID()
    await this.save({ ...receipt, moving: { id } })
    try {
      const plan = await moveByAuthor({
        git: this.git,
        ledger,
        id,
        thread,
        branch: receipt.branch,
        project: receipt.repoRoot,
        members: membersOf(receipt),
        bring: options.bring ?? false,
        ...options.haste && { by: options.haste.by },
        save: (plan) => (plan ? this.savePlan(plan) : this.dropPlan(id)),
        log: (message, facts) => hostLog("worktree-move", message, { conversation: conversationId, ...facts }),
        stepped: this.stepped,
      })
      await this.finishMove(receipt, plan)
      return plan.outcome
    } catch (error) {
      await this.save({ ...receipt, moving: undefined })
      throw error
    }
  }

  /**
   * A move into a worktree made from the base it named: what's uncommitted in the checkout it left was made on another
   * commit, so nothing comes, and what stays is said as a move's outcome. The Thread's own changes there would be lost
   * from its sight, so a move that finds some (made after `wantBranch` looked) is refused, its worktree given back.
   */
  private async basedMove(receipt: Receipt, thread: string): Promise<MoveOutcome> {
    const shares = thread ? await this.threadShares(thread, receipt.source).catch(() => undefined) : undefined
    const own = (shares?.thread.files ?? 0) + (shares?.likely?.files ?? 0)
    if (own) throw new Error(`This Thread changed ${own === 1 ? "a file" : `${own} files`} in ${basename(receipt.source)} after asking to start from ${receipt.from ?? "another commit"}, made on another commit, so it didn't move. Commit them, or move without base.`)
    const none = { files: 0, lines: 0, paths: [] }
    const outcome: MoveOutcome = {
      came: none,
      stayed: { others: shares?.others ?? none, person: shares?.person ?? none, uncertain: shares?.uncertain ?? none, unattributed: shares?.unattributed ?? none },
      split: [],
      brought: false,
      unstaged: [],
    }
    await this.save({ ...receipt, moving: undefined, moved: { files: 0, outcome } })
    return outcome
  }

  /**
   * How the uncommitted changes of `folder`'s project divide for this
   * conversation's Thread, as a move would take them. The journal isn't
   * asked to settle: this is what it has heard so far.
   */
  async shares(conversationId: string, folder: string): Promise<MoveShares | undefined> {
    const thread = this.threads.journalPlacement(conversationId)?.thread
    return thread ? this.threadShares(thread, folder) : undefined
  }

  /** `shares` for a Thread by its id. */
  async threadShares(thread: string, folder: string): Promise<MoveShares | undefined> {
    const source = await realpath(folder).catch(() => folder)
    const repoRoot = await this.git.output(source, ["rev-parse", "--show-toplevel"]).catch(() => "")
    const found = repoRoot ? { roots: [repoRoot] } : await projectRepositories(this.git, source)
    if (!("roots" in found) || !found.roots.length) return undefined
    return previewShares(this.git, this.ledger(), repoRoot || source, found.roots, thread)
  }

  /** What moving changes into this conversation's worktree did; null before a move, or for one by an earlier version. */
  async moveOutcome(conversationId: string): Promise<MoveOutcome | null> {
    const moved = (await this.receipt(conversationId))?.moved
    return moved && "outcome" in moved && moved.outcome ? moved.outcome : null
  }

  /** A test's hook at each step of a move. */
  stepped: ((step: string) => void) | undefined

  /**
   * "Bring these" after a move: what might be the Thread's and what nobody
   * can be named for follow it into the worktree, from where the move left
   * them. Returns the move's outcome now, the files that came, and the files
   * either checkout changed since, which stayed. `by: "agent"`: the Thread's
   * agent asked with worktree_bring and reads what came in its answer, so its
   * next turn isn't told again, unless `tell` (a restart finished it).
   * `only`: just those that stayed, project-relative (`stayed` lists them);
   * every one when left out, as the app's button does.
   */
  async bringStayed(conversationId: string, options: { by?: Adjuster; tell?: boolean; only?: readonly string[] } = {}): Promise<{ outcome: MoveOutcome; came: string[]; left: string[] }> {
    const by = options.by ?? "person"
    const receipt = await this.receipt(conversationId)
    const moved = receipt?.moved && "files" in receipt.moved ? receipt.moved : undefined
    if (!receipt || !moved?.outcome) throw new Error("This conversation's worktree has no move whose changes stayed behind.")
    if (moved.outcome.brought) return { outcome: moved.outcome, came: [], left: [] }
    const plan = moved.id ? await this.readPlan(moved.id) : undefined
    if (!plan) throw new Error("Mako no longer has what this move left behind, so nothing more can come from it.")
    const result = await bringStayed(this.git, this.ledger(), plan, receipt.repoRoot, (message, facts) => hostLog("worktree-move", message, { conversation: conversationId, ...facts }), this.adjustHooks(), by, options.only)
    if (result.came.length) this.ledger()?.moved?.({ thread: plan.thread, kind: "bring", files: result.came.length, guessed: 0, offered: 0 })
    await this.keepPlan(result.plan)
    const told = result.came.length > 0 && (by === "person" || options.tell) ? broughtSentence(result.came, by) : undefined
    await this.save(this.tell({ ...receipt, moved: { ...moved, files: result.plan.outcome.came.files, outcome: result.plan.outcome } }, told))
    return { outcome: result.plan.outcome, came: result.came, left: result.left }
  }

  /** What this conversation's move left that can still be brought, by kind (`stayedPaths`); none before a move. */
  async stayed(conversationId: string): Promise<StayedPaths> {
    const receipt = await this.receipt(conversationId)
    const moved = receipt?.moved && "files" in receipt.moved ? receipt.moved : undefined
    const plan = moved?.outcome && !moved.outcome.brought && moved.id ? await this.readPlan(moved.id).catch(() => undefined) : undefined
    return receipt && plan ? stayedPaths(plan, receipt.repoRoot) : { uncertain: [], unattributed: [] }
  }

  /**
   * "Put back" after a move: `paths` (project-relative) that came go back to
   * the main checkout as it had them, and the worktree to its base. Returns
   * the move's outcome now, the files that went back, and the files either
   * checkout changed since, which stayed. `by` and `tell` as `bringStayed`'s.
   */
  async putBack(conversationId: string, paths: readonly string[], options: { by?: Adjuster; tell?: boolean } = {}): Promise<{ outcome: MoveOutcome; returned: string[]; left: string[] }> {
    const by = options.by ?? "person"
    const receipt = await this.receipt(conversationId)
    const moved = receipt?.moved && "files" in receipt.moved ? receipt.moved : undefined
    if (!receipt || !moved?.outcome) throw new Error("This conversation's worktree has no move to put files back from.")
    const plan = moved.id ? await this.readPlan(moved.id) : undefined
    if (!plan) throw new Error("Mako no longer has what this move took, so its files can't be put back from here. Its backup ref still holds the main checkout as it was.")
    const result = await putBack(this.git, this.ledger(), plan, receipt.repoRoot, paths, (message, facts) => hostLog("worktree-move", message, { conversation: conversationId, ...facts }), this.adjustHooks(), by)
    const guessed = new Set(plan.outcome.likely?.paths ?? [])
    if (result.returned.length) this.ledger()?.moved?.({ thread: plan.thread, kind: "put-back", files: result.returned.length, guessed: result.returned.filter((path) => guessed.has(path)).length, offered: 0 })
    await this.keepPlan(result.plan)
    const told = result.returned.length > 0 && (by === "person" || options.tell) ? returnedSentence(result.returned, by) : undefined
    await this.save(this.tell({ ...receipt, moved: { ...moved, files: result.plan.outcome.came.files, outcome: result.plan.outcome } }, told))
    return { outcome: result.plan.outcome, returned: result.returned, left: result.left }
  }

  /**
   * What the person changed in this conversation's worktree since its agent
   * last heard, for the note its next turn opens with. Given once: the
   * receipt forgets them in the background.
   */
  notices(conversationId: string): string[] {
    const lines = this.untold.get(conversationId)
    if (!lines) return []
    this.untold.delete(conversationId)
    void this.receipt(conversationId)
      .then((receipt) => receipt && this.save({ ...receipt, untold: receipt.untold?.filter((line) => !lines.includes(line)) }))
      .catch((error: Error) => hostLog("worktree-move", "couldn't record that the agent heard", { conversation: conversationId, error: error.message }))
    return lines
  }

  /** `receipt` with `line` added to what its agent hasn't heard. */
  private tell(receipt: Receipt, line: string | undefined): Receipt {
    if (!line) return receipt
    const untold = [...(receipt.untold ?? []), line]
    this.untold.set(receipt.conversation, untold)
    return { ...receipt, untold }
  }

  private adjustHooks(): AdjustHooks {
    return { save: (plan) => this.savePlan(plan), stepped: (step) => this.stepped?.(step) }
  }

  /** A move whose plan was saved, finished or undone; undefined when it never wrote its plan, so nothing was written. */
  private async finishCutShort(receipt: Receipt): Promise<MoveOutcome | undefined> {
    const id = receipt.moving && "id" in receipt.moving ? receipt.moving.id : undefined
    const plan = id ? await this.readPlan(id) : undefined
    if (!plan) {
      await this.save({ ...receipt, moving: undefined })
      return undefined
    }
    try {
      const done = await resumeMove(this.git, this.ledger(), plan, (message, facts) => hostLog("worktree-move", message, { conversation: receipt.conversation, ...facts }))
      await this.finishMove(receipt, done)
      return done.outcome
    } catch (error) {
      await this.dropPlan(plan.id)
      await this.save({ ...receipt, moving: undefined })
      throw error
    }
  }

  /** Record what the move did. */
  private async finishMove(receipt: Receipt, plan: MovePlan): Promise<void> {
    const { came, likely, stayed } = plan.outcome
    this.ledger()?.moved?.({ thread: plan.thread, kind: "move", files: came.files, guessed: likely?.files ?? 0, offered: stayed.uncertain.files + stayed.unattributed.files })
    await this.keepPlan({ ...plan, step: "done" })
    await this.save({ ...receipt, moving: undefined, moved: { files: plan.outcome.came.files, id: plan.id, outcome: plan.outcome } })
  }

  /** A done move's plan stays only while what stayed can still be brought, or what came on timing alone put back. */
  private async keepPlan(plan: MovePlan): Promise<void> {
    const bringable = !plan.brought && plan.repositories.some((repository) => repository.bring.length)
    if (bringable || plan.outcome.likely?.files) await this.savePlan(plan)
    else await this.dropPlan(plan.id)
  }

  private kept(receipt: Receipt, stash: string, cause?: unknown): Error {
    const where = receipt.members ? "each repository's own stash" : "the main checkout's stash"
    return new Error(`The worktree couldn't take the changes, so they're kept in ${where} as "${stash}".`, { cause })
  }

  private plans(): string {
    return join(this.root, "moves")
  }

  private async savePlan(plan: MovePlan): Promise<void> {
    await mkdir(this.plans(), { recursive: true, mode: 0o700 })
    const target = join(this.plans(), `${plan.id}.json`)
    const pending = `${target}.${randomUUID()}.tmp`
    await writeFile(pending, JSON.stringify(plan), { mode: 0o600 })
    await rename(pending, target)
  }

  private async readPlan(id: string): Promise<MovePlan | undefined> {
    const text = await readFile(join(this.plans(), `${id}.json`), "utf8").catch(() => null)
    return text === null ? undefined : MovePlanSchema.parse(JSON.parse(text))
  }

  private async dropPlan(id: string): Promise<void> {
    await rm(join(this.plans(), `${id}.json`), { force: true })
  }

  /**
   * Take back a worktree made for a conversation that didn't start: its
   * folder, its receipt, and its still-empty branch. A folder that isn't
   * exactly as the start left it (another branch, or anything a removal would
   * lose) stays, listed in Settings as in no Thread.
   */
  async abandon(conversationId: string): Promise<void> {
    const receipt = await this.receipt(conversationId)
    if (!receipt) return
    const members = membersOf(receipt)
    for (const { path } of members) {
      if (!existsSync(path)) continue
      const on = await this.git.output(path, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")
      if (on !== receipt.branch || (await this.inUse(path)).length || await removalBlocker(this.git, path)) return
    }
    const left: { repoRoot: string; error: string }[] = []
    for (const { repoRoot, path, base, adopted } of members) {
      if (existsSync(path)) await this.spares.setAside(repoRoot, path)
      const error = receipt.adopted || adopted ? undefined : await this.dropIfEmpty(repoRoot, base, receipt.branch)
      if (error) left.push({ repoRoot, error })
    }
    if (receipt.members) await this.trashFolder(receipt.path)
    if (left.length) {
      // The receipt stays, so the next abandon of it deletes what's left; its worktrees are set aside already.
      hostWarn("worktrees", "an abandoned worktree's empty branch couldn't be deleted", { conversation: conversationId, branch: receipt.branch, left: left.map(({ repoRoot, error }) => `${repoRoot}: ${error}`).join("; ") })
      throw new Error(`Couldn't delete the empty branch ${receipt.branch} in ${left.map(({ repoRoot }) => basename(repoRoot)).join(" and ")}: ${left[0]!.error}`)
    }
    this.untold.delete(conversationId)
    await rm(join(this.receipts(), `${conversationId}.json`), { force: true })
  }

  /**
   * Deletes a branch nothing was committed on since `base`; why it stays, if it does. A count that can't be read keeps
   * the branch, and says so: it may hold commits. One that isn't there is nothing to do.
   */
  private async dropIfEmpty(repoRoot: string, base: string, branch: string): Promise<string | undefined> {
    // Gone already: an abandon before this one deleted it here, and stopped at another repository.
    if (!(await this.hasBranch(repoRoot, branch))) return undefined
    const counted = await this.git.output(repoRoot, ["rev-list", "--count", `${base}..${branch}`]).then((count) => ({ commits: Number(count) }), (failure: Error) => ({ refused: gitWords(failure) }))
    if ("refused" in counted) return `its commits couldn't be counted: ${counted.refused}`
    return counted.commits === 0 ? this.dropBranch(repoRoot, branch) : undefined
  }

  /**
   * Deletes a branch; Git's first line, if it refused ("cannot lock ref …: Unable to create '….lock': File exists").
   * Mako's own writes in the repository run one at a time (`Git.run`), and Git waits out a lock another program holds
   * (`REF_LOCK_WAIT`), so a refusal is one to report, not to try again.
   */
  private async dropBranch(repoRoot: string, branch: string): Promise<string | undefined> {
    const refused = await this.git.output(repoRoot, ["branch", "-D", branch]).then(() => undefined, (failure: Error) => gitWords(failure))
    return refused !== undefined && (await this.hasBranch(repoRoot, branch)) ? refused : undefined
  }

  private projectFolder(repoRoot: string): string {
    const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 8)
    return join(this.root, `${basename(repoRoot)}-${hash}`)
  }

  private receipts(): string {
    return join(this.root, "receipts")
  }

  private trash(): string {
    return join(this.root, "trash")
  }

  private async receiptsList(): Promise<{ id: string; receipt: Receipt; createdAt: number }[]> {
    const found: { id: string; receipt: Receipt; createdAt: number }[] = []
    for (const file of await readdir(this.receipts()).catch(() => [])) {
      const id = file.endsWith(".json") ? file.slice(0, -5) : ""
      const receipt = await this.receipt(id).catch(() => undefined)
      if (!receipt) continue
      const createdAt = await stat(join(this.receipts(), file)).then(({ birthtimeMs, mtimeMs }) => Math.round(birthtimeMs || mtimeMs), () => Date.now())
      found.push({ id, receipt, createdAt })
    }
    return found
  }

  private async receipt(conversationId: string): Promise<Receipt | undefined> {
    if (!ConversationIdSchema.safeParse(conversationId).success) return undefined
    const file = join(this.receipts(), `${conversationId}.json`)
    // Every list reads every receipt; one unchanged since it was parsed (another host may write one) is taken as read.
    const stamp = await stat(file).then(({ mtimeMs, size }) => `${mtimeMs}:${size}`, () => null)
    if (stamp === null) {
      this.receiptsRead.delete(conversationId)
      return undefined
    }
    const known = this.receiptsRead.get(conversationId)
    if (known?.stamp === stamp) return known.receipt
    const text = await readFile(file, "utf8").catch(() => null)
    if (text === null) return undefined
    const receipt = ReceiptSchema.parse(JSON.parse(text))
    this.receiptsRead.set(conversationId, { stamp, receipt })
    return receipt
  }

  private async save(receipt: Receipt): Promise<void> {
    await mkdir(this.receipts(), { recursive: true, mode: 0o700 })
    const target = join(this.receipts(), `${receipt.conversation}.json`)
    const pending = `${target}.${randomUUID()}.tmp`
    await writeFile(pending, JSON.stringify(receipt), { mode: 0o600 })
    await rename(pending, target)
  }

  private async create(conversationId: string, cwd: string, name: string | undefined, from: WorktreeFrom, onStep?: (step: WorktreeStep) => void, branch?: string): Promise<Receipt> {
    const began = performance.now()
    const source = await realpath(cwd)
    let receipt = await this.receipt(conversationId)
    if (receipt && receipt.source !== source) throw new Error("This conversation's worktree was made from another folder")
    if (receipt?.state === "ready" && existsSync(receipt.path)) return receipt
    if (receipt?.members) return this.createProject(conversationId, source, name, from, began, onStep, receipt, branch)
    /** The receipt's branch is known to be there: this start made it, or found it. */
    let branched = false
    if (!receipt) {
      let repoRoot: string
      let base: string
      try {
        ;[repoRoot = "", base = ""] = (await this.git.output(source, ["rev-parse", "--show-toplevel", "--verify", "HEAD^{commit}"])).split("\n")
      } catch (error) {
        if (error instanceof GitError && /not a git repository/i.test(error.stderr))
          return this.createProject(conversationId, source, name, from, began, onStep, undefined, branch)
        throw new Error("This repository has no commits yet, so a worktree has nothing to start from. Make a first commit, or choose Project folder.", { cause: error })
      }
      let adopted: string | undefined
      let made: string | undefined
      let started: string | undefined
      if (from.kind === "branch" && from.make && !(await this.hasBranch(repoRoot, from.branch))) {
        // A branch a Fin's start names that isn't there yet is made, from its base or the start point.
        if (!(await this.git.succeeds(repoRoot, ["check-ref-format", "--branch", from.branch])))
          throw new Error(`${from.branch} isn't a name Git allows for a branch.`)
        if (from.make.from !== undefined) {
          base = await this.git.output(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${from.make.from}^{commit}`]).catch(() => "")
          if (!base) throw new Error(`${from.make.from} isn't in ${basename(repoRoot)} anymore. Choose another branch to start from.`)
          started = from.make.from
        } else ({ commit: base, from: started } = await this.starts.point(repoRoot, false))
        made = from.branch
      } else if (from.kind === "newest") ({ commit: base, from: started } = await this.starts.point(repoRoot, false))
      else if (from.kind === "from") {
        base = await this.git.output(repoRoot, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${from.ref}^{commit}`]).catch(() => "")
        if (!base) throw new Error(`${from.ref} isn't in ${basename(repoRoot)} anymore. Choose another branch to start from.`)
        started = from.ref
      } else if (from.kind === "head") started = await this.git.output(source, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => base.slice(0, 7))
      else ({ branch: adopted, base } = await this.adopt(repoRoot, from))
      const parent = this.projectFolder(repoRoot)
      const slug = adopted
        ? this.freeFolder(parent, worktreeSlug(adopted.replace(/[/_.]+/g, " ")))
        : await this.reserveSlug(repoRoot, parent, worktreeSlug((branch ?? made)?.replace(/[/_.]+/g, " ") ?? name), base)
      const path = join(parent, slug)
      const inside = relative(repoRoot, source)
      receipt = {
        conversation: conversationId,
        source,
        repoRoot,
        path,
        cwd: inside && !inside.startsWith("..") ? join(path, inside) : path,
        branch: adopted ?? branch ?? made ?? `${BRANCH_PREFIX}${slug}`,
        base,
        state: "creating",
      }
      if (adopted) receipt.adopted = true
      if (started) receipt.from = started
      if (from.kind === "from") receipt.based = true
      branched = adopted !== undefined || receipt.branch === `${BRANCH_PREFIX}${slug}`
      await this.save(receipt)
    }
    onStep?.("checkout")
    let spare: Spare | undefined
    // A receipt from before names were held by their branch may not have one yet, nor one for a branch the start was
    // given by name. One this start just made by reserving its name, or found to adopt, is there.
    if (!branched && !(await this.git.succeeds(receipt.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${receipt.branch}`])))
      await this.git.output(receipt.repoRoot, ["branch", "--no-track", receipt.branch, receipt.base])
    // `.git` rather than asking Git, which would answer for a repository around an empty folder.
    const existed = existsSync(join(receipt.path, ".git"))
    if (!existed) {
      spare = await this.fromSpare(receipt)
      if (!spare) {
        await mkdir(dirname(receipt.path), { recursive: true, mode: 0o700 })
        try {
          await addWorktree(this.git, receipt.repoRoot, receipt.path, receipt.branch)
        } catch (error) {
          if (error instanceof GitError && /already (checked out|used by worktree)/i.test(error.stderr))
            throw new Error(`${receipt.branch} is checked out in another folder. Git keeps a branch in one checkout at a time, so start a new branch from it instead.`, { cause: error })
          throw new Error(`Git couldn't create the worktree: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
        }
      }
    }
    // A start cut short between placing a spare and checking out its branch finishes here.
    if (existed && !(await this.git.succeeds(receipt.path, ["symbolic-ref", "-q", "HEAD"])))
      await this.git.output(receipt.path, ["checkout", "-q", receipt.branch])
    const recipe = await this.setup?.recipe(receipt.path).catch(() => undefined)
    if (recipe?.carry?.length) onStep?.("carry")
    const { copied } = await this.borrowing.carry(conversationId, receipt.repoRoot, receipt.path, recipe?.carry ?? [])
    const ready: Receipt = { ...receipt, state: "ready", copied, tookMs: Math.round(performance.now() - began) }
    if (spare) ready.spare = true
    await this.save(ready)
    this.carryOutputs(conversationId, ready.repoRoot, ready.path, recipe?.prepare ?? [])
    this.wantSpares(ready.repoRoot)
    return ready
  }

  /**
   * A Thread's checkout of a project folder that isn't a repository but
   * holds some: a folder under `{root}/{project}-{hash}` mirroring it, with
   * each repository's worktree at the same place inside, all on the
   * Thread's branch. What lies outside the repositories isn't checked out;
   * the project's recipe's `carry` names what a Thread needs of it.
   */
  private async createProject(conversationId: string, source: string, name: string | undefined, from: WorktreeFrom, began: number, onStep?: (step: WorktreeStep) => void, existing?: Receipt, exactBranch?: string): Promise<Receipt> {
    let receipt = existing
    if (!receipt) {
      const found = await projectRepositories(this.git, source)
      if ("refusal" in found) throw new Error(found.refusal)
      if (from.kind !== "newest" && from.kind !== "head" && from.kind !== "branch")
        throw new Error(`${basename(source)} holds several repositories, so its Threads start each one on a new branch, or on one branch you name in all of them. Starting from another branch or a pull request is for a project of one repository.`)
      const started: { repoRoot: string; base: string; from: string; adopted?: true }[] = await Promise.all(found.roots.map(async (repoRoot) => {
        const head = await this.git.output(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => "")
        if (!head) throw new Error(`${relative(source, repoRoot)} has no commits yet, so its worktree has nothing to start from. Make a first commit there, or choose Project folder.`)
        if (from.kind === "head") return { repoRoot, base: head, from: await this.git.output(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => head.slice(0, 7)) }
        // A repository that has the branch works on it; one that doesn't makes it from its newest start.
        if (from.kind === "branch" && await this.hasBranch(repoRoot, from.branch)) {
          const { branch, base } = await this.adopt(repoRoot, from)
          return { repoRoot, base, from: branch, adopted: true as const }
        }
        const point = await this.starts.point(repoRoot, false)
        return { repoRoot, base: point.commit, from: point.from }
      }))
      const parent = this.projectFolder(source)
      const named = from.kind === "branch" ? started.find((member) => member.adopted)?.from ?? from.branch : exactBranch
      const slug = named
        ? this.freeFolder(parent, worktreeSlug(named.replace(/[/_.]+/g, " ")))
        : await this.reserveProjectSlug(started, parent, worktreeSlug(name))
      const path = join(parent, slug)
      receipt = {
        conversation: conversationId,
        source,
        repoRoot: source,
        path,
        cwd: path,
        branch: named ?? `${BRANCH_PREFIX}${slug}`,
        base: "",
        state: "creating",
        members: started.map((member) => ({ ...member, path: join(path, relative(source, member.repoRoot)) })),
      }
      if (started.every((member) => member.adopted)) receipt.adopted = true
      await this.save(receipt)
    }
    onStep?.("checkout")
    const { branch } = receipt
    await mapLimit(membersOf(receipt), 4, async (member) => {
      if (!(await this.git.succeeds(member.repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])))
        await this.git.output(member.repoRoot, ["branch", "--no-track", branch, member.base])
    })
    const spare = existsSync(receipt.path) ? undefined : await this.fromSpare(receipt)
    await mkdir(receipt.path, { recursive: true, mode: 0o700 })
    // Names the project, as a spare of it does: started from another Thread's checkout (a Fin from its Apex's), `source`
    // is that checkout, which the repositories' worktrees are still made from, and the project is the one it's of.
    await writeFile(join(receipt.path, PROJECT_CHECKOUT_FILE), projectCheckoutText(this.homeOf(source)), { mode: 0o600 })
    await mapLimit(membersOf(receipt), 4, async (member) => {
      if (existsSync(join(member.path, ".git"))) {
        // A start cut short while placing a spare: its repository may still have the worktree where the spare was, and kept.
        if (!spare) {
          await this.git.output(member.repoRoot, ["worktree", "repair", member.path]).catch(() => {})
          await this.git.output(member.repoRoot, ["worktree", "unlock", member.path]).catch(() => {})
        }
        if (!(await this.git.succeeds(member.path, ["symbolic-ref", "-q", "HEAD"]))) await this.git.output(member.path, ["checkout", "-q", branch])
        return
      }
      await mkdir(dirname(member.path), { recursive: true, mode: 0o700 })
      try {
        await addWorktree(this.git, member.repoRoot, member.path, branch)
      } catch (error) {
        throw new Error(`Git couldn't create the worktree of ${relative(source, member.repoRoot)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    })
    const recipe = await this.setup?.recipe(receipt.path).catch(() => undefined)
    if (recipe?.carry?.length) onStep?.("carry")
    const { copied } = await this.borrowing.carry(conversationId, source, receipt.path, recipe?.carry ?? [])
    const ready: Receipt = { ...receipt, state: "ready", copied, tookMs: Math.round(performance.now() - began) }
    if (spare) ready.spare = true
    await this.save(ready)
    this.carryOutputs(conversationId, source, ready.path, recipe?.prepare ?? [])
    this.wantSpares(source)
    return ready
  }

  /**
   * The project a folder is a worktree of, however many starts back: a Fin starts from its Apex's worktree, which has no
   * spares of its own, and shares its repository with the project's.
   */
  private homeOf(folder: string): string {
    const roots = new Map<string, string>()
    for (const { path, repoRoot, project } of this.threads.worktrees()) {
      roots.set(path, repoRoot)
      // One repository of a project folder's checkout: the folder around it stands for the project.
      if (project !== repoRoot) roots.set(dirname(path), project)
    }
    const seen = new Set<string>()
    let home = folder
    for (let up = roots.get(home); up !== undefined && !seen.has(up); up = roots.get(home)) {
      seen.add(up)
      home = up
    }
    return home
  }

  private wantSpares(repoRoot: string): void {
    const wanted = this.spares.want(this.homeOf(repoRoot)).catch(() => {})
    this.wanting.add(wanted)
    void wanted.finally(() => this.wanting.delete(wanted))
  }

  /** A spare placed at the receipt's path and branched, or none; a spare that fails is given back and the send checks out fresh. */
  private async fromSpare(receipt: Receipt): Promise<Spare | undefined> {
    const members = membersOf(receipt)
    const home = this.homeOf(receipt.repoRoot)
    const atHome = (repoRoot: string) => join(home, relative(receipt.repoRoot, repoRoot))
    const spare = await this.spares.claim(home, receipt.members?.map((member) => atHome(member.repoRoot)))
    if (!spare) return undefined
    try {
      // Filed under the folder it started from, which a spare of the project isn't.
      await mkdir(dirname(receipt.path), { recursive: true, mode: 0o700 })
      await this.spares.place(spare, receipt.path, receipt.branch, members.map(({ repoRoot, base }) => ({ repoRoot: atHome(repoRoot), base })))
    } catch {
      await this.spares.discard(spare)
      if (!existsSync(receipt.path)) return undefined
      // Moved but not done: each repository told where its worktree is, no longer kept, and on its branch rather than detached.
      for (const member of members) {
        await this.git.output(member.repoRoot, ["worktree", "repair", member.path]).catch(() => {})
        await this.git.output(member.repoRoot, ["worktree", "unlock", member.path]).catch(() => {})
        if (!(await this.git.succeeds(member.path, ["symbolic-ref", "-q", "HEAD"]))) await this.git.output(member.path, ["checkout", "-q", receipt.branch])
      }
    }
    await this.spares.used(spare)
    // One taken is made again now, behind the rest of this start, not once it has finished.
    this.wantSpares(receipt.repoRoot)
    // A warmed spare must obey the current recipe as well as the current inputs.
    const recipe = await this.setup?.recipe(receipt.path)
    for (const outputs of spare.outputs) {
      const [main, here] = await Promise.all([inputsDigest(this.git, receipt.repoRoot, outputs.inputs), inputsDigest(this.git, receipt.path, outputs.inputs)])
      const step = recipe?.prepare.find((step) => step.command === outputs.command &&
        step.inputs.length === outputs.inputs.length && step.inputs.every((input, index) => input === outputs.inputs[index]))
      let removed = false
      for (const entry of outputs.entries) {
        if (main === outputs.digest && here === outputs.digest &&
          step?.outputs?.some((pattern) => matchesGlob(entry, pattern))) continue
        const aside = join(this.trash(), randomUUID())
        await mkdir(this.trash(), { recursive: true, mode: 0o700 })
        if (await rename(join(receipt.path, entry), aside).then(() => true, () => false)) void removeBelowAgents(aside)
        removed = true
      }
      // The record came with the spare; a step whose outputs went runs again.
      const record = removed ? await this.setup?.prepared(receipt.path) : undefined
      if (record && record.done[outputs.command] !== undefined) {
        const done = Object.fromEntries(Object.entries(record.done).filter(([command]) => command !== outputs.command))
        await this.setup!.savePrepared(receipt.path, { ...record, done })
      }
    }
    return spare
  }

  private carryOutputs(conversationId: string, repoRoot: string, path: string, steps: PrepareStep[]): void {
    const work = carryOutputs(this.git, repoRoot, path, steps, this.setup).catch((error): OutputsCarry => ({
      carried: [],
      skipped: [error instanceof Error ? error.message : String(error)],
    }))
    this.carrying.set(conversationId, work)
    for (const key of this.carrying.keys()) {
      if (this.carrying.size <= MAX_REMEMBERED_CARRIES) break
      this.carrying.delete(key)
    }
  }

  /**
   * The local branch a Thread working on an existing branch or pull request
   * checks out, made to track the remote's when only the remote has it, and
   * its commit. Refused while another checkout has it.
   */
  private async adopt(repoRoot: string, start: Exclude<WorktreeStart, { kind: "from" }>): Promise<{ branch: string; base: string }> {
    const has = (branch: string) => this.git.succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
    // A pull request is on the remote the project folder's branch pulls from.
    const pullRemote = async () =>
      (await this.starts.tracked(repoRoot, await this.git.output(repoRoot, ["symbolic-ref", "-q", "--short", "HEAD"]).catch(() => "")))?.remote ?? "origin"
    let branch: string
    if (start.kind === "pull" && start.cross) {
      branch = `pr-${start.number}`
      if (!(await has(branch))) {
        const remote = await pullRemote()
        try {
          await fetchQuietly(this.git, repoRoot, [remote, `refs/pull/${start.number}/head:refs/heads/${branch}`])
        } catch (error) {
          throw new Error(`Couldn't fetch #${start.number} from ${remote}. Check your connection, then try again.`, { cause: error })
        }
      }
    } else if (start.kind === "pull") {
      branch = start.branch
      if (!(await has(branch))) {
        const remote = await pullRemote()
        try {
          await fetchQuietly(this.git, repoRoot, [remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`])
        } catch (error) {
          throw new Error(`Couldn't fetch ${branch} for #${start.number} from ${remote}. Check your connection, then try again.`, { cause: error })
        }
        await this.git.output(repoRoot, ["branch", "--track", branch, `${remote}/${branch}`])
      }
    } else if (await has(start.branch)) branch = start.branch
    else {
      const remote = (await this.git.output(repoRoot, ["remote"])).split("\n").find((candidate) => candidate && start.branch.startsWith(`${candidate}/`))
      if (!remote || !(await this.git.succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/${start.branch}`])))
        throw new Error(`${start.branch} isn't in ${basename(repoRoot)} anymore. Choose another branch.`)
      branch = start.branch.slice(remote.length + 1)
      if (!(await has(branch))) await this.git.output(repoRoot, ["branch", "--track", branch, start.branch])
    }
    const holder = await this.git.output(repoRoot, ["for-each-ref", "--format=%(worktreepath)", `refs/heads/${branch}`]).catch(() => "")
    if (holder)
      throw new Error(`${branch} is checked out in ${holder === repoRoot ? "your project folder" : basename(holder)}. Git keeps a branch in one checkout at a time, so start a new branch from it instead.`)
    return { branch, base: await this.git.output(repoRoot, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`]) }
  }

  /** Whether `adopt` finds `branch` in this repository: a local branch, or a remote's named with its remote. */
  private async hasBranch(repoRoot: string, branch: string): Promise<boolean> {
    return await this.git.succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]) ||
      this.git.succeeds(repoRoot, ["show-ref", "--verify", "--quiet", `refs/remotes/${branch}`])
  }

  /** A folder name under `parent` nothing has yet, for a worktree on a branch that already has its name. */
  private freeFolder(parent: string, slug: string): string {
    for (let index = 1; index <= 50; index += 1) {
      const candidate = index === 1 ? slug : `${slug}-${index}`
      if (!existsSync(join(parent, candidate))) return candidate
    }
    return `${slug}-${randomUUID().slice(0, 6)}`
  }

  /**
   * A name no other worktree has, held by creating its branch at `base`. Git
   * creates a branch only when it doesn't exist, so two starts, in this host
   * or another sharing the folder, never get the same name and folder.
   */
  private async reserveSlug(repoRoot: string, parent: string, slug: string, base: string): Promise<string> {
    // A name whose branch has its file, or a folder, is passed over without asking Git. One whose branch Git has
    // packed away is found by the attempt itself, as a name another start takes at the same moment is.
    const branches = join(commonDirOf(repoRoot), "refs", "heads")
    for (const candidate of slugCandidates(slug)) {
      if (existsSync(join(branches, `${BRANCH_PREFIX}${candidate}`)) || existsSync(join(parent, candidate))) continue
      try {
        await this.git.output(repoRoot, ["branch", "--no-track", `${BRANCH_PREFIX}${candidate}`, base])
        return candidate
      } catch (error) {
        if (!(error instanceof GitError && /already exists/i.test(error.stderr))) throw error
      }
    }
    throw new Error(`Every name for this worktree is taken in ${basename(repoRoot)}. Remove some mako/ branches, then try again.`)
  }

  /** `reserveSlug` across a project folder's repositories: a name is held once every one has its branch, and given back by those that made it when one already had it. */
  private async reserveProjectSlug(members: readonly { repoRoot: string; base: string }[], parent: string, slug: string): Promise<string> {
    const taken = new Set<string>()
    for (const { repoRoot } of members)
      for (const branch of (await this.git.output(repoRoot, ["for-each-ref", "--format=%(refname:short)", `refs/heads/${BRANCH_PREFIX}`])).split("\n")) taken.add(branch)
    for (const candidate of slugCandidates(slug)) {
      const branch = `${BRANCH_PREFIX}${candidate}`
      if (taken.has(branch) || existsSync(join(parent, candidate))) continue
      const made: string[] = []
      try {
        for (const { repoRoot, base } of members) {
          await this.git.output(repoRoot, ["branch", "--no-track", branch, base])
          made.push(repoRoot)
        }
        return candidate
      } catch (error) {
        // The name is taken in one repository: the others give theirs back, and one that can't stops the start, never leaving it unsaid.
        const kept: string[] = []
        for (const repoRoot of made) {
          const refused = await this.dropBranch(repoRoot, branch)
          if (refused) kept.push(`${basename(repoRoot)}: ${refused}`)
        }
        if (kept.length) throw new Error(`Couldn't give back the branch ${branch} made for this worktree (${kept.join("; ")})`, { cause: error })
        if (!(error instanceof GitError && /already exists/i.test(error.stderr))) throw error
      }
    }
    throw new Error("Every name for this worktree is taken in one of the project's repositories. Remove some mako/ branches, then try again.")
  }
}

/**
 * A worktree of `repoRoot` at `path` on `branch`: added `--no-checkout`, the only part that writes what the
 * repository's checkouts share and so takes its turn (`Git.run`), then its files written as its own checkout's, outside
 * that turn, so a start's checkout of thousands of files never holds another Thread's start or abandon.
 */
async function addWorktree(git: Git, repoRoot: string, path: string, branch: string): Promise<void> {
  await git.output(repoRoot, ["worktree", "add", "--no-checkout", path, branch])
  await fillWorktree(git, path)
}

/** The first line Git said of a failed command (a `GitError`'s message is its error output), without its `error:`. */
function gitWords(failure: Error): string {
  return failure.message.split("\n").map((line) => line.replace(/^(error|fatal): /, "").trim()).find(Boolean) ?? ""
}

function slugCandidates(slug: string): string[] {
  const candidates = Array.from({ length: 50 }, (_, index) => index === 0 ? slug : `${slug}-${index + 1}`)
  candidates.push(`${slug}-${randomUUID().slice(0, 6)}`)
  return candidates
}

/** What a move by an earlier version told: a count of files, with no word on what stayed. */
function legacyOutcome(files: number): MoveOutcome {
  const none = { files: 0, lines: 0, paths: [] }
  return { came: { files, lines: 0, paths: [] }, stayed: { others: none, person: none, uncertain: none, unattributed: none }, split: [], brought: true, unstaged: [] }
}
