import { copyGitConflictContext } from "@/state/git-conflicts"
import { getMako } from "@/lib/bridge"
import { pushCurrentBranch, runGitRemote } from "@/state/git-push"
import type {
  CommitGenerationInput,
  PullRequestDraftInput,
  GitCommitEntry,
  GitDiff,
  GitCommitFile,
  GitFile,
} from "@/lib/types"

export type { GitCommitFile } from "@/lib/types"

export const git = {
  diff(path: string): Promise<GitDiff> {
    return getMako().gitDiff(path)
  },

  diffAll(): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return getMako().gitDiffAll()
  },

  commitFileDiff(hash: string, path: string): Promise<GitDiff> {
    return getMako().gitCommitFileDiff(hash, path)
  },

  commitDiffAll(hash: string): Promise<{ diffs: GitDiff[]; truncated: number }> {
    return getMako().gitCommitDiffAll(hash)
  },

  stage(paths: string[]): Promise<void> {
    return getMako().gitStage(paths)
  },

  unstage(paths: string[]): Promise<void> {
    return getMako().gitUnstage(paths)
  },

  discard(paths: string[]): Promise<{ stash: string }> {
    return getMako().gitDiscard(paths)
  },

  restoreDiscarded(stash: string): Promise<void> {
    return getMako().gitRestoreDiscarded(stash)
  },

  changedSince(ref: string): Promise<{ base: string; files: GitFile[] } | null> {
    return getMako().gitChangedSince(ref)
  },

  sinceDiff(base: string, path: string): Promise<GitDiff> {
    return getMako().gitSinceDiff(base, path)
  },

  stageAll(): Promise<void> {
    return getMako().gitStageAll()
  },

  unstageAll(): Promise<void> {
    return getMako().gitUnstageAll()
  },

  log(limit?: number): Promise<GitCommitEntry[]> {
    return getMako().gitLog(limit)
  },

  commitFiles(hash: string): Promise<GitCommitFile[]> {
    return getMako().gitCommitFiles(hash)
  },

  commit(message: string, options?: { amend?: boolean }): Promise<void> {
    return getMako().gitCommit(message, options)
  },

  remote: runGitRemote,

  copyConflictContext: copyGitConflictContext,

  push(): Promise<void> {
    return pushCurrentBranch()
  },

  generateMessage(input: CommitGenerationInput) {
    return getMako().generateCommitMessage(input)
  },

  draftPullRequest(input: PullRequestDraftInput) {
    return getMako().draftPullRequest(input)
  },

  cancelGeneration(requestId: string): Promise<void> {
    return getMako().cancelCommitGeneration(requestId)
  },

  defaultPrompt(): Promise<string> {
    return getMako().defaultCommitPrompt()
  },
}
