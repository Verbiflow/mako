import { createHash } from "node:crypto"
import { z } from "zod"
import type {
  CaptureScope,
  CommitDraft,
  CommitPlan,
  KiriRepository,
  RepoPath,
} from "@kiri/client"
import type { UtilityTokenCounter } from "./utility-token-count.js"
import type {
  CommitAnalysisMode,
  CommitGenerationResult,
  UtilityConnection,
} from "./shared.js"
import {
  completeUtilityText,
  UtilityModelError,
  type UtilityLanguageModel,
} from "./utility-models.js"
import {
  registerKiriModel,
  withKiriRepository,
  closeKiriEngine,
} from "./kiri-engine.js"
import { hostWarn } from "./host-log.js"

interface ProposalInput {
  client: string
  cwd: string
  model: UtilityLanguageModel
  mode?: CommitAnalysisMode
  connection: UtilityConnection
  prompt?: string
  countTokens?: UtilityTokenCounter
  signal: AbortSignal
}

interface PlanInput extends ProposalInput {
  paths?: RepoPath[] | null
  scope?: CaptureScope
}

function draftKey(client: string, cwd: string): string {
  return JSON.stringify([client, cwd])
}

export class KiriCommitEngine {
  private readonly drafts = new Map<string, CommitDraft>()

  private async propose<T>(
    input: ProposalInput,
    paths: RepoPath[] | null,
    scope: CaptureScope,
    create: (
      repo: KiriRepository,
      prepared: number,
      model: string,
      identity: string
    ) => Promise<T>
  ): Promise<{ proposal: T; files: number }> {
    const mode = input.mode ?? "fast"
    const reasoning = mode === "deep" ? "high" : "low"
    const outputTokens = Math.min(
      mode === "deep" ? 8_192 : 2_048,
      Math.floor(input.connection.contextTokens / 4)
    )
    return withKiriRepository(input.cwd, async (repo, client) => {
      if (!repo) throw new Error("This folder is not a Git repository")
      const binding = registerKiriModel(async (call, signal) => {
        try {
          const instructions = `${call.system}\nReturn only JSON matching this schema:\n${JSON.stringify(call.schema)}`
          const budget = input.connection.contextTokens - outputTokens - 256
          if (
            Buffer.byteLength(instructions) + Buffer.byteLength(call.input) >
            budget
          ) {
            const tokens = await input.countTokens?.({
              instructions,
              prompt: call.input,
              signal,
            })
            if (tokens != null && tokens > budget)
              throw new UtilityModelError(
                "context",
                "The request exceeds this model's context window."
              )
          }
          const schema = z.fromJSONSchema(
            z.record(z.string(), z.unknown()).parse(call.schema)
          )
          return await completeUtilityText(
            input.model,
            instructions,
            call.input,
            signal,
            outputTokens,
            schema,
            reasoning
          )
        } catch (error) {
          const { KiriError } = await import("@kiri/client")
          const kind =
            error instanceof UtilityModelError ? error.kind : "request"
          const message =
            error instanceof UtilityModelError
              ? error.message
              : "The model request failed."
          hostWarn("commit-model", "Kiri model call failed", {
            kind,
            message,
            model: `${input.connection.provider}/${input.connection.model}`,
            mode,
            schema: JSON.stringify(call.schema).slice(0, 200),
            cause:
              error instanceof UtilityModelError
                ? undefined
                : String(error).slice(0, 200),
          })
          throw new KiriError(kind, message)
        }
      })
      let prepared: number | null = null
      try {
        const evidence = await repo.prepare(
          paths,
          {
            mode,
            concurrency: 3,
            chunk_bytes: Math.min(
              1_048_576,
              Math.max(
                4_096,
                (input.connection.contextTokens - outputTokens - 2_048) * 4
              )
            ),
            max_calls: 80,
          },
          input.signal,
          scope
        )
        prepared = evidence.prepared
        const identity = createHash("sha256")
          .update(
            JSON.stringify([
              input.connection.provider,
              input.connection.model,
              input.connection.baseUrl,
              input.connection.contextTokens,
              mode,
            ])
          )
          .digest("hex")
        return {
          proposal: await create(repo, prepared, binding.handle, identity),
          files: evidence.files,
        }
      } finally {
        binding.release()
        if (prepared !== null)
          await client.request({ method: "release", prepared })
      }
    })
  }

  async generate(input: ProposalInput): Promise<CommitGenerationResult> {
    const key = draftKey(input.client, input.cwd)
    this.drafts.delete(key)
    const { proposal: draft, files } = await this.propose(
      input,
      null,
      "auto",
      (repo, prepared, model, identity) =>
        repo.draft(prepared, model, input.prompt, input.signal, identity)
    )
    this.drafts.set(key, draft)
    return {
      message: draft.message,
      model: `${input.connection.provider}/${input.connection.model}`,
      scope: draft.snapshot.source === "staged" ? "staged" : "working-tree",
      files,
      warnings: draft.warnings,
      requests: draft.analysis?.model_calls ?? 0,
    }
  }

  async plan(input: PlanInput): Promise<CommitPlan> {
    const { proposal } = await this.propose(
      input,
      input.paths ?? null,
      input.scope ?? "auto",
      (repo, prepared, model, identity) =>
        repo.plan(prepared, model, input.prompt, input.signal, identity)
    )
    return proposal
  }

  async applyPlan(cwd: string, plan: CommitPlan): Promise<string[]> {
    return withKiriRepository(cwd, async (repo) => {
      if (!repo) throw new Error("This folder is not a Git repository")
      return repo.applyPlan(plan)
    })
  }

  async dispose(): Promise<void> {
    this.drafts.clear()
    await closeKiriEngine()
  }

  async commit(clientId: string, cwd: string, message: string): Promise<void> {
    const key = draftKey(clientId, cwd)
    const reviewed = this.drafts.get(key)
    await withKiriRepository(cwd, async (repo, client) => {
      if (!repo) throw new Error("This folder is not a Git repository")
      if (reviewed) await repo.commit({ ...reviewed, message })
      else
        await client.request({
          method: "commit_message",
          repo: repo.id,
          message,
          amend: false,
        })
    })
    this.drafts.delete(key)
  }
}
