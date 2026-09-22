import { getMako } from "@/lib/bridge"
import { pushCurrentBranch, runGitRemote } from "@/state/git-push"
import type {
  CommitGenerationInput,
  GitCommitEntry,
  GitDiff,
  GitCommitFile,
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

  push(): Promise<void> {
    return pushCurrentBranch()
  },

  generateMessage(input: CommitGenerationInput) {
    return getMako().generateCommitMessage(input)
  },

  cancelGeneration(requestId: string): Promise<void> {
    return getMako().cancelCommitGeneration(requestId)
  },

  defaultPrompt(): Promise<string> {
    return getMako().defaultCommitPrompt()
  },
}
