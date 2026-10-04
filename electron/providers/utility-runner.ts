import type { SessionModel } from "@mako/sessions/settings"
import { z } from "zod"
import type { ProviderCapability } from "./registry.js"

/** A JSON Schema, as the plain JSON object every runner and provider sends on. */
export const JsonSchemaSchema = z.record(z.string(), z.json())
export type JsonSchema = z.infer<typeof JsonSchemaSchema>

/** One request to a model through an agent app, outside every conversation. */
export interface UtilityCompletion {
  /** The model's id as the agent app's catalog names it. */
  model: string
  instructions: string
  prompt: string
  /** A JSON Schema the reply must match; the reply is then that JSON's text. */
  schema?: JsonSchema
  reasoning: "low" | "high"
  signal: AbortSignal
}

/**
 * Small, fast work through an agent app the person is signed in to, on
 * their own account: a Thread's title, a commit message. A request runs no
 * tools and leaves nothing in the app's history, so it never shows up as a
 * conversation and can't change any file.
 */
export interface ProviderUtilityRunner extends ProviderCapability {
  /** The model this app's own catalog offers for small, fast work, if it lists one. */
  light(models: readonly SessionModel[]): SessionModel | undefined
  /** The reply's text; throws `UtilityModelError` with a reason a person can act on. */
  complete(request: UtilityCompletion): Promise<string>
}

/** Words a catalog uses for its fast, inexpensive models, and for the ones it has replaced. */
const LIGHT = /\b(fast(est)?|affordable|cheap(est)?|lightweight|quick(est)?|small(est)?|mini|nano|lite|flash)\b/i
const RETIRED = /\b(older|legacy|previous|deprecated|retired)\b/i

/**
 * The first model a catalog describes as fast or inexpensive, read from its
 * own ids, names and descriptions rather than a list of known model names,
 * so a newer generation is found without a Mako release. Catalogs list
 * their newest models first; one the catalog calls older or legacy is
 * passed over while a current one qualifies.
 */
export function lightModel(models: readonly SessionModel[]): SessionModel | undefined {
  const text = (model: SessionModel) => [model.id, model.label, model.description ?? "", ...(model.aliases ?? [])].join(" ")
  const light = models.filter((model) => LIGHT.test(text(model)))
  return light.find((model) => !RETIRED.test(text(model))) ?? light[0]
}

/** A reply's JSON, without the Markdown fence some models wrap it in. */
export function jsonReply(reply: string): string {
  const trimmed = reply.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}
