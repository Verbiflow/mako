import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { OpenCodeClient, OpenCodeEvent } from "@opencode/client"
import { z } from "zod"
import type { LiveDriverEvent, LivePermissionRequest, LivePermissionResponse } from "../../shared.js"
import type { NativeApprovalIdentity } from "../../contracts/approval-response.js"
import type { ApprovalDispatch } from "../live-driver.js"
import { RetainedApprovalDecisions, readRetainedApprovalDecisions } from "../retained-approval-decisions.js"
import { readLegacyOpenCodeDecisions } from "./legacy-approval-decisions.js"
import { approvalAnswerDigest } from "../approval-evidence.js"
import { hostWarn } from "../../host-log.js"
import { NativeForm, openCodeQuestions, openCodeFormAnswer, openCodeAnswerDigest } from "./forms.js"
import { openCodeToolKind } from "./content.js"

const NativePermission = z.object({
  id: z.string().min(1).max(512), sessionID: z.string().min(1).max(512), action: z.string(), message: z.string().optional(),
  resources: z.array(z.string()), save: z.array(z.string()).optional(),
  source: z.object({ type: z.literal("tool"), id: z.string() }).optional(),
})
type NativePermission = z.infer<typeof NativePermission>
interface Pending { request: LivePermissionRequest; kind: "form" | "permission"; sessionID: string; id: string; sending: boolean }
/** Retained per connection; older completions leave first. */
const MAX_COMPLETED = 2000
const MAX_PENDING = 256

interface InteractionsInput {
  client: OpenCodeClient; root: string; conversationId: string;
  owns(sessionID: string): boolean; emit(event: LiveDriverEvent): void
  /** The live row title of the tool that asked, and a child session's label. */
  describe?(sessionID: string, toolID: string | undefined): { title?: string; prefix?: string }
}

/** Native wire and exact occurrence ownership; the shared host owns receipts/UI. */
export class OpenCodeInteractions {
  private readonly input: InteractionsInput
  private readonly store: RetainedApprovalDecisions
  private readonly pending = new Map<string, Pending>()
  private readonly completed = new Set<string>()
  private stopped = false
  constructor(input: InteractionsInput) {
    this.input = input
    this.store = new RetainedApprovalDecisions(join(input.root, "opencode-native"))
  }

  async restore(previous: readonly NativeApprovalIdentity[]): Promise<void> {
    for (const decision of [
      ...await readRetainedApprovalDecisions(join(this.input.root, "opencode-native"), previous),
      ...await readLegacyOpenCodeDecisions(join(this.input.root, "opencode"), previous),
    ]) if (!this.stopped) this.input.emit({ type: "live-approval-decision", id: this.input.conversationId, decision })
  }
  async observe(event: OpenCodeEvent): Promise<void> {
    if (this.stopped) return
    if (event.type === "form.created") {
      if (!this.input.owns(event.data.form.sessionID)) return
      const form = NativeForm.parse(event.data.form)
      this.add("form", form.sessionID, form.id, this.formTitle(form.sessionID, form.title), openCodeQuestions(form))
    } else if (event.type === "permission.asked") {
      if (!this.input.owns(event.data.sessionID)) return
      this.permission(NativePermission.parse(event.data))
    } else if (event.type === "form.replied") {
      await this.decide(event.data.sessionID, event.data.id, openCodeAnswerDigest(event.data.answer), event.created)
    } else if (event.type === "permission.replied") {
      await this.decide(event.data.sessionID, event.data.requestID, approvalAnswerDigest({ kind: "choice", optionId: event.data.reply }), event.created)
    } else if (event.type === "form.cancelled") {
      await this.decide(event.data.sessionID, event.data.id, approvalAnswerDigest({ kind: "choice", optionId: null }), event.created)
    }
  }
  private formTitle(sessionID: string, title: string): string {
    const prefix = this.input.describe?.(sessionID, undefined).prefix
    return prefix ? `${prefix}${title}` : title
  }
  private permission(permission: NativePermission): void {
    const described = this.input.describe?.(permission.sessionID, permission.source?.id) ?? {}
    const subject = permission.message ?? described.title ?? (permission.resources.join(", ") || permission.action)
    const save = permission.save?.filter(pattern => pattern !== "*") ?? []
    this.add("permission", permission.sessionID, permission.id, `${described.prefix ?? ""}${subject}`, undefined, openCodeToolKind(permission.action), [
      { optionId: "once", name: "Allow once", kind: "allow_once" },
      // OpenCode saves "always" as a project rule for these patterns, beyond this session.
      { optionId: "always", name: save.length ? `Always allow ${save.join(", ")}` : "Always allow", kind: "allow_always" },
      { optionId: "reject", name: "Reject", kind: "reject_once" },
    ])
  }
  private key(sessionID: string, id: string): string { return JSON.stringify([sessionID, id]) }
  private add(kind: Pending["kind"], sessionID: string, id: string, title: string, questions?: LivePermissionRequest["questions"],
    toolKind?: string, options: LivePermissionRequest["options"] = []): void {
    const key = this.key(sessionID, id)
    if (this.pending.has(key) || this.completed.has(key)) return
    if (this.pending.size >= MAX_PENDING) {
      hostWarn("opencode", "more native requests are pending than one conversation can show", { conversation: this.input.conversationId })
      return
    }
    const request: LivePermissionRequest = {
      id: randomUUID(), observationId: randomUUID(), sessionId: this.input.conversationId,
      native: { scope: this.store.scope, sessionId: sessionID, requestId: id }, title, questions, options,
    }
    if (toolKind) request.kind = toolKind
    this.pending.set(key, { request, kind, sessionID, id, sending: false })
    this.input.emit({ type: "live-permission", request })
  }
  private async decide(sessionID: string, id: string, answerDigest: string, observedAt: number): Promise<void> {
    const key = this.key(sessionID, id)
    const pending = this.pending.get(key)
    if (!pending?.request.native || this.stopped) return
    // The native resolution ends the request whether or not its evidence is retained.
    this.end(key, pending, "native-resolution")
    try {
      const decision = await this.store.record({ identity: pending.request.native, answerDigest, observedAt })
      if (!this.stopped) this.input.emit({ type: "live-approval-decision", id: this.input.conversationId, decision })
    } catch (error) {
      hostWarn("opencode", "a native decision could not be retained", { conversation: this.input.conversationId, error: error instanceof Error ? error.message : String(error) })
    }
  }
  private end(key: string, pending: Pending, source: "native-resolution" | "connection-close"): void {
    this.pending.delete(key)
    this.completed.add(key)
    if (this.completed.size > MAX_COMPLETED) this.completed.delete(this.completed.values().next().value!)
    this.input.emit({ type: "live-permission-ended", id: this.input.conversationId, requestId: pending.request.id,
      observationId: pending.request.observationId!, source })
  }
  /** Native state after a gap in the event stream. Requests that vanished were resolved natively. */
  async reconcile(sessionID: string): Promise<void> {
    if (this.stopped) return
    const forms = await this.input.client.form.list({ sessionID })
    const permissions = await this.input.client.permission.list({ sessionID })
    for (const form of forms) {
      const parsed = NativeForm.parse(form)
      this.add("form", sessionID, parsed.id, this.formTitle(sessionID, parsed.title), openCodeQuestions(parsed))
    }
    const open = new Set<string>()
    for (const permission of permissions) {
      const parsed = NativePermission.parse(permission)
      open.add(parsed.id)
      this.permission(parsed)
    }
    for (const [key, pending] of [...this.pending]) {
      if (pending.sessionID !== sessionID) continue
      if (pending.kind === "permission") {
        // Permission APIs keep no answer history; only the event carries the choice.
        if (!open.has(pending.id)) this.end(key, pending, "native-resolution")
        continue
      }
      const state = await this.input.client.form.state({ sessionID, formID: pending.id })
      if (state.status === "answered") await this.decide(sessionID, pending.id, openCodeAnswerDigest(state.answer), Date.now())
      else if (state.status === "cancelled") await this.decide(sessionID, pending.id, approvalAnswerDigest({ kind: "choice", optionId: null }), Date.now())
    }
  }
  async respond(requestId: string, response: LivePermissionResponse, dispatch: ApprovalDispatch): Promise<void> {
    const pending = [...this.pending.values()].find(item => item.request.id === requestId)
    if (!pending || this.stopped) { dispatch.report({ kind: "not-submitted", pending: false, reason: "request-ended" }); return }
    if (pending.sending) { dispatch.report({ kind: "uncertain", reason: "This answer was already dispatched" }); return }
    let answer: ReturnType<typeof openCodeFormAnswer>
    try {
      if (pending.kind === "form") answer = openCodeFormAnswer(pending.request.questions ?? [], response)
      else if (response.kind !== "choice" || (response.optionId !== null && !["once", "always", "reject"].includes(response.optionId))) throw new Error("Invalid native permission choice")
    } catch { dispatch.report({ kind: "not-submitted", pending: true, reason: "invalid-answer" }); return }
    dispatch.assertCurrent()
    pending.sending = true
    try {
      if (pending.kind === "permission") await this.input.client.permission.reply({ sessionID: pending.sessionID, requestID: pending.id, reply: response.kind === "choice" && response.optionId === "once" ? "once" : response.kind === "choice" && response.optionId === "always" ? "always" : "reject" })
      else if (answer) await this.input.client.form.reply({ sessionID: pending.sessionID, formID: pending.id, answer })
      else await this.input.client.form.cancel({ sessionID: pending.sessionID, formID: pending.id })
      dispatch.report({ kind: "submitted", source: "transport-write" })
    } catch (error) {
      dispatch.report({ kind: "uncertain", reason: error instanceof Error ? error.message : "Native answer response was lost" })
    }
    // A form state is independent native evidence even when the reply was lost.
    if (pending.kind === "form") await this.reconcile(pending.sessionID).catch(() => {})
  }
  async close(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    for (const [key, pending] of this.pending) this.end(key, pending, "connection-close")
    await this.store.close()
  }
}

export function openCodeApprovalDigest(request: LivePermissionRequest, response: LivePermissionResponse): string | undefined {
  if (request.questions) {
    const answer = openCodeFormAnswer(request.questions, response)
    return answer ? openCodeAnswerDigest(answer) : approvalAnswerDigest({ kind: "choice", optionId: null })
  }
  return response.kind === "choice" ? approvalAnswerDigest({ kind: "choice", optionId: response.optionId ?? "reject" }) : undefined
}
