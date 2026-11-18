import { childGroup, childStateOf, rollup, type Rollup } from "@mako/host/contracts/children"
import type { NativeAgent } from "@mako/host/contracts/native-agents"
import { newestSaid, threadChildren, type AcpState } from "@/state/acp-state"

// A Thread's Fins as the list and the rail count them, read from the window's state alone: kept apart from `apex-fins.ts`
// (the actions on Fins, which bring the live state with them) so the web app's list paints without that code.

const NO_CHILDREN: readonly NativeAgent[] = []
const listedByThread = new WeakMap<AcpState["conversations"], { order: AcpState["threadSessions"]; index: Map<string, Rollup> }>()

/** As its host listed it (`LiveSummary.children`): an Apex's count before this window holds its roster, its newest Session's. */
function listedRollup(state: AcpState, thread: string): Rollup | undefined {
  let held = listedByThread.get(state.conversations)
  if (!held || held.order !== state.threadSessions) {
    held = { order: state.threadSessions, index: newestSaid(state, (conversation) => (conversation.children ? [{ thread: conversation.threadId!, session: conversation.sessionId, order: conversation.order, value: conversation.children, fullness: 0 }] : [])) }
    listedByThread.set(state.conversations, held)
  }
  return held.index.get(thread)
}

export function threadRollup(state: AcpState, thread: string | undefined): Rollup {
  const children = threadChildren(state, thread)
  return children.length || !thread ? rollup(children) : (listedRollup(state, thread) ?? rollup(children))
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
