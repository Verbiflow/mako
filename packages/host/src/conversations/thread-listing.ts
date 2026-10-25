import { LISTED_CONVERSATIONS, ListedConversationSchema, type ListedConversation, type ListedState, type RuntimeListing } from "@mako/protocol/thread-listing"
import type { LifecycleWork } from "../contracts/app-lifecycle.js"
import type { LiveSummary } from "../contracts/live-conversations.js"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a cloud machine's conversations are, as the account's list shows them on every device: from the host's own
 * listing and the work its lifecycle lists, which is what already says whether a conversation is at work, waiting on a
 * person or neither (`lifecycleWork`). Newest first; a conversation the protocol can't carry (a harness it can't name)
 * is left out rather than refused with the rest.
 */
export function runtimeListing(summaries: readonly LiveSummary[], work: readonly LifecycleWork[]): RuntimeListing {
  const working = new Map(work.map((item) => [item.id, item.status]))
  const conversations = [...summaries]
    .sort((left, right) => right.createdAt - left.createdAt)
    .flatMap((summary): ListedConversation[] => {
      const { session } = summary
      const listed: ListedConversation = { id: session.id, harness: session.harness, state: listedState(session.status, working.get(session.id)), createdAt: new Date(summary.createdAt).toISOString() }
      if (session.title) listed.title = session.title.length > 200 ? `${session.title.slice(0, 199)}…` : session.title
      if (session.cwd) listed.folder = session.cwd
      if (summary.threadId && UUID.test(summary.threadId)) listed.thread = summary.threadId
      if (summary.sessionId && UUID.test(summary.sessionId)) listed.session = summary.sessionId
      const conversation = ListedConversationSchema.safeParse(listed)
      return conversation.success ? [conversation.data] : []
    })
  return { conversations: conversations.slice(0, LISTED_CONVERSATIONS) }
}

/** The lifecycle's word first: it counts queued requests, background work and approvals the session's status doesn't. */
function listedState(status: LiveSummary["session"]["status"], work: LifecycleWork["status"] | undefined): ListedState {
  if (work === "waiting") return "waiting"
  if (work) return "working"
  if (status === "failed") return "failed"
  if (status === "closed") return "closed"
  if (status === "running" || status === "starting") return "working"
  return "idle"
}
