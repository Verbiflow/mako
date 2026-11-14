import { childLine, childStateOf } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"

/** Where a Fin went on, in its row's words, unless its reason already says it: a Fin with nowhere to go didn't move. */
export function finMoved(agent: NativeAgent): string | undefined {
  const moved = agent.child?.moved
  return moved && moved !== childLine(childStateOf(agent)) ? moved : undefined
}
