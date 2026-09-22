import { z } from "zod"
import type { PageObservationNode } from "../browser/observation.js"

export const ControlSelectorSchema = z
  .object({ role: z.string().min(1), name: z.string() })
  .strict()
export const ControlReadScopeSchema = z.object({
  within: z.array(ControlSelectorSchema).max(8).default([]),
  match: ControlSelectorSchema.optional(),
})
export type ControlSelector = z.infer<typeof ControlSelectorSchema>
export type ControlReadScope = z.input<typeof ControlReadScopeSchema>

/** Scope fresh evidence by ancestry. Never manufacture a new ref from an old one. */
export function scopeControlNodes(
  nodes: readonly PageObservationNode[],
  scope: ControlReadScope
): PageObservationNode[] {
  let selected = [...nodes]
  for (const container of scope.within ?? []) {
    const matches = selected.flatMap((node, index) =>
      node.role === container.role && (node.name ?? "") === container.name
        ? [index]
        : []
    )
    if (matches.length !== 1)
      throw new Error(
        `Scope requires one ${container.role} ${JSON.stringify(container.name)}; found ${matches.length}. Observe and disambiguate the container.`
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
      (node) => node.role === match.role && (node.name ?? "") === match.name
    )
  }
  return selected
}
