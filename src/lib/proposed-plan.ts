import { z } from "zod"
import { ProposedPlanSchema } from "@mako/sessions/content"
import type { ProposedPlan } from "@mako/sessions/content"

/** The plan's heading, without the "Plan:" agents often lead it with; the UI already says it is a plan. */
export function proposedPlanTitle(text: string): string {
  const heading = /^#\s+(.+)$/m.exec(text)?.[1]?.trim()
  return heading?.replace(/^plan\s*[:—–-]\s*/i, "").trim() || heading || "Proposed plan"
}
export function proposedPlanFilename(text: string): string {
  const slug = proposedPlanTitle(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
  return `${slug || "proposed-plan"}.md`
}
export function proposedPlanMarkdown(plan: ProposedPlan): string {
  return `${plan.truncated ? "> This plan was truncated at the capture limit.\n\n" : ""}${plan.text.trim()}\n`
}
export function proposedPlanReply(
  plan: ProposedPlan,
  intent: "implement" | "revise"
): string {
  const title = proposedPlanTitle(plan.text)
  return intent === "implement"
    ? `Implement the proposed plan: ${title}.`
    : `Revise the proposed plan: ${title}. Keep planning until I approve implementation.`
}

const CONTEXT_START = "\n\n<mako-plan-context>\n"
const CONTEXT_END = "\n</mako-plan-context>"
const PlanContextSchema = z.array(ProposedPlanSchema)
export function appendPlanContext(
  text: string,
  plans: ProposedPlan[] = []
): string {
  return plans.length
    ? `${text}${CONTEXT_START}${JSON.stringify(plans)}${CONTEXT_END}`
    : text
}
interface PlanContext {
  body: string
  plans: ProposedPlan[]
}
export function parsePlanContext(text: string): PlanContext {
  const start = text.indexOf(CONTEXT_START)
  if (start < 0 || !text.endsWith(CONTEXT_END)) return { body: text, plans: [] }
  try {
    const plans = PlanContextSchema.parse(
      JSON.parse(text.slice(start + CONTEXT_START.length, -CONTEXT_END.length))
    )
    return { body: text.slice(0, start), plans }
  } catch {
    return { body: text, plans: [] }
  }
}
