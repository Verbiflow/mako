import { z } from "zod"

const JsonValue = z.json()

/** A JSON Schema as a model request carries it. */
export const JsonSchemaSchema = z.record(z.string(), JsonValue)
export type JsonSchema = z.infer<typeof JsonSchemaSchema>

/** What a model is sent for `schema`; its reply is parsed with the same schema. */
export function jsonSchema(schema: z.ZodType): JsonSchema {
  const sent = JsonSchemaSchema.parse(z.toJSONSchema(schema))
  delete sent.$schema
  return sent
}

/** A model's reply as `schema`, or undefined when it isn't JSON of that shape. */
export function parseReply<T>(schema: z.ZodType<T>, reply: string): T | undefined {
  let value: z.infer<typeof JsonValue>
  try {
    value = JsonValue.parse(JSON.parse(reply))
  } catch {
    return undefined
  }
  const parsed = schema.safeParse(value)
  return parsed.success ? parsed.data : undefined
}

export const CommitReply = z.strictObject({ message: z.string() })
export const PullRequestReply = z.strictObject({ title: z.string(), body: z.string() })
