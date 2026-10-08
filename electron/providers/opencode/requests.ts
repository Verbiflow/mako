import type { OpenCodeEvent } from "@opencode/client"
import { z } from "zod"
import type { LivePermissionResponse } from "../../shared.js"
import { NativeForm, NativeFormAnswer, openCodeFormResponse } from "./forms.js"

export const NativePermission = z.object({
  id: z.string().min(1).max(512), sessionID: z.string().min(1).max(512), action: z.string(), message: z.string().optional(),
  resources: z.array(z.string()), save: z.array(z.string()).optional(),
  source: z.object({ type: z.literal("tool"), id: z.string() }).optional(),
})
export type NativePermission = z.infer<typeof NativePermission>
export type NativeFormRequest = z.infer<typeof NativeForm>

/** A permission or form OpenCode asked in a session, or how one ended. */
export type OpenCodeRequest =
  | { type: "form"; form: NativeFormRequest }
  | { type: "permission"; permission: NativePermission }
  /** Answered or dismissed, from Mako or any other client; `at` is OpenCode's time. */
  | { type: "resolved"; sessionID: string; id: string; answer: LivePermissionResponse; at: number }

export const OPENCODE_REQUESTS = new Set<string>(["form.created", "form.replied", "form.cancelled", "permission.asked", "permission.replied"])

const FormReplied = z.object({ sessionID: z.string(), id: z.string(), answer: NativeFormAnswer })
const PermissionReplied = z.object({ sessionID: z.string(), requestID: z.string(), reply: z.string() })
const FormCancelled = z.object({ sessionID: z.string(), id: z.string() })

/** The request an event of `OPENCODE_REQUESTS` carries; undefined when its payload doesn't read. */
export function openCodeRequest(event: OpenCodeEvent): OpenCodeRequest | undefined {
  switch (event.type) {
    case "form.created": {
      const form = NativeForm.safeParse(event.data.form).data
      return form && { type: "form", form }
    }
    case "permission.asked": {
      const permission = NativePermission.safeParse(event.data).data
      return permission && { type: "permission", permission }
    }
    case "form.replied": {
      const reply = FormReplied.safeParse(event.data).data
      return reply && { type: "resolved", sessionID: reply.sessionID, id: reply.id, answer: openCodeFormResponse(reply.answer), at: event.created }
    }
    case "permission.replied": {
      const reply = PermissionReplied.safeParse(event.data).data
      return reply && { type: "resolved", sessionID: reply.sessionID, id: reply.requestID, answer: { kind: "choice", optionId: reply.reply }, at: event.created }
    }
    case "form.cancelled": {
      const cancel = FormCancelled.safeParse(event.data).data
      return cancel && { type: "resolved", sessionID: cancel.sessionID, id: cancel.id, answer: { kind: "choice", optionId: null }, at: event.created }
    }
    default:
      return undefined
  }
}

/** The session a request belongs to. */
export function openCodeRequestSession(request: OpenCodeRequest): string {
  return request.type === "form" ? request.form.sessionID : request.type === "permission" ? request.permission.sessionID : request.sessionID
}
