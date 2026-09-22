import { z } from "zod"
import { clientStorageScope } from "@/lib/client-storage-scope"
import { SessionSettingsSchema } from "@mako/sessions/settings"
import { PromptAttachmentSchema } from "../../electron/contracts/prompt-attachments"
import { hostCallInputs } from "../../electron/contracts/host-call-inputs"

const QueuedSchema = z.object({ kind: z.literal("queued"), startId: z.string(), requestId: z.string(),
  text: z.string(), attachments: z.array(PromptAttachmentSchema), tuning: SessionSettingsSchema.optional() })
const CommandSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prompt"), conversationId: z.string(), requestId: z.string(),
    text: z.string(), attachments: z.array(PromptAttachmentSchema), bindingId: z.string().optional(),
    tuning: SessionSettingsSchema.optional() }),
  z.object({ kind: z.literal("start"), args: hostCallInputs["mako:live-start"], draftKey: z.string() }),
  QueuedSchema,
])
const EntrySchema = z.object({ version: z.literal(1), createdAt: z.number(), command: CommandSchema })
export type OutboxCommand = z.infer<typeof CommandSchema>

export function durableAttachments(attachments: z.infer<typeof PromptAttachmentSchema>[]) {
  return attachments.map((attachment) => attachment.path ? { ...attachment, data: undefined } : attachment)
}

const known = new Set<string>()

// One storage entry per command: simultaneous tabs cannot overwrite each other's
// pending messages by saving competing copies of one array. Origins isolate web
// servers; profiles isolate maintainer hosts sharing a development origin.
function prefix(): string {
  const profile = clientStorageScope()
  return `mako.message-outbox.v1.${encodeURIComponent(profile)}.`
}
export function commandId(command: OutboxCommand): string {
  return command.kind !== "start" ? command.requestId : command.args[2].initialRequest?.id ?? command.args[2].conversationId
}
export function saveMessage(command: OutboxCommand): void {
  const key = prefix() + commandId(command)
  const previous = globalThis.localStorage?.getItem(key)
  if (previous) {
    const entry = EntrySchema.parse(JSON.parse(previous))
    if (entry.command.kind === "queued" && command.kind === "prompt" &&
        entry.command.requestId === command.requestId && entry.command.text === command.text &&
        JSON.stringify(entry.command.attachments) === JSON.stringify(command.attachments) &&
        JSON.stringify(entry.command.tuning) === JSON.stringify(command.tuning)) {
      globalThis.localStorage.setItem(key, JSON.stringify({ ...entry, command: CommandSchema.parse(command) }))
      known.add(commandId(command))
      return
    }
    if (JSON.stringify(entry.command) !== JSON.stringify(CommandSchema.parse(command)))
      throw new Error("A pending message already uses this request ID")
    known.add(commandId(command))
    return
  }
  if (!globalThis.localStorage) throw new Error("Message storage is unavailable. Your draft has not been sent.")
  globalThis.localStorage.setItem(key, JSON.stringify({ version: 1, createdAt: Date.now(), command: CommandSchema.parse(command) }))
  known.add(commandId(command))
}
export function settleMessage(id: string, receiptOnly = false): void {
  if (!known.has(id)) return
  // A failed removal leaves a safe replay of the same ID, never a new send.
  try {
    if (receiptOnly) {
      const entry = EntrySchema.parse(JSON.parse(globalThis.localStorage?.getItem(prefix() + id) ?? "null"))
      if (entry.command.kind !== "prompt") return
    }
    globalThis.localStorage?.removeItem(prefix() + id)
    known.delete(id)
  } catch { /* Retry receipt cleanup after reopening. */ }
}
export function pendingMessages(): OutboxCommand[] {
  const storage = globalThis.localStorage
  if (!storage) return []
  const entries: z.infer<typeof EntrySchema>[] = []
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index)
    if (!key?.startsWith(prefix())) continue
    let value: unknown
    try { value = JSON.parse(storage.getItem(key) ?? "null") } catch { continue }
    const entry = EntrySchema.safeParse(value)
    if (entry.success) { entries.push(entry.data); known.add(commandId(entry.data.command)) }
  }
  return entries.sort((a, b) => a.createdAt - b.createdAt).map((entry) => entry.command)
}

/** Storage events are delivered to other tabs, so a surviving client can recover. */
export function watchPendingMessages(recover: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const changed = (event: StorageEvent) => {
    if (!event.newValue || !event.key?.startsWith(prefix())) return
    if (timer) return
    timer = setTimeout(() => { timer = undefined; recover() }, 100)
  }
  window.addEventListener("storage", changed)
  return () => { clearTimeout(timer); window.removeEventListener("storage", changed) }
}
