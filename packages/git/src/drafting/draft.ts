import { GitError } from "../errors.js"
import { COMMIT_TIMEOUT_MS, commitMessage, pathList, staged, type Repository } from "../repository.js"
import { run } from "../run.js"
import { analyze, organize, synthesize } from "./analysis.js"
import { branchRange, captureStaged, captureWorktree, frozenIndex, readEvidence, stagedComparison, verifyFiles, verifyRefs, type Comparison, type Evidence, type Snapshot } from "./evidence.js"
import { ContextOverflow, MAX_CALLS, ModelSession, type DraftOptions } from "./model.js"
import { COMMIT_RULES, COMMIT_STYLE, PULL_REQUEST_RULES } from "./prompts.js"
import { CommitReply, PullRequestReply } from "./replies.js"
import type { z } from "zod"

export interface CommitDraft {
  root: string
  snapshot: Snapshot
  message: string
  files: number
  warnings: string[]
  /** Model requests the draft took. */
  calls: number
}

export interface PullRequestDraft {
  title: string
  body: string
  commits: number
  files: number
  warnings: string[]
  calls: number
}

/**
 * Writes from `evidence` in pieces the model reads at once; when a request
 * still turns out too long, the pieces halve and the work starts again.
 */
async function write<T>(evidence: Evidence, session: ModelSession, instructions: string, task: string, output: z.ZodType<T>, check: () => Promise<void>): Promise<T> {
  for (let chunk = session.chunkBytes; ; chunk = Math.max(4_096, Math.floor(chunk / 2))) {
    try {
      const prepared = organize(evidence, chunk)
      const analysis = await analyze(prepared, session)
      const result = await synthesize(prepared, analysis, session, instructions, task, output)
      await check()
      return result
    } catch (error) {
      if (!(error instanceof ContextOverflow) || chunk === 4_096) throw error
      await check()
    }
  }
}

/**
 * A message for what is staged, or for every change when nothing is. The
 * draft records exactly what it describes; committing it commits that or
 * nothing.
 */
export async function draftCommit(repository: Repository, options: DraftOptions): Promise<CommitDraft> {
  // A Stage pressed before Generate is part of what the draft describes.
  await repository.settled()
  const status = await repository.status()
  const session = new ModelSession(options)
  let snapshot: Snapshot
  let comparison: Comparison
  if (status.entries.some(staged)) {
    snapshot = await captureStaged(repository)
    comparison = await stagedComparison(repository, snapshot)
  } else {
    if (status.entries.length === 0) throw new GitError({ message: "There are no changes to describe." })
    if (status.entries.some((entry) => entry.conflicted)) throw new GitError({ kind: "conflicts", message: "Resolve merge conflicts before drafting a commit." })
    if (status.entries.some((entry) => entry.raw)) throw new GitError({ message: "A changed file's name isn't valid UTF-8. Stage the files to describe, then draft again." })
    const captured = await captureWorktree(repository, status.entries.map((entry) => entry.path))
    snapshot = captured.snapshot
    comparison = captured.comparison
  }
  try {
    const evidence = await readEvidence(repository, comparison, MAX_CALLS * session.chunkBytes, options.signal)
    const task = `Write a message for exactly the selected ${snapshot.scope} changes. Other files are outside this commit.`
    const { message } = await write(evidence, session, `${COMMIT_RULES}\n${options.style?.trim() || COMMIT_STYLE}`, task, CommitReply, () => verifyRefs(repository, snapshot))
    if (!message.trim()) throw new Error("The model's reply had no commit message. No draft was created.")
    return { root: repository.root, snapshot, message: commitMessage(message).trimEnd(), files: evidence.files.length, warnings: evidence.warnings, calls: session.calls }
  } finally {
    await comparison.dispose()
  }
}

/** A title and description for the commits `HEAD` has beyond `base`, a branch name. */
export async function draftPullRequest(repository: Repository, base: string, options: DraftOptions): Promise<PullRequestDraft> {
  const session = new ModelSession(options)
  const range = await branchRange(repository, base, options.signal)
  const head = await repository.head(options.signal)
  const evidence = await readEvidence(repository, { base: range.mergeBase, tree: range.tree, env: {}, dispose: async () => {} }, MAX_CALLS * session.chunkBytes, options.signal)
  const task = `Write the title and description of a pull request that merges ${range.commits.length === 1 ? "this commit" : `these ${range.commits.length} commits`} into ${base}. The changes below are what they make together.\nCOMMITS\n${range.commits.join("\n")}`
  const check = async () => {
    if ((await repository.head(options.signal)).oid !== head.oid) throw new GitError({ kind: "moved", message: "The branch moved while drafting. Draft again." })
  }
  const reply = await write(evidence, session, `${PULL_REQUEST_RULES}\n${options.style ?? ""}`.trim(), task, PullRequestReply, check)
  const title = reply.title.trim().split("\n")[0]!.trim()
  const body = reply.body.trim()
  if (!title) throw new Error("The model's reply had no title. No draft was created.")
  return { title: title.slice(0, 256), body: body.slice(0, 65_536), commits: range.commits.length, files: evidence.files.length, warnings: evidence.warnings, calls: session.calls }
}

/**
 * Commits exactly what `draft` describes, with `message`. HEAD, the branch,
 * the index and (for a working-tree draft) the files must be as the draft
 * found them; otherwise nothing is committed.
 */
export async function commitDraft(repository: Repository, draft: CommitDraft, message: string, signal?: AbortSignal): Promise<string> {
  const text = commitMessage(message)
  const { snapshot } = draft
  return repository.write(async () => {
    try {
      if (repository.operation()) throw new GitError({ message: "Finish the current merge, rebase, or cherry-pick before committing a draft." })
      await verifyRefs(repository, snapshot)
      if (snapshot.scope === "working-tree") {
        await verifyFiles(repository, snapshot)
        await run({ cwd: repository.root, args: ["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], input: pathList(snapshot.paths) })
      }
      const frozen = await frozenIndex(repository)
      try {
        const env = { GIT_INDEX_FILE: frozen.path }
        const tree = (await run({ cwd: repository.root, args: ["write-tree"], env })).stdout.toString("utf8").trim()
        if (tree !== snapshot.tree) {
          if (snapshot.scope === "working-tree")
            await run({ cwd: repository.root, args: snapshot.head ? ["reset", "-q", "--pathspec-from-file=-", "--pathspec-file-nul"] : ["rm", "--cached", "-r", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], input: pathList(snapshot.paths), codes: [1] })
          throw new GitError({ kind: "moved", message: "The files changed while committing. Nothing was committed; generate a fresh draft." })
        }
        let failure: Error | undefined
        try {
          await run({ cwd: repository.root, args: ["commit", "--cleanup=whitespace", "--file=-"], input: text, env, timeoutMs: COMMIT_TIMEOUT_MS, signal })
        } catch (error) {
          failure = error instanceof Error ? error : new Error(String(error))
        }
        return await observe(repository, snapshot, tree, failure)
      } finally {
        await frozen.dispose()
      }
    } finally {
      repository.changedAll("committed a draft")
    }
  })
}

/**
 * What the commit did, judged by HEAD after it: a new commit on the same
 * branch, on the expected parent. Anything else is reported, never retried.
 */
async function observe(repository: Repository, snapshot: Snapshot, tree: string, failure: Error | undefined): Promise<string> {
  const after = await repository.head().catch(() => null)
  if (!after) throw new GitError({ message: "Commit outcome needs review: HEAD couldn't be read. Do not retry automatically.", cause: failure })
  const ref = await run({ cwd: repository.root, args: ["symbolic-ref", "-q", "HEAD"], codes: [1] }).then((result) => result.code === 0 ? result.stdout.toString("utf8").trim() : null, () => undefined)
  if (after.oid && after.oid !== snapshot.head && ref === snapshot.headRef) {
    const shown = await run({ cwd: repository.root, args: ["show", "-s", "--format=%P%x00%T", after.oid] }).then((result) => result.stdout.toString("utf8").trim().split("\0"), () => [])
    if ((shown[0] ?? "") === (snapshot.head ?? "") && (!failure || shown[1] === tree)) return after.oid
  }
  if (after.oid !== snapshot.head || !failure)
    throw new GitError({ kind: "moved", message: `Commit outcome needs review. Observed HEAD: ${after.oid ?? "unborn"}. Do not retry automatically.`, cause: failure })
  throw failure
}
