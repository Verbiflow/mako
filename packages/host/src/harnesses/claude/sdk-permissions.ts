import { randomUUID } from "node:crypto"
import { stripVTControlCharacters } from "node:util"
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
import { hostLog } from "../../base/host-log.js"
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

/**
 * Why Claude Code asks, as its CLI says on the wire (`decision_reason_type`,
 * `decision_reason`). The Agent SDK hands both to canUseTool beside the
 * options it declares; one it stops passing reads as absent, and the call
 * then asks the person as before.
 */
const AskReasonSchema = z.object({
  decisionReasonType: z.string().optional(),
  decisionReason: z.string().optional(),
}).loose()

/**
 * A call Claude Code asks about because one of its safety checks tripped,
 * and no permission rule of the person's: an `rm` whose target a variable or
 * a command's output could turn into `/` or the home folder, a critical
 * system directory. For a compound command Claude may name the wrapper
 * (`subcommandResults`), whose reason is then the nested check's own text.
 */
function safetyCheck(options: { decisionReasonType?: string; decisionReason?: string; matchedAskRule?: unknown }): string | undefined {
  if (options.matchedAskRule || !options.decisionReason) return undefined
  if (options.decisionReasonType !== "safetyCheck" && options.decisionReasonType !== "subcommandResults") return undefined
  return stripVTControlCharacters(options.decisionReason)
}

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
  /** The session's permission mode now: Full access is `bypassPermissions`. */
  private readonly mode: () => PermissionMode | undefined
  constructor(id: string, emit: (event: LiveDriverEvent) => void, approvals?: ClaudeApprovalObserver, toolApprovals?: ClaudePermissionObserver, mode: () => PermissionMode | undefined = () => undefined) {
    this.approvals = approvals
    this.toolApprovals = toolApprovals
    this.id = id
    this.emit = emit
    this.mode = mode
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
    // Full access asks nothing: the one ask Claude Code still sends there, besides the
    // person's own ask rules and the agent's questions, is a safety check it reserves
    // for a person and never lets a rule allow. Its own desktop host declines those in
    // bypass without showing a card; so does Mako. The agent hears Claude's reason, which
    // names the rewrite that passes (a literal path, a `${D:?}` guard), and goes on.
    const check = name === "ExitPlanMode" || this.mode() !== "bypassPermissions" ? undefined : safetyCheck({ ...AskReasonSchema.parse(options), matchedAskRule: options.matchedAskRule })
    if (check !== undefined) {
      hostLog("claude-sdk", "full access declined a safety check", { conversation: this.id, tool: name, agent: options.agentID, reason: check })
      return { behavior: "deny", message: `${check}. Claude Code keeps this check for a person, and this session runs in Full access, which asks nobody: rewrite the command so it passes the check, as the check suggests, and run it again.` }
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
