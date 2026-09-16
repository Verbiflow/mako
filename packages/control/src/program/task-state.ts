import { z } from "zod"
import type { JsonObject, JsonValue } from "../json.js"

const TASK_STATE_KEY = "__mako_task"
const MAX_FACTS = 64
const MAX_ITEMS = 128
const MAX_FACT_BYTES = 4 * 1024

const boundedFactSchema = z.json().superRefine((value, context) => {
  if (Buffer.byteLength(JSON.stringify(value)) <= MAX_FACT_BYTES) return
  context.addIssue({
    code: "custom",
    message: `A remembered fact must fit in ${String(MAX_FACT_BYTES)} bytes; save large evidence as an artifact and remember its receipt.`,
  })
})

const factsSchema = z
  .record(z.string().min(1).max(120), boundedFactSchema)
  .refine((facts) => Object.keys(facts).length <= MAX_FACTS, {
    message: `Task state keeps at most ${String(MAX_FACTS)} named facts`,
  })
const itemsSchema = z.array(z.string().min(1).max(500)).max(MAX_ITEMS)

export const TaskMemorySchema = z.object({
  revision: z.number().int().nonnegative(),
  objective: z.string().min(1).max(4_000).optional(),
  location: z.string().min(1).max(1_000).optional(),
  facts: factsSchema,
  completed: itemsSchema,
  pending: itemsSchema,
})
export type TaskMemory = z.infer<typeof TaskMemorySchema>

export const TaskCheckpointSchema = z.object({
  objective: z.string().min(1).max(4_000).optional(),
  location: z.string().min(1).max(1_000).optional(),
  remember: factsSchema.optional(),
  completed: itemsSchema.optional(),
  pending: itemsSchema.optional(),
})
export type TaskCheckpoint = z.infer<typeof TaskCheckpointSchema>

const emptyMemory = (): TaskMemory => ({
  revision: 0,
  facts: {},
  completed: [],
  pending: [],
})

export function recallTask(state: Record<string, JsonValue>): TaskMemory {
  return TaskMemorySchema.catch(emptyMemory()).parse(state[TASK_STATE_KEY])
}

/**
 * Merge the small durable working set a later control cell needs. Raw trees,
 * images and prose belong in artifacts; this state is deliberately bounded.
 */
export function checkpointTask(
  state: Record<string, JsonValue>,
  input: JsonObject
): TaskMemory {
  const patch = TaskCheckpointSchema.parse(input)
  const current = recallTask(state)
  const completed = [...new Set([...current.completed, ...(patch.completed ?? [])])]
  const completedSet = new Set(completed)
  const pending = (patch.pending ?? current.pending).filter(
    (item) => !completedSet.has(item)
  )
  const next = TaskMemorySchema.parse({
    revision: current.revision + 1,
    objective: patch.objective ?? current.objective,
    location: patch.location ?? current.location,
    facts: { ...current.facts, ...patch.remember },
    completed,
    pending,
  })
  state[TASK_STATE_KEY] = next
  return next
}
