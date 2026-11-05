import { resetWords } from "./account-usage.js"

/**
 * Where a Fin goes on when its harness's account is at its limit, built from
 * the person's own setup and the same on every harness: their other accounts
 * of that harness in their order, which keep its harness and model; then their
 * model connections the harness's declared routes take for the Fin's model
 * family; then their next harness in Settings › Models order, on the model
 * they use there. A step at its limit, unread, above the Fin's access, on a
 * connection turned off, or already run on in this turn is never taken.
 * Settings › Fins' switch off is today's rule: a Fin that named no harness
 * starts on the next harness, and nothing moves mid-run.
 */

/**
 * Whether a harness's session goes on under another of its accounts, declared
 * by its driver in the style of `modelRoutes`: `resumes` reopens the same
 * native session with the other account's credentials; `new-session` only
 * starts one, so a Fin mid-turn moves to the next harness instead. Every
 * installed harness declares it (`test-harness-definitions.ts`).
 */
export type AccountContinuation =
  | { kind: "resumes"; via: string }
  | { kind: "new-session"; reason: string }

/** One of the harness's accounts as the order reads it, in the person's order (Settings › Agents). */
export interface FallbackAccount {
  /** Its name in Settings › Agents; `default` is the CLI's own login. */
  name: string
  /** As the person reads it in a row: its name, or the CLI's own login's email. */
  label: string
  /** The one the harness's launches use now. */
  active: boolean
  /** At its limit now, and until when (`null`: its reading names no reset). */
  spent?: { until: number | null }
  /** Its reading failed: it may be as spent, so nothing moves to it. */
  unread?: boolean
  /** Signed out, missing or being removed: nothing starts on it. */
  unusable?: boolean
}

/** One of the person's model connections as the Fin's harness sees it. */
export interface FallbackConnection {
  id: string
  name: string
  enabled: boolean
  /** Whether the harness's declared routes take it (`routeAccepted`). */
  accepted: boolean
  /** What it serves: the endpoint's id, and the id the harness lists it under. */
  models: readonly { id: string; harnessModel: string }[]
}

/** One of the person's harnesses, in their order (Settings › Models). */
export interface FallbackHarness {
  harness: string
  /** It offers a mode at or below the Fin's access (`childMode`). */
  fits: boolean
  /** It's signed in here: its catalog lists models. */
  signedIn: boolean
  /** Its account in use is at its limit. */
  spent: boolean
}

export interface FallbackInput {
  /** Where the Fin is: its harness, the account it runs on and its model. */
  from: { harness: string; account?: string; model?: string }
  /** At a Fin's start, or mid-run after its turn failed on the limit. */
  when: "start" | "mid-run"
  /** Settings › Fins: "When an account runs out, continue on the next one". */
  on: boolean
  /** `from.harness`'s accounts, in the person's order. */
  accounts: readonly FallbackAccount[]
  /** What `from.harness` declares (`AccountContinuation`); a harness that declares nothing only starts new sessions. */
  continuation?: AccountContinuation
  connections: readonly FallbackConnection[]
  harnesses: readonly FallbackHarness[]
  /** The places this Fin already ran on in this turn (`placeKey`): never moved back to. */
  visited?: readonly string[]
}

/** A step the Fin can take: another account of its harness, a connection's model on it, or the person's next harness. */
export type FallbackStep =
  | { why: "account"; harness: string; account: string; label: string }
  | { why: "connection"; harness: string; connection: string; connectionName: string; model: string }
  | { why: "harness"; harness: string }

/** A place a Fin runs on, as visited sets key it: a harness, on an account or through a connection. */
export function placeKey(place: { harness: string; account?: string; connection?: string }): string {
  return place.connection ? `${place.harness}@${place.connection}` : place.account ? `${place.harness}:${place.account}` : place.harness
}

export function stepKey(step: FallbackStep): string {
  return step.why === "account" ? placeKey({ harness: step.harness, account: step.account })
    : step.why === "connection" ? placeKey({ harness: step.harness, connection: step.connection })
      : placeKey({ harness: step.harness })
}

/** The steps the person's setup offers, best first; empty when there's nowhere to go. */
export function fallbackOrder(input: FallbackInput): FallbackStep[] {
  const visited = new Set(input.visited ?? [])
  const { from } = input
  const steps: FallbackStep[] = []
  if (input.on) {
    // Mid-run, another account goes on in the same session only where the harness says it can.
    const accounts = input.when === "start" || input.continuation?.kind === "resumes"
    if (accounts)
      for (const account of input.accounts) {
        if (account.name === (from.account ?? input.accounts.find((each) => each.active)?.name)) continue
        if (account.spent || account.unread || account.unusable) continue
        steps.push({ why: "account", harness: from.harness, account: account.name, label: account.label })
      }
    const family = from.model ? modelFamily(from.model) : undefined
    if (family)
      for (const connection of input.connections) {
        if (!connection.enabled || !connection.accepted) continue
        const model = connection.models.find((each) => modelFamily(each.id) === family && each.harnessModel !== from.model)
        if (model) steps.push({ why: "connection", harness: from.harness, connection: connection.id, connectionName: connection.name, model: model.harnessModel })
      }
  }
  if (input.on || input.when === "start")
    for (const harness of input.harnesses)
      if (harness.harness !== from.harness && harness.fits && harness.signedIn && !harness.spent) steps.push({ why: "harness", harness: harness.harness })
  return steps.filter((step) => !visited.has(stepKey(step)))
}

/** The words a model's id names its family by, most specific first. */
const FAMILIES: readonly [RegExp, string][] = [
  [/claude|opus|sonnet|haiku/, "claude"],
  [/gpt|codex|^o\d/, "gpt"],
  [/gemini|gemma/, "gemini"],
  [/grok/, "grok"],
  [/llama/, "llama"],
  [/qwen/, "qwen"],
  [/deepseek/, "deepseek"],
  [/mistral|codestral|devstral/, "mistral"],
  [/kimi/, "kimi"],
  [/glm/, "glm"],
]

/** The family a model belongs to ("claude", "gpt"), read from its id wherever its provider put it; undefined when none is known. */
export function modelFamily(model: string): string | undefined {
  const name = model.toLowerCase().split("/").at(-1) ?? ""
  return FAMILIES.find(([words]) => words.test(name))?.[1]
}

/** A move as the Fin's row, strip, transcript and its Apex's digest say it: where it went, and why. */
export interface FinMove {
  step: FallbackStep
  /** The harness it left and the account there that is at its limit, as the person reads it. */
  from: { harness: string; account?: string }
  until?: number
}

/** A move in words: where it went ("Moved to Claude (work)") and why ("personal is at its limit until 3:10 PM PST"). */
export interface MovedWords {
  to: string
  why: string
}

export function movedWords(move: FinMove, label: (harness: string) => string, now: number): MovedWords {
  const { step, from } = move
  const until = move.until === undefined ? "" : ` until ${resetWords(move.until, now)}`
  const spent = step.harness === from.harness ? from.account ?? `${label(from.harness)}'s account` : from.account ? `${label(from.harness)} (${from.account})` : label(from.harness)
  const where = step.why === "account" ? `${label(step.harness)} (${step.label})` : step.why === "connection" ? `${step.connectionName} on ${label(step.harness)}` : label(step.harness)
  return { to: `Moved to ${where}`, why: `${spent} is at its limit${until}` }
}

/** "Moved to Claude (work): personal is at its limit until 3:10 PM PST", as a Fin's row, strip and its Apex's digest say it. */
export function movedLine(move: FinMove, label: (harness: string) => string, now: number): string {
  const words = movedWords(move, label, now)
  return `${words.to}: ${words.why}`
}
