import { open, stat } from "node:fs/promises"
import { z } from "zod"
import { parseLine, readLineBatch } from "@mako/sessions/jsonl"
import type { ProviderBinding } from "../../contracts/conversation-control.js"
import type { NativeQuestionHistory } from "../../contracts/live-questions.js"
import { codexAnsweredQuestions, codexAsyncQuestion, CodexAsyncQuestionsSchema } from "./questions.js"

const Completed = z.object({
  type: z.literal("item_completed"), thread_id: z.string(), turn_id: z.string().min(1),
  item: z.object({ type: z.string(), id: z.string().min(1), delivery: z.string().optional(), questions: z.unknown().optional(), content: z.array(z.unknown()).optional() }),
})
const Text = z.object({ type: z.enum(["text", "input_text"]), text: z.string() })
const UserMessage = z.object({ type: z.literal("message"), role: z.literal("user"), content: z.array(z.unknown()) })
const CompletedTag = z.object({ type: z.literal("item_completed") })
function userText(content: unknown[]): string {
  return content.flatMap(part => {
    const text = Text.safeParse(part)
    return text.success ? [text.data.text] : []
  }).join("\n")
}
interface Scan {
  identity: string
  sessionId: string
  size: number
  mtime: number
  ctime: number
  anchor: string
  bytes: number
  entries: NativeQuestionHistory
}

async function anchor(path: string, end: number): Promise<string> {
  const file = await open(path, "r")
  try {
    const bytes = Buffer.alloc(Math.min(128, end))
    const read = await file.read(bytes, 0, bytes.length, end - bytes.length)
    return bytes.subarray(0, read.bytesRead).toString("base64")
  } finally { await file.close() }
}

/** Native rollouts are append-only. Cache only validated, complete prefixes. */
export function createCodexQuestionHistory() {
  const cache = new Map<string, Scan>()
  const pending = new Map<string, Promise<NativeQuestionHistory>>()
  async function scan(path: string, sessionId: string): Promise<NativeQuestionHistory> {
    const info = await stat(path)
    const identity = `${info.dev}:${info.ino}`
    const saved = cache.get(path)
    const previous = saved?.identity === identity && saved.sessionId === sessionId ? saved : undefined
    if (previous && info.size === previous.size && info.mtimeMs === previous.mtime && info.ctimeMs === previous.ctime) {
      cache.delete(path); cache.set(path, previous)
      return structuredClone(previous.entries)
    }
    const append = previous && info.size > previous.size && await anchor(path, previous.size) === previous.anchor
    const entries: NativeQuestionHistory = append ? structuredClone(previous.entries) : []
    const byItem = new Map<string, NativeQuestionHistory>()
    for (const entry of entries) {
      byItem.set(entry.question.itemId, [...(byItem.get(entry.question.itemId) ?? []), entry])
    }
    let verified = Boolean(append)
    const answer = (text: string) => {
      for (const reply of codexAnsweredQuestions(sessionId, text)) {
        const matches = byItem.get(reply.itemId)
        if (matches?.length !== 1) continue
        const entry = matches[0]!
        entry.answered = [...new Set([...entry.answered, ...reply.questionIds.filter(id => entry.question.questions.some(q => q.id === id))])]
      }
    }
    const read = await readLineBatch(path, append ? previous.size : 0, line => {
      if (!line.trim()) return
      const record = parseLine(line)
      if (!record) throw new Error("Native question history contains an unreadable record")
      if (record.type === "session_meta") {
        const meta = z.object({ id: z.literal(sessionId) }).parse(record.payload)
        verified = meta.id === sessionId
        return
      }
      if (!verified) throw new Error("Native question history has no matching session identity")
      if (record.type === "event_msg") {
        const event = Completed.safeParse(record.payload)
        if (!event.success) {
          if (CompletedTag.safeParse(record.payload).success)
            throw new Error("Native question history has an invalid completed item")
          return
        }
        if (event.data.thread_id !== sessionId) return
        const { item, turn_id } = event.data
        if (item.type === "AgentMessage" && item.delivery === "async" && item.questions !== undefined) {
          const question = codexAsyncQuestion(sessionId, turn_id, item.id, CodexAsyncQuestionsSchema.parse(item.questions))
          if (byItem.get(item.id)?.some(entry => entry.question.turnId === turn_id)) return
          const entry = { question, answered: [] }
          if (entries.length >= 2000)
            throw new Error("Native question history exceeds the evidence capacity")
          entries.push(entry)
          byItem.set(item.id, [...(byItem.get(item.id) ?? []), entry])
        } else if (item.type === "UserMessage") {
          if (item.content) answer(userText(item.content))
        }
      } else if (record.type === "response_item") {
        const user = UserMessage.safeParse(record.payload)
        if (user.success) answer(userText(user.data.content))
      }
    }, { identity, strict: true })
    const after = await stat(path)
    if (!verified || read.nextByte !== read.size || after.size !== read.size || `${after.dev}:${after.ino}` !== identity || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
      throw new Error("Native question history is still changing; refresh before answering")
    const next: Scan = { identity, sessionId, size: read.size, mtime: after.mtimeMs, ctime: after.ctimeMs, anchor: await anchor(path, read.size), entries, bytes: Buffer.byteLength(JSON.stringify(entries)) }
    cache.delete(path)
    // Evict the cache, not valid evidence, when a question is unusually large.
    if (next.bytes <= 16 * 1024 * 1024) cache.set(path, next)
    let bytes = [...cache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    while (cache.size > 4 || bytes > 16 * 1024 * 1024) {
      const oldest = cache.keys().next().value!
      bytes -= cache.get(oldest)!.bytes
      cache.delete(oldest)
    }
    return structuredClone(entries)
  }
  return (binding: Pick<ProviderBinding, "path" | "nativeId">): Promise<NativeQuestionHistory> => {
    if (!binding.path || !binding.nativeId) return Promise.reject(new Error("The native source for this question has not been found"))
    const key = JSON.stringify([binding.path, binding.nativeId])
    const existing = pending.get(key)
    if (existing) return existing
    const result = scan(binding.path, binding.nativeId)
    pending.set(key, result)
    void result.finally(() => pending.delete(key)).catch(() => {})
    return result
  }
}

export const codexQuestionHistory = createCodexQuestionHistory()
