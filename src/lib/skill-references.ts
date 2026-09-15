import {
  UNIVERSAL_SKILL_PROVIDER,
  skillDeliveryFor,
} from "../../electron/contracts/skill-reach"
import { harnessTitle } from "./harness-title"
import { tokenize } from "./mentions"
import type {
  SkillDelivery,
  SkillReference,
  SkillRegistrySnapshot,
} from "./types"

/**
 * `$skill` references at send time.
 *
 * Every other reference the composer accepts resolves to something when the
 * message goes out: `@file` to a staged path, `@thread:` to a transcript
 * bundle, an attachment to its appendix. A skill reference used to go out as
 * the bare token, which only worked when the selected provider happened to
 * have that skill in a root it reads. Now the host resolves each name for
 * the provider that will answer (`skill-reach.ts`) and the message carries
 * what that provider lacks: the SKILL.md body for a skill it does not have,
 * a pointer for one it does. The appendix sits under the same `---` rule as
 * the others, with `[Skill name]` markers the transcript reads back as chips.
 */

const MARKER = "\n---\n[Skill "
const ENTRY = /^\[Skill ([^\s\]]+)(?: from ([^\s\]]+))?\]/gm
/**
 * The shape of a skill name (`SKILL.md` `name`: lowercase, digits, hyphens)
 * with at least one letter, so `$5` and `$2,000` in a sentence about money
 * are prose and cost no host round trip.
 */
const SKILL_NAME = /^(?=.*[a-z])[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface SkillAppendixEntry {
  name: string
  /** The provider whose copy was handed over; absent when the provider had its own. */
  from?: string
}

export interface ParsedSkillAppendix {
  body: string
  skills: SkillAppendixEntry[]
}

export interface SkillAppendixResult {
  text: string
  /** Hashes whose bodies this message carries, to remember once it is sent. */
  handed: string[]
  /** Why the references could not be resolved; the text is then unchanged. */
  failed?: string
}

/** Whether a `$` token names something that could be a skill. */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** The unique skill names a draft references, in order of first mention. */
export function skillNamesIn(text: string): string[] {
  const names: string[] = []
  for (const segment of tokenize(text)) {
    if (segment.kind !== "skill") continue
    if (!isSkillName(segment.name) || names.includes(segment.name)) continue
    names.push(segment.name)
  }
  return names
}

/** Where a handover came from, as prose: a provider's name or the universal root. */
export function skillSourceLabel(provider: string): string {
  return provider === UNIVERSAL_SKILL_PROVIDER
    ? "the universal skills folder (.agents/skills)"
    : `${harnessTitle(provider)}'s skills`
}

/** What a chip says on hover, before and after the send, from the same delivery. */
export function skillChipTitle(
  name: string,
  delivery: SkillDelivery | undefined
): string {
  if (!delivery) return `Skill: ${name}`
  if (delivery.kind === "missing")
    return `No skill named ${name} is installed anywhere Mako looks`
  if (delivery.kind === "native") return `Skill: ${name} · the provider has it`
  return `Skill: ${name} · handed over from ${skillSourceLabel(delivery.from)}`
}

/**
 * A skill nothing Mako can see is installed: the token goes out as typed.
 * Shared by the composer overlay and the transcript chip; the overlay needs
 * it to take no width, so it is edge and ink only.
 */
export const MISSING_SKILL_CHIP_CLASS =
  "bg-transparent text-muted-foreground outline-1 outline-dashed -outline-offset-1 outline-border"

/** The chip's reading of a reference before it is sent. */
export function draftSkillDelivery(
  snapshot: SkillRegistrySnapshot | null,
  name: string,
  harness: string
): SkillDelivery {
  if (!snapshot) return { kind: "missing" }
  return skillDeliveryFor(snapshot.skills, snapshot.providers, name, harness)
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/")
  return at === -1 ? path : path.slice(0, at)
}

function entry(reference: SkillReference, handed: ReadonlySet<string>): string | null {
  const { delivery } = reference
  if (delivery.kind === "missing") return null
  if (delivery.kind === "native") {
    return `[Skill ${reference.name}] Installed for you at ${delivery.path}. Use it now.`
  }
  const marker = `[Skill ${reference.name} from ${delivery.from}]`
  const source = skillSourceLabel(delivery.from)
  const directory = directoryOf(delivery.path)
  if (reference.hash && handed.has(reference.hash)) {
    return `${marker} Handed over from ${source} earlier in this conversation; apply it again now. Its files are in ${directory}/.`
  }
  const lead = reference.description
    ? `${marker} ${reference.description}`
    : marker
  if (reference.body === undefined) {
    return `${lead}\nHanded over from ${source}. Read ${delivery.path} in full and apply it now; supporting files are beside it.`
  }
  return `${lead}\nHanded over from ${source}. Apply these instructions now; supporting files are in ${directory}/.\n\n${reference.body}`
}

/**
 * Append the resolved references to a prompt. Missing names add nothing:
 * `$5 budget` is prose the tokenizer let through, not a skill to explain.
 */
export function appendSkillReferences(
  text: string,
  references: readonly SkillReference[],
  handed: ReadonlySet<string> = new Set()
): SkillAppendixResult {
  const lines: string[] = []
  const carried: string[] = []
  for (const reference of references) {
    const written = entry(reference, handed)
    if (!written) continue
    lines.push(written)
    if (
      reference.delivery.kind === "handover" &&
      reference.body !== undefined &&
      reference.hash &&
      !handed.has(reference.hash)
    )
      carried.push(reference.hash)
  }
  if (lines.length === 0) return { text, handed: [] }
  return {
    text: `${text.trimEnd()}\n\n---\n${lines.join("\n\n")}`,
    handed: carried,
  }
}

function appendixStart(text: string): number {
  const at = text.lastIndexOf(MARKER)
  if (at >= 0) return at
  return text.startsWith(MARKER.slice(1)) ? 0 : -1
}

export function stripSkillAppendix(text: string): string {
  const at = appendixStart(text)
  return at === -1 ? text : text.slice(0, at).trimEnd()
}

/** Split the appendix off a sent prompt so the words stay words and each `$skill` reads back as its chip. */
export function parseSkillAppendix(text: string): ParsedSkillAppendix {
  const at = appendixStart(text)
  if (at === -1) return { body: text, skills: [] }
  const appendix = text.slice(at)
  const skills: SkillAppendixEntry[] = []
  for (const match of appendix.matchAll(ENTRY)) {
    const found: SkillAppendixEntry = { name: match[1]! }
    if (match[2]) found.from = match[2]
    skills.push(found)
  }
  return { body: text.slice(0, at).trimEnd(), skills }
}
