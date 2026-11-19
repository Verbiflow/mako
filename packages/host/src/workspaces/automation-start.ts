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
