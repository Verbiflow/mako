import { z } from "zod"
import { ControlFault } from "./fault.js"
import type { PageObservationNode } from "../browser/observation.js"

/** An exact accessible name, or a pattern for names that carry live text
 * ("Draft 2m", "Settings ⌘ ,"). Patterns ignore case and repeated spaces. */
export const NameMatchSchema = z.union([
  z.string(),
  z.object({ prefix: z.string().min(1) }).strict(),
  z.object({ contains: z.string().min(1) }).strict(),
  z
    .object({
      regex: z.string().min(1).max(500),
      flags: z
        .string()
        .regex(/^[imsu]*$/)
        .optional(),
    })
    .strict(),
])
export type NameMatch = z.infer<typeof NameMatchSchema>
const spaced = (text: string) =>
  text.replace(/\s+/g, " ").trim().toLocaleLowerCase()
export function nameMatches(
  actual: string | undefined,
  wanted: NameMatch
): boolean {
  const name = actual ?? ""
  if (typeof wanted === "string") return name === wanted
  if ("prefix" in wanted) return spaced(name).startsWith(spaced(wanted.prefix))
  if ("contains" in wanted)
    return spaced(name).includes(spaced(wanted.contains))
  return new RegExp(wanted.regex, wanted.flags).test(name)
}
export const isExactName = (name: NameMatch): name is string =>
  typeof name === "string"

export const ControlSelectorSchema = z
  .object({ role: z.string().min(1), name: NameMatchSchema })
  .strict()
/** A container to read inside. Landmarks such as main and banner are often
 * unnamed, so the name may be left out; the scope still needs exactly one. */
export const ControlScopeSchema = z
  .object({ role: z.string().min(1), name: NameMatchSchema.optional() })
  .strict()
export const ControlReadScopeSchema = z.object({
  within: z.array(ControlScopeSchema).max(8).default([]),
  match: ControlSelectorSchema.optional(),
})
export type ControlSelector = z.infer<typeof ControlSelectorSchema>
export type ControlScope = z.infer<typeof ControlScopeSchema>
export type ControlReadScope = z.input<typeof ControlReadScopeSchema>

export const inScope = (role: string | null | undefined, name: string | undefined, scope: ControlScope) =>
  role === scope.role && (scope.name === undefined || nameMatches(name, scope.name))
export const scopeLabel = (scope: ControlScope) =>
  scope.name === undefined ? scope.role : `${scope.role} ${JSON.stringify(scope.name)}`

/** Scope fresh evidence by ancestry. Never manufacture a new ref from an old one. */
export function scopeControlNodes(
  nodes: readonly PageObservationNode[],
  scope: ControlReadScope
): PageObservationNode[] {
  let selected = [...nodes]
  for (const container of scope.within ?? []) {
    const matches = selected.flatMap((node, index) =>
      inScope(node.role, node.name, container) ? [index] : []
    )
    if (matches.length !== 1)
      throw new ControlFault(
        matches.length ? "target-ambiguous" : "target-not-found",
        `Scope requires one ${scopeLabel(container)}; found ${matches.length}. ${matches.length ? "Add its name or an outer within scope" : "Observe and copy the container's role and name"}. Nothing was dispatched.`,
        "not-dispatched"
      )
    const index = matches[0]!
    const depth = selected[index]!.depth
    let end = index + 1
    while (end < selected.length && selected[end]!.depth > depth) end++
    selected = selected.slice(index + 1, end)
  }
  if (scope.match) {
    const match = scope.match
    selected = selected.filter(
      (node) => node.role === match.role && nameMatches(node.name, match.name)
    )
  }
  return selected
}
