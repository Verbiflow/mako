import { randomUUID } from "node:crypto"
import type { ApprovalSubmission, ApprovalEndSource } from "../../contracts/approval-response.js"
import { claudeProposedPlan } from "@mako/sessions/claude-projection"
import { planFeedbackMessage } from "@mako/sessions/harnesses"
import type { CanUseTool, OnElicitation, PermissionMode, PermissionUpdate } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { ClaudeApprovalObserver } from "./approval-observer.js"
import type { ClaudePermissionObserver } from "./permission-observer.js"
import type { LiveDriverEvent } from "../../contracts/live-conversations.js"
import type { LivePermissionRequest, LivePermissionResponse } from "../../contracts/providers-acp.js"
import { heavy } from "../../base/heavy-packages.js"
import { adapters } from "../heavy.js"

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
/** The settings files Claude saves a "don't ask again" rule to, as its suggestions name them. */
const SAVED_DESTINATIONS = new Set<PermissionUpdate["destination"]>(["localSettings", "projectSettings", "userSettings"])
const WHERE = { localSettings: "in this project", projectSettings: "for everyone in this project", userSettings: "in every project", session: "for this session", cliArg: "for this session" } as const

/** "Always allow Bash(npm test:*) in this project": the rules Claude would save, and where. */
function alwaysLabel(updates: readonly PermissionUpdate[]): string {
  const rules = updates.flatMap((update) => update.type === "addRules" || update.type === "replaceRules" ? update.rules.map((rule) => `${rule.toolName}${rule.ruleContent ? `(${rule.ruleContent})` : ""}`) : [])
  const where = WHERE[updates[0]?.destination ?? "localSettings"]
  if (!rules.length || rules.join(", ").length > 80) return `Always allow ${where}`
  return `Always allow ${rules.join(", ")} ${where}`
}

const ToolPathSchema = z.object({
  command: z.string().optional(),
  file_path: z.string().optional(),
})

export class ClaudePermissions {
  private readonly pending = new Map<
    string,
    (response: LivePermissionResponse, ended?: ApprovalEndSource) => void
  >()
  private readonly id: string
  private readonly emit: (event: LiveDriverEvent) => void
  private readonly approvals: ClaudeApprovalObserver | undefined
  private readonly toolApprovals: ClaudePermissionObserver | undefined
  /**
   * The mode Plan replaced, to return to when its plan is approved. Without
   * it Claude leaves Plan for `default` and asks before every edit, whatever
   * access the session had before planning.
   */
  planReturn: PermissionMode | undefined
  constructor(id: string, emit: (event: LiveDriverEvent) => void, approvals?: ClaudeApprovalObserver, toolApprovals?: ClaudePermissionObserver) {
    this.approvals = approvals
    this.toolApprovals = toolApprovals
    this.id = id
    this.emit = emit
  }

  get open(): number {
    return this.pending.size
  }

  respond(id: string, response: LivePermissionResponse): ApprovalSubmission {
    const resolve = this.pending.get(id)
    if (!resolve) return { kind: "not-submitted", pending: false, reason: "request-ended" }
    resolve(response)
    return { kind: "submitted", source: "callback" }
  }

  close(): void {
    for (const resolve of this.pending.values())
      resolve({ kind: "choice", optionId: null }, "connection-close")
  }

  private ask(
    request: Omit<LivePermissionRequest, "sessionId">,
    signal: AbortSignal
  ): Promise<LivePermissionResponse> {
    if (signal.aborted)
      return Promise.resolve({ kind: "choice", optionId: null })
    if (this.pending.has(request.id))
      throw new Error("Claude repeated a pending permission request")
    const observationId = randomUUID()
    return new Promise((resolve) => {
      const abort = () => settle({ kind: "choice", optionId: null }, "request-aborted")
      const settle = (response: LivePermissionResponse, ended?: ApprovalEndSource) => {
        this.pending.delete(request.id)
        signal.removeEventListener("abort", abort)
        if (ended) this.emit({ type: "live-permission-ended", id: this.id, requestId: request.id, observationId, source: ended })
        resolve(response)
      }
      this.pending.set(request.id, settle)
      signal.addEventListener("abort", abort, { once: true })
      this.emit({
        type: "live-permission",
        request: { ...request, observationId, sessionId: this.id },
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
          native: !options.agentID ? this.approvals?.identify(options.toolUseID) : undefined,
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
    const session = options.suggestions?.filter((item) => item.destination === "session") ?? []
    // The rules Claude itself would save for "don't ask again", in the settings
    // file it names; Claude writes them when they come back as updatedPermissions.
    const saved = name === "ExitPlanMode" || options.suppressAlwaysAllowRule ? [] : (options.suggestions ?? []).filter((item) => SAVED_DESTINATIONS.has(item.destination))
    const remembered = [
      ...(session.length ? [{ optionId: "allow_session", name: "Allow for this session", kind: "allow_always" }] : []),
      ...(saved.length ? [{ optionId: "allow_always", name: alwaysLabel(saved), kind: "allow_always" }] : []),
    ]
    const request: Omit<LivePermissionRequest, "sessionId"> = {
        id: options.requestId,
        native: !options.agentID && !options.signal.aborted ? this.toolApprovals?.identify(options.toolUseID, remembered.length === 1 ? remembered[0]?.optionId ?? null : null) : undefined,
        title,
        kind: name,
        options: [
          {
            optionId: "allow_once",
            name: name === "ExitPlanMode" ? "Approve plan" : "Allow once",
            kind: "allow_once",
          },
          ...remembered,
          {
            optionId: "reject_once",
            name: name === "ExitPlanMode" ? "Keep planning" : "Decline",
            kind: "reject_once",
          },
        ],
      }
    if (name === "ExitPlanMode") {
      request.implementsPlan = { plan: options.toolUseID, approve: "allow_once" }
      request.feedbackOption = "reject_once"
    }
    const response = await this.ask(request, options.signal)
    if (
      response.kind !== "choice" ||
      !["allow_once", "allow_session", "allow_always"].includes(response.optionId ?? "")
    )
      return {
        behavior: "deny",
        decisionClassification: response.kind === "choice" && response.optionId === "reject_once"
          ? "user_reject" : undefined,
        message:
          name !== "ExitPlanMode"
            ? "The user declined this tool request"
            : response.kind === "choice" && response.feedback
              ? planFeedbackMessage(response.feedback)
              : "The user has not approved implementation. Continue planning.",
      }
    const leavePlan: PermissionUpdate[] | undefined =
      name === "ExitPlanMode" && this.planReturn && this.planReturn !== "plan"
        ? [{ type: "setMode", mode: this.planReturn, destination: "session" }]
        : undefined
    return {
      behavior: "allow",
      // Native telemetry otherwise infers allow-once even when it applies session rules.
      // This describes the submitted choice; it is not an acknowledgement from Claude.
      decisionClassification: response.optionId === "allow_once" ? "user_temporary" : "user_permanent",
      updatedInput: input,
      updatedPermissions: leavePlan ?? (response.optionId === "allow_session" ? session : response.optionId === "allow_always" ? saved : undefined),
    }
  }

  readonly elicitation: OnElicitation = async (request, options) => {
    const [{ ElicitRequestFormParamsSchema }, { elicitationContent, elicitationQuestion }] =
      await Promise.all([heavy.mcpTypes.load("claude elicitation"), adapters.acpElicitation.load("claude elicitation")])
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
