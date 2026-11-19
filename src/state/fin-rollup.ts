import { childGroup, childStateOf, rollup, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { listedCounts, threadChildren, type AcpState } from "@/state/acp-state"

// A Thread's Fins as the list and the rail count them, read from the window's state alone: kept apart from `apex-fins.ts`
// (the actions on Fins, which bring the live state with them) so the web app's list paints without that code.

const NO_CHILDREN: readonly NativeAgent[] = []
const rollupOf = new WeakMap<readonly NativeAgent[], Rollup>()

/** A roster's count, made once per roster: every row of an Apex reads it on each change the rail hears. */
function counted(children: readonly NativeAgent[]): Rollup {
  let held = rollupOf.get(children)
  if (!held) {
    held = rollup(children)
    rollupOf.set(children, held)
  }
  return held
}

export function threadRollup(state: AcpState, thread: string | undefined): Rollup {
  const children = threadChildren(state, thread)
  // As its host listed it (`listedCounts`): an Apex's count before this window holds its roster, its newest Session's.
  return children.length || !thread ? counted(children) : (listedCounts(state).get(thread) ?? counted(children))
}

const askingOf = new WeakMap<readonly NativeAgent[], readonly NativeAgent[]>()

/**
 * A Thread's Fins that wait on the person, in its roster's order, the same array while its roster is. Empty until this
 * window holds the roster; the Inbox reads the roster of every Apex whose count says one waits (`useInboxRosters`).
 */
export function threadAsking(state: AcpState, thread: string | undefined): readonly NativeAgent[] {
  const children = threadChildren(state, thread)
  let held = askingOf.get(children)
  if (!held) {
    const asking = children.filter((agent) => childGroup(childStateOf(agent)) === "needs")
    held = asking.length ? asking : NO_CHILDREN
    askingOf.set(children, held)
  }
  return held
}
