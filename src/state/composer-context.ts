import type { ContextInput } from "@/lib/context-detail"

declare global {
  interface WindowEventMap {
    "mako:add-context": CustomEvent<ContextInput>
  }
}

/**
 * Put a chip for something on screen into the composer at its caret: a
 * comment on lines, a picked element, a quote, a pull request. The composer
 * owns the draft, so this only asks; it focuses the composer and places the
 * chip where the person was typing, or at the end.
 */
export function addContext(input: ContextInput): void {
  window.dispatchEvent(new CustomEvent("mako:add-context", { detail: input }))
}
