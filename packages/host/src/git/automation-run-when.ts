import { z } from "zod"
import type { UtilityWork } from "./utility-work.js"

/**
 * An automation trigger's `runWhen`: one sentence a fast model holds an incoming event to, before a run starts. It
 * runs on the person's utility model connection (Settings › Git's commit messages choice), called once, briefly: the
 * same path commit drafts take, never a harness, which would start a whole agent for a yes or no.
 */

const VerdictSchema = z.object({ run: z.boolean(), why: z.string() })
const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: { run: { type: "boolean" }, why: { type: "string" } },
  required: ["run", "why"],
  additionalProperties: false,
}
const INSTRUCTIONS = [
  "You decide whether an automation runs for an event. You get its condition, one sentence the person wrote, and the event.",
  "Answer run: true only when the event clearly meets the condition; when it's unclear, answer false.",
  "why: one short sentence saying what in the event decided it.",
  "Return only JSON matching the schema.",
].join("\n")
const TIMEOUT_MS = 30_000

export class UtilityRunWhen {
  readonly #work: Pick<UtilityWork, "resolve">

  constructor(work: Pick<UtilityWork, "resolve">) {
    this.#work = work
  }

  async judge(input: { condition: string; event: string }): Promise<{ run: boolean; why: string; model?: string } | { unavailable: string }> {
    const resolved = await this.#work.resolve("commit").catch((error: Error) => ({ kind: "unavailable" as const, reason: error.message }))
    if (resolved.kind !== "ready") return { unavailable: resolved.reason }
    const reply = await resolved.model.complete({
      instructions: INSTRUCTIONS,
      prompt: `Condition: ${input.condition}\n\nEvent:\n${input.event.slice(0, 12_000)}`,
      schema: VERDICT_JSON_SCHEMA,
      maxOutputTokens: 200,
      reasoning: "low",
    }, AbortSignal.timeout(TIMEOUT_MS))
    let verdict: z.infer<typeof VerdictSchema> | undefined
    try {
      verdict = VerdictSchema.safeParse(JSON.parse(reply)).data
    } catch {
      verdict = undefined
    }
    return verdict ? { run: verdict.run, why: verdict.why.slice(0, 400), model: resolved.model.label.slice(0, 80) } : { unavailable: `${resolved.model.label} didn't answer in the shape asked.` }
  }
}
