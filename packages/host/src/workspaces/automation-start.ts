import { childMode } from "../contracts/agents.js"
import type { AutomationStart } from "../contracts/automations.js"
import type { FinChoicesReading, FinTarget } from "../contracts/fin-tuning.js"
import { resolveFinTuning } from "../contracts/fin-tuning.js"
import type { LiveStartOptions } from "../contracts/live-conversations.js"
import type { HarnessProfile, LiveSessionMode } from "../contracts/providers-acp.js"
import { AutomationNotStartedError } from "./automations.js"

/**
 * How a run's Thread starts on a host: its harness, model, reasoning and rule settled as `agents_start` settles a
 * Fin's, and its mode the harness's own at the automation's access or the strictest below it (`childMode`), never
 * above. One mapping for a run started on the person's Mac and one a cloud Thread's host starts for the account
 * (`mako:automations-cloud-start`): a rule is read from the person's policy where they are, and given as their Mac
 * resolved it where they aren't. What it can't apply refuses the start, saying why (`AutomationNotStartedError`): it
 * never starts a looser mode, another harness than the one named, or without the rule it follows.
 */

/** What the plan reads of its host. */
export interface AutomationStartPorts {
  /** The harnesses this host runs live, in the person's order. */
  harnesses(): string[]
  /** A harness's live modes, by access; undefined for one that declares none (Mako's own ids then). */
  modes(harness: string): readonly LiveSessionMode[] | undefined
  profile(harness: string, cwd: string): Promise<HarnessProfile>
  /** The person's Fin choices here: their rules, defaults and last-used settings. */
  reading(): FinChoicesReading
  label(harness: string): string
}

export interface AutomationStartInput {
  cwd: string
  start: Pick<AutomationStart, "harness" | "model" | "reasoning" | "rule" | "access">
  /** The rule's target, as the person's Mac resolved it; absent, read from this host's policy. */
  ruled?: FinTarget
  title: string
  conversationId: string
  requestId: string
  text: string
  tokenBudget?: number
}

export async function planAutomationStart(ports: AutomationStartPorts, input: AutomationStartInput): Promise<{ harness: string; options: LiveStartOptions }> {
  const { start, cwd } = input
  const reading = ports.reading()
  const target = start.rule === undefined ? undefined : (input.ruled ?? reading.policy?.rules[start.rule - 1]?.target)
  if (start.rule !== undefined && !target) throw new AutomationNotStartedError(`The person has no rule ${start.rule} for Fins now.`)
  const runs = ports.harnesses()
  let harness = start.harness ?? target?.harness
  if (!harness) {
    for (const candidate of runs) {
      if ((await ports.profile(candidate, cwd).catch(() => undefined))?.available) {
        harness = candidate
        break
      }
    }
  }
  if (!harness || !runs.includes(harness)) throw new AutomationNotStartedError(`No harness named ${harness ?? "(none)"} runs here.`)
  const label = ports.label(harness)
  const profile = await ports.profile(harness, cwd)
  if (!profile.available) throw new AutomationNotStartedError(`${label} isn't ready here: sign in to it in Settings › Agents.`)
  const tuned = resolveFinTuning({
    label,
    models: profile.models,
    asked: { ...(start.model && { model: start.model }), ...(start.reasoning && { reasoning: start.reasoning }) },
    ...(target?.settings && target.harness === harness && { rule: { who: `Rule ${start.rule}`, settings: target.settings } }),
    ...(reading.chosen[harness] && { chosen: reading.chosen[harness] }),
    ...(reading.used[harness] && { used: reading.used[harness] }),
    ...(profile.settings && { recommended: profile.settings }),
  })
  if ("refused" in tuned) throw new AutomationNotStartedError(tuned.refused)
  const mode = childMode(ports.modes(harness), start.access)
  if (!mode) throw new AutomationNotStartedError(`${label} has no access level at or below ${start.access}.`)
  return {
    harness,
    options: {
      conversationId: input.conversationId,
      title: input.title.slice(0, 120),
      modeId: mode.id,
      ...(tuned.settings && { tuning: tuned.settings }),
      ...(input.tokenBudget
        ? { goal: { objective: input.text, tokenBudget: input.tokenBudget } }
        : { initialRequest: { id: input.requestId, text: input.text, attachments: [] } }),
    },
  }
}

/** Where a standing Thread's run goes: its conversation, and whether its session takes it as its next message. */
export interface StandingTarget {
  conversationId: string
  submit: boolean
}

/** How a standing Thread's session runs now, as far as a run's plan compares it. */
export interface StandingSession {
  harness: string
  mode: string | null
  model?: string
}

/**
 * Where a standing Thread's next run goes. Its session takes the run as its next message only while it runs as the
 * approved start plans now: the same harness, mode and model. One that doesn't (its access tightened since, or its
 * harness or model changed) is left as it is, and the run starts a fresh session under a conversation named by the
 * plan, which later runs of the same plan reach. One that drifted from its own plan (its mode changed by hand) refuses
 * the run, saying why, rather than run it at another access than the one approved.
 */
export function standingTarget(fixed: string, plan: { harness: string; options: LiveStartOptions }, sessionOf: (conversation: string) => StandingSession | undefined, derive: (signature: string) => string): StandingTarget {
  const model = plan.options.tuning?.model
  const matches = (session: StandingSession) => session.harness === plan.harness && session.mode === (plan.options.modeId ?? null) && (model === undefined || session.model === model)
  const kept = sessionOf(fixed)
  if (!kept) return { conversationId: fixed, submit: false }
  if (matches(kept)) return { conversationId: fixed, submit: true }
  const conversationId = derive(`${plan.harness}\0${plan.options.modeId ?? ""}\0${model ?? ""}`)
  const fresh = sessionOf(conversationId)
  if (!fresh) return { conversationId, submit: false }
  if (matches(fresh)) return { conversationId, submit: true }
  throw new AutomationNotStartedError("Its standing Thread no longer runs at the access, harness or model its approved start says; it wasn't sent this run. Start it again from Automations.")
}
