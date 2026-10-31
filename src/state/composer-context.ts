import type { ContextInput } from "@/lib/context-detail"

/** A chip asked for; `conversation`, when set, is the only conversation whose composer may take it. */
export class AddContextEvent extends CustomEvent<ContextInput> {
  readonly conversation: string | undefined

  constructor(input: ContextInput, conversation: string | undefined) {
    super("mako:add-context", { detail: input, cancelable: true })
    this.conversation = conversation
  }
}

declare global {
  interface WindowEventMap {
    "mako:add-context": AddContextEvent
  }
}

/**
 * Put a chip for something on screen into the composer at its caret: a
 * comment on lines, a picked element, a quote, a pull request. The composer
 * owns the draft, so this only asks; it focuses the composer and places the
 * chip where the person was typing, or at the end. A chip about one
 * conversation (a comment on one Session's turn) names it, and only that
 * conversation's composer takes it. The answer is whether a composer took it.
 */
export function addContext(input: ContextInput, conversation?: string): boolean {
  const event = new AddContextEvent(input, conversation)
  window.dispatchEvent(event)
  return event.defaultPrevented
}
