import { z } from "zod"
import { ThreadIdSchema } from "./ids.js"

const Label = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const OwnershipGeneration = z.number().int().positive().max(Number.MAX_SAFE_INTEGER).brand<"SessionOwnershipGeneration">()
export const ProjectPathSchema = z.string().min(1).max(1024).refine((value) =>
  /^\/(Users|home)\//.test(value) && !value.endsWith("/") && !value.includes("\\") &&
  !value.includes("\0") && !value.includes("//") && !value.split("/").some((part) => part === "." || part === ".."))
const Repository = z.string().max(256).regex(/^https:\/\/github\.com\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\/[A-Za-z0-9_-][A-Za-z0-9_.-]*$/)
  .refine((value) => !value.endsWith(".git") && !value.endsWith(".") && !value.includes(".."))
  .transform((value) => value.toLowerCase())
const SlotId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/)
export const SourceSessionFenceSchema = z.object({ session: z.uuid(), ownershipGeneration: OwnershipGeneration }).strict()
export type SourceSessionFence = z.infer<typeof SourceSessionFenceSchema>
export const ProjectSlotSchema = z.object({
  slot: SlotId, kind: z.enum(["primary", "secondary"]), url: Repository,
  repositoryId: Label, path: ProjectPathSchema, checkpoint: Digest,
  branch: z.string().max(200).regex(/^(?![-/.])(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9_./-]+(?<![./])$/).optional(),
}).strict()
export type ProjectSlot = z.infer<typeof ProjectSlotSchema>
const order = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0
export const ProjectManifestSchema = z.object({
  version: z.literal(2), move: z.uuid(), sourceThread: z.uuid(), destination: ThreadIdSchema, project: ProjectPathSchema,
  sessions: z.array(SourceSessionFenceSchema).min(1).max(32), slots: z.array(ProjectSlotSchema).min(1).max(32),
}).strict().superRefine((manifest, context) => {
  const paths: string[] = []
  const slots = new Set<string>(), repositories = new Set<string>(), sessions = new Set<string>()
  for (const session of manifest.sessions) {
    if (sessions.has(session.session)) context.addIssue({ code: "custom", message: "duplicate session" })
    sessions.add(session.session)
  }
  for (const slot of manifest.slots) {
    if (slots.has(slot.slot) || repositories.has(slot.url)) context.addIssue({ code: "custom", message: "duplicate slot or repository" })
    if (!slot.path.startsWith(`${manifest.project}/`) || paths.some((path) => path === slot.path || path.startsWith(`${slot.path}/`) || slot.path.startsWith(`${path}/`)))
      context.addIssue({ code: "custom", message: "path outside project or overlapping" })
    slots.add(slot.slot); repositories.add(slot.url); paths.push(slot.path)
  }
  if (manifest.slots.filter((slot) => slot.kind === "primary").length !== 1) context.addIssue({ code: "custom", message: "one primary required" })
}).transform((manifest) => ({
  version: manifest.version, move: manifest.move, sourceThread: manifest.sourceThread, destination: manifest.destination, project: manifest.project,
  sessions: [...manifest.sessions].sort((a, b) => order(a.session, b.session)),
  slots: [...manifest.slots].sort((a, b) => order(a.slot, b.slot)),
}))
export type ProjectManifest = z.infer<typeof ProjectManifestSchema>
export const RegisterProjectSchema = z.object({ manifest: ProjectManifestSchema, expiresAt: z.number().int().positive() }).strict()
export const ProjectRequestSchema = z.object({ grant: z.uuid(), digest: Digest, revision: z.number().int().positive() }).strict()
export const SlotRequestSchema = ProjectRequestSchema.extend({ slot: SlotId, operation: z.uuid() }).strict()
export const FinalizeSlotSchema = ProjectRequestSchema.extend({ reservation: z.uuid() }).strict()
export type ProjectRequest = z.infer<typeof ProjectRequestSchema>
export const RuntimeCapabilitySchema = z.object({
  machine: Label, machineGeneration: z.number().int().positive().brand<"MachineGeneration">(), boot: Label, destination: ThreadIdSchema,
  agent: z.object({ preparationVersion: z.literal(2), build: Label, sourceDigest: Digest }).strict(),
  host: z.object({ preparationVersion: z.literal(2), build: Label, sourceDigest: Digest }).strict(),
}).strict()
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>
export const PreparationBindingSchema = ProjectRequestSchema.extend({ runtime: RuntimeCapabilitySchema }).strict()
const CompletedSlot = z.object({ slot: SlotId, repositoryId: Label, path: ProjectPathSchema }).strict()
const ReadySlot = z.discriminatedUnion("state", [
  CompletedSlot.extend({ state: z.literal("clone-ready") }).strict(),
  CompletedSlot.extend({ state: z.literal("preview-checkpoint-applied"), checkpoint: Digest }).strict(),
])
export const ReadyReceiptSchema = z.object({
  phase: z.literal("ready-for-arrival"), binding: PreparationBindingSchema, operation: z.uuid(), slots: z.array(ReadySlot).min(1).max(32),
}).strict()
export const ArrivalReceiptSchema = z.object({
  phase: z.literal("arrival-applied"), binding: PreparationBindingSchema, operation: z.uuid(), handoffDigest: Digest,
  slots: z.array(CompletedSlot.extend({ state: z.literal("checkpoint-applied"), checkpoint: Digest }).strict()).min(1).max(32),
}).strict()
export const PreparationReceiptSchema = z.discriminatedUnion("phase", [ReadyReceiptSchema, ArrivalReceiptSchema])
export type PreparationReceipt = z.infer<typeof PreparationReceiptSchema>
export const ReleaseRequestSchema = ProjectRequestSchema.extend({ readyHandle: Digest, operation: z.uuid() }).strict()
export const BindHandoverSchema = ProjectRequestSchema.extend({ release: z.uuid(), handover: z.uuid() }).strict()
export const ClaimRequestSchema = ProjectRequestSchema.extend({ arrivalHandle: Digest, operation: z.uuid() }).strict()
export type ClaimRequest = z.infer<typeof ClaimRequestSchema>
export const KnownGitHubRoleSchema = z.enum(["none", "read", "triage", "write", "maintain", "admin"])
const ReadCapabilitySchema = z.unknown().transform(role =>
  role === "read" || role === "triage" || role === "write" || role === "maintain" || role === "admin")
export const readCapableRole = ReadCapabilitySchema.parse

/** Data decoded by the bounded descriptor copier; no functions, undefined values or accessor properties. */
export type PlainProtocolValue = string | number | boolean | null | PlainProtocolValue[] | { [key: string]: PlainProtocolValue }

/** Runtime schemas do not authenticate caller objects. Reject/charge data before copying, never serialize a graph to measure it. */
export function plainProtocolValue(input: unknown): PlainProtocolValue {
  let remaining = 4096, bytes = 32768
  const visited = new WeakSet<object>()
  const charge = (count: number): void => { bytes -= count; if (bytes < 0) throw new Error("bad-input") }
  const string = (value: string): void => {
    charge(2) // JSON quotes
    for (let index = 0; index < value.length; index++) {
      const code = value.charCodeAt(index)
      if (code === 34 || code === 92) charge(2)
      else if (code < 32) charge(code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6)
      else if (code < 128) charge(1)
      else if (code < 2048) charge(2)
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) { charge(4); index++ }
      else charge(code >= 0xd800 && code <= 0xdfff ? 6 : 3)
    }
  }
  const copy = (value: unknown, depth: number): PlainProtocolValue => {
    if (--remaining < 0 || depth > 16) throw new Error("bad-input")
    if (typeof value === "string") { string(value); return value }
    if (value === null) { charge(4); return null }
    if (typeof value === "boolean") { charge(value ? 4 : 5); return value }
    if (typeof value === "number" && Number.isFinite(value)) { charge(String(value).length); return value }
    if (typeof value !== "object" || visited.has(value)) throw new Error("bad-input")
    visited.add(value)
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error("bad-input")
    // JS own-key enumeration (including Proxy traps) is not preemptible. No descriptor graph/value vector is made.
    const keys = Reflect.ownKeys(value)
    if (keys.length > remaining + 1) throw new Error("bad-input")
    charge(2) // container delimiters
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, "length"), length: unknown = descriptor?.value
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 4096 || keys.length !== length + 1) throw new Error("bad-input")
      const output: PlainProtocolValue[] = []
      for (let index = 0; index < length; index++) {
        if (index) charge(1)
        const entry = Object.getOwnPropertyDescriptor(value, String(index))
        if (!entry || !("value" in entry) || !entry.enumerable) throw new Error("bad-input")
        output.push(copy(entry.value, depth + 1))
      }
      return output
    }
    const output: Record<string, PlainProtocolValue> = Object.create(null) // locally constructed data-only properties
    let first = true
    for (const key of keys) {
      if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("bad-input")
      if (!first) charge(1)
      first = false
      string(key); charge(1) // key and colon charged before descriptor lookup/value copy
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) throw new Error("bad-input")
      output[key] = copy(descriptor.value, depth + 1)
    }
    return output
  }
  return copy(input, 0)
}
