import type { SettingValue } from "@mako/sessions/settings"
import { z } from "zod"
import type { ProviderCapability } from "./registry.js"

/** A JSON Schema, as the plain JSON object every runner and provider sends on. */
export const JsonSchemaSchema = z.record(z.string(), z.json())
export type JsonSchema = z.infer<typeof JsonSchemaSchema>

/** One request to a model through a harness, outside every conversation. */
export interface UtilityCompletion {
  /** The model's id as the harness's catalog names it. */
  model: string
  /** The model's options by the catalog's ids: its reasoning level, its fast lane. */
  options: Readonly<Record<string, SettingValue>>
  instructions: string
  prompt: string
  /** A JSON Schema the reply must match; the reply is then that JSON's text. */
  schema?: JsonSchema
  signal: AbortSignal
}

/**
 * Small, fast work through a harness the person is signed in to, on their
 * own account: a Thread's title, a commit message. A request runs no tools
 * and leaves nothing in the harness's history, so it never shows up as a
 * conversation and can't change any file. Which model it runs on is
 * `harness-defaults.ts`'s to say.
 */
export interface ProviderUtilityRunner extends ProviderCapability {
  /**
   * The reply's text; throws `UtilityModelError` with a reason a person can
   * act on. `env` is the selected account's, held by the caller until this
   * settles so the account can't be removed under the request.
   */
  complete(request: UtilityCompletion, env: NodeJS.ProcessEnv): Promise<string>
}

/** A runner as utility work calls it, on whichever account is selected when it runs. */
export interface UtilityRunner {
  complete(request: UtilityCompletion): Promise<string>
}

/** A reply's JSON, without the Markdown fence some models wrap it in. */
export function jsonReply(reply: string): string {
  const trimmed = reply.trim()
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed)
  return (fenced?.[1] ?? trimmed).trim()
}
