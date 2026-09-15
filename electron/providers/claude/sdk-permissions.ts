import { claudeProposedPlan } from "./sdk-plan.js"
import type { CanUseTool, OnElicitation } from "@anthropic-ai/claude-agent-sdk"
import { ElicitRequestFormParamsSchema } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import {
  elicitationContent,
  elicitationQuestion,
} from "../../acp-elicitation.js"
import type {
  LiveDriverEvent,
  LivePermissionRequest,
  LivePermissionResponse,
} from "../../shared.js"

const QuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        header: z.string(),
        question: z.string(),
        multiSelect: z.boolean().optional(),
        options: z.array(
          z.object({ label: z.string(), description: z.string() })
        ),
      })
    )
    .min(1)
    .max(10),
})
const ToolPathSchema = z.object({
  command: z.string().optional(),
  file_path: z.string().optional(),
})

export class ClaudePermissions {
  private readonly pending = new Map<
    string,
    (response: LivePermissionResponse) => void
  >()
  private readonly id: string
  private readonly emit: (event: LiveDriverEvent) => void
  constructor(id: string, emit: (event: LiveDriverEvent) => void) {
    this.id = id
    this.emit = emit
  }

  respond(id: string, response: LivePermissionResponse): void {
    const resolve = this.pending.get(id)
    if (!resolve) throw new Error("This Claude request is no longer pending")
    resolve(response)
  }

  close(): void {
    for (const resolve of this.pending.values())
      resolve({ kind: "choice", optionId: null })
  }

  private ask(
    request: Omit<LivePermissionRequest, "sessionId">,
    signal: AbortSignal
  ): Promise<LivePermissionResponse> {
    if (signal.aborted)
      return Promise.resolve({ kind: "choice", optionId: null })
    if (this.pending.has(request.id))
      throw new Error("Claude repeated a pending permission request")
    return new Promise((resolve) => {
      const abort = () => settle({ kind: "choice", optionId: null })
      const settle = (response: LivePermissionResponse) => {
        this.pending.delete(request.id)
        signal.removeEventListener("abort", abort)
        resolve(response)
      }
      this.pending.set(request.id, settle)
      signal.addEventListener("abort", abort, { once: true })
      this.emit({
        type: "live-permission",
        request: { ...request, sessionId: this.id },
      })
    })
  }

  readonly tool: CanUseTool = async (name, input, options) => {
    if (!options.agentID) {
      const updates = claudeProposedPlan({ name, input, id: options.toolUseID })
      if (updates.length)
        this.emit({ type: "live-updates", id: this.id, updates })
    }
    if (name === "AskUserQuestion") {
      const parsed = QuestionsSchema.parse(input)
      const response = await this.ask(
        {
          id: options.requestId,
          title: "Claude has a question",
          options: [],
          questions: parsed.questions.map((question, index) => ({
            id: String(index),
            header: question.header,
            question: question.question,
            isSecret: false,
            allowOther: true,
            required: true,
            valueType: question.multiSelect ? "string-array" : "string",
            options: question.options,
          })),
        },
        options.signal
      )
      if (response.kind !== "answers")
        return { behavior: "deny", message: "The user dismissed the question" }
      const answers: Record<string, string> = {}
      for (const [index, question] of parsed.questions.entries()) {
        const values = response.answers[String(index)]
        if (!values?.length)
          return { behavior: "deny", message: "A required answer is missing" }
        answers[question.question] = values.join(", ")
      }
      return { behavior: "allow", updatedInput: { ...input, answers } }
    }
    const detail = ToolPathSchema.parse(input)
    const title =
      (name === "ExitPlanMode"
        ? "Start implementing the proposed plan?"
        : options.title) ??
      `${name}${detail.file_path || detail.command ? `: ${(detail.file_path ?? detail.command ?? "").slice(0, 1000)}` : ""}`
    const response = await this.ask(
      {
        id: options.requestId,
        title,
        kind: name,
        options: [
          {
            optionId: "allow_once",
            name: name === "ExitPlanMode" ? "Approve plan" : "Allow once",
            kind: "allow_once",
          },
          ...(options.suggestions?.some(
            (item) => item.destination === "session"
          )
            ? [
                {
                  optionId: "allow_session",
                  name: "Allow for this session",
                  kind: "allow_always",
                },
              ]
            : []),
          {
            optionId: "reject_once",
            name: name === "ExitPlanMode" ? "Keep planning" : "Decline",
            kind: "reject_once",
          },
        ],
      },
      options.signal
    )
    if (
      response.kind !== "choice" ||
      !["allow_once", "allow_session"].includes(response.optionId ?? "")
    )
      return {
        behavior: "deny",
        message:
          name === "ExitPlanMode"
            ? "The user has not approved implementation. Continue planning."
            : "The user declined this tool request",
      }
    return {
      behavior: "allow",
      updatedInput: input,
      updatedPermissions:
        response.optionId === "allow_session"
          ? options.suggestions?.filter(
              (item) => item.destination === "session"
            )
          : undefined,
    }
  }

  readonly elicitation: OnElicitation = async (request, options) => {
    const parsed = ElicitRequestFormParamsSchema.safeParse(request)
    if (!parsed.success) return { action: "cancel" }
    const schema = parsed.data.requestedSchema
    const required = new Set(schema.required ?? [])
    const questions = Object.entries(schema.properties)
      .map(([id, property]) =>
        elicitationQuestion(id, property, required.has(id))
      )
      .filter((question) => question !== null)
    if (questions.length !== Object.keys(schema.properties).length)
      return { action: "cancel" }
    const response = await this.ask(
      { id: options.requestId, title: request.message, options: [], questions },
      options.signal
    )
    if (response.kind !== "answers") return { action: "decline" }
    const content = elicitationContent(questions, response.answers)
    return content ? { action: "accept", content } : { action: "decline" }
  }
}
