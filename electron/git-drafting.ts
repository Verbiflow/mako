import { z } from "zod"
import { commitDraft, draftCommit, draftPullRequest, knownRepository, openRepository, type CommitDraft, type DraftOptions } from "@mako/git"
import type { CommitGenerationInput, CommitGenerationResult, PullRequestDraftInput, PullRequestDraftResult } from "./shared.js"
import { parseAgentModelId, utilityModelName } from "./contracts/utility-work.js"
import { pullRequestDraftPrompt } from "./contracts/git-actions.js"
import { UtilityModelError } from "./utility-model-error.js"
import type { UtilityModel, UtilityWork } from "./utility-work.js"
import { hostWarn } from "./host-log.js"

const mode = z.enum(["fast", "deep"]).default("fast")
const commitInput = z.object({ mode, requestId: z.string().uuid(), cwd: z.string().min(1).max(4_096), prompt: z.string().max(12_000).optional(), model: z.string().max(400).optional() })
const pullInput = z.object({ mode, requestId: z.string().uuid(), cwd: z.string().min(1).max(4_096), base: z.string().min(1).max(255), model: z.string().max(400).optional() })

/** A model connection answers each request in seconds. */
const CONNECTION_TIMEOUT_MS = 120_000
/** A harness starts a process for each request, so the same work takes longer. */
const AGENT_TIMEOUT_MS = 300_000

function draftKey(client: string, cwd: string): string {
  return JSON.stringify([client, cwd])
}

/**
 * Commit messages and pull request descriptions, written by the model Mako's
 * model system picks for them (`UtilityWork`, task `commit`): the same
 * choice, harness order and connections as every other small job. One draft
 * at a time per window; a commit message draft is kept so that committing
 * it commits exactly what it describes.
 */
export class GitDrafting {
  private readonly active = new Map<string, { id: string; controller: AbortController }>()
  private readonly drafts = new Map<string, CommitDraft>()
  private readonly work: UtilityWork

  constructor(work: UtilityWork) {
    this.work = work
  }

  private async draft<T>(client: string, requestId: string, requested: string | undefined, write: (model: UtilityModel, options: Omit<DraftOptions, "model" | "mode" | "style">) => Promise<T>): Promise<T> {
    if (this.active.has(client)) throw new Error("A draft is already being written in this window.")
    const controller = new AbortController()
    this.active.set(client, { id: requestId, controller })
    let signal = controller.signal
    let model: UtilityModel | undefined
    try {
      const resolved = await this.work.resolve("commit", requested)
      if (resolved.kind === "unavailable") throw new Error(resolved.reason)
      model = resolved.model
      signal = AbortSignal.any([controller.signal, AbortSignal.timeout(parseAgentModelId(model.id) ? AGENT_TIMEOUT_MS : CONNECTION_TIMEOUT_MS)])
      return await write(model, { signal, tooLong: (error) => error instanceof UtilityModelError && error.kind === "context" })
    } catch (error) {
      if (controller.signal.aborted) throw new UtilityModelError("timeout", "Generation cancelled.")
      if (signal.aborted) {
        hostWarn("git-drafting", "draft timed out", { model: model?.id })
        throw new UtilityModelError("timeout", "Generation timed out. Completed summaries are reused on retry.")
      }
      hostWarn("git-drafting", "draft failed", { model: model?.id, kind: error instanceof UtilityModelError ? error.kind : undefined, message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      if (this.active.get(client)?.controller === controller) this.active.delete(client)
    }
  }

  async commitMessage(client: string, input: CommitGenerationInput): Promise<CommitGenerationResult> {
    const parsed = commitInput.safeParse(input)
    if (!parsed.success) throw new Error("Invalid commit-generation request. Keep custom instructions under 12,000 characters.")
    const request = parsed.data
    const key = draftKey(client, request.cwd)
    this.drafts.delete(key)
    return this.draft(client, request.requestId, request.model, async (model, options) => {
      const repository = await openRepository(request.cwd, options.signal)
      if (!repository) throw new Error("This folder is not a Git repository")
      const draft = await draftCommit(repository, { ...options, model, mode: request.mode, style: request.prompt })
      this.drafts.set(key, draft)
      return { message: draft.message, model: model.id, modelLabel: utilityModelName(model), scope: draft.snapshot.scope, files: draft.files, warnings: draft.warnings, requests: draft.calls }
    })
  }

  async pullRequest(client: string, input: PullRequestDraftInput, template: string | null): Promise<PullRequestDraftResult> {
    const parsed = pullInput.safeParse(input)
    if (!parsed.success) throw new Error("Invalid pull request draft request.")
    const request = parsed.data
    return this.draft(client, request.requestId, request.model, async (model, options) => {
      const repository = await openRepository(request.cwd, options.signal)
      if (!repository) throw new Error("This folder is not a Git repository")
      const draft = await draftPullRequest(repository, request.base, { ...options, model, mode: request.mode, style: pullRequestDraftPrompt(template) })
      return { title: draft.title, body: draft.body, model: model.id, modelLabel: utilityModelName(model), commits: draft.commits, files: draft.files, warnings: draft.warnings, requests: draft.calls }
    })
  }

  cancel(client: string, requestId: string): void {
    const request = this.active.get(client)
    if (request?.id === requestId) {
      request.controller.abort()
      this.active.delete(client)
    }
  }

  /**
   * Commits `message`: what this window's draft described when it has one,
   * else what is staged (everything when nothing is). A draft is used once,
   * so after a refusal the next Commit commits what is there now.
   */
  async commit(client: string, cwd: string, message: string): Promise<void> {
    const key = draftKey(client, cwd)
    const reviewed = this.drafts.get(key)
    this.drafts.delete(key)
    const repository = knownRepository(cwd) ?? await openRepository(cwd)
    if (!repository) throw new Error("This folder is not a Git repository")
    if (reviewed && reviewed.root === repository.root) await commitDraft(repository, reviewed, message)
    else await repository.commit({ message })
  }
}
