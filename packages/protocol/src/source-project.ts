import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"
import { ProjectSlotSchema, ProjectPathSchema, plainProtocolValue } from "./handoff-project.js"

/** HTTP control only. No new link target, version allocation, clone authority or Machine assertion. */
export const SOURCE_PROJECT_PATH = "/v1/source-project"
export const SOURCE_PROJECT_INTERNAL_PATH = "/internal/source-project"
const Revision = z.number().int().positive().safe()
export const SourceProjectSelectionSchema = z.object({
  move: z.uuid(), destination: ThreadIdSchema, sourceThread: z.uuid(),
  project: ProjectPathSchema,
  locators: z.array(ProjectSlotSchema.omit({ repositoryId: true }).strict()).min(1).max(32),
  sessions: z.array(z.object({ session: z.uuid(), generation: Revision }).strict()).min(1).max(32),
}).strict().superRefine((value, ctx) => {
  const slots = new Set<string>(), paths: string[] = [], urls = new Set<string>()
  if (value.locators.filter(slot => slot.kind === "primary").length !== 1 || new Set(value.sessions.map(row => row.session)).size !== value.sessions.length) ctx.addIssue({ code: "custom", message: "invalid selected cohort" })
  for (const slot of value.locators) {
    if (!slot.path.startsWith(value.project + "/") || slots.has(slot.slot) || urls.has(slot.url) || paths.some(path => path === slot.path || path.startsWith(slot.path + "/") || slot.path.startsWith(path + "/"))) ctx.addIssue({ code: "custom", message: "invalid selected membership" })
    slots.add(slot.slot); urls.add(slot.url); paths.push(slot.path)
  }
})
export type SourceProjectSelection = z.infer<typeof SourceProjectSelectionSchema>
export const SourceProjectPublishSchema = z.object({ action: z.literal("publish"), revision: Revision, expiresAt: Revision, selection: SourceProjectSelectionSchema }).strict()
export const SourceProjectCommandSchema = z.discriminatedUnion("action", [
  SourceProjectPublishSchema,
  z.object({ action: z.enum(["read", "invalidate"]), move: z.uuid(), revision: Revision, digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(),
])
export type SourceProjectCommand = z.infer<typeof SourceProjectCommandSchema>
export const SourceProjectReceiptSchema = z.object({
  move: z.uuid(), revision: Revision, digest: z.string().regex(/^[0-9a-f]{64}$/),
  phase: z.enum(["invalidated", "ready"]), expiresAt: Revision, historical: z.boolean(), secondaryAdmission: z.literal(false),
}).strict()
export type SourceProjectReceipt = z.infer<typeof SourceProjectReceiptSchema>
export const sourceProjectCommand = z.preprocess(plainProtocolValue, SourceProjectCommandSchema).parse

/** Bound each read/cancel and aggregate bytes before copying. No body or rejection text escapes. */
export async function readSourceProjectBody(request: Request): Promise<Uint8Array> {
  const reader = request.body?.getReader()
  if (!reader) throw new Error("source-project-body")
  const stopAt = performance.now() + 1000
  const wait = async <T>(work: Promise<T>, until = stopAt): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const remaining = until - performance.now()
    if (remaining <= 0) throw new Error("source-project-body")
    try {
      const result = await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("source-project-body")), remaining) })])
      if (performance.now() >= until) throw new Error("source-project-body")
      return result
    }
    finally { if (timer) clearTimeout(timer) }
  }
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) { const next = await wait(reader.read()); if (next.done) break; bytes += next.value.byteLength; if (bytes > 32768 || chunks.length >= 4096) throw new Error("source-project-body"); chunks.push(next.value) }
  } finally { await wait(reader.cancel(), performance.now() + 1000) }
  const body = new Uint8Array(bytes); let offset = 0
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength }
  return body
}
