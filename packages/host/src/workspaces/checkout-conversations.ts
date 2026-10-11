import { statSync } from "node:fs"
import type { CheckoutConversations } from "./thread-worktrees.js"
import type { WorkspaceConversations } from "./conversations.js"

const holds = (folder: string, path: string) => path === folder || path.startsWith(`${folder}/`)

/**
 * The open conversations in a checkout being removed: each goes on in the
 * same place in the main checkout under its own native session, so none is
 * left in a folder that no longer exists. Those that can't move now, mid-turn
 * or on a harness that only resumes where it began, hold the removal, as
 * terminals do.
 */
export function checkoutConversations(
  live: Pick<WorkspaceConversations, "summaries" | "relocation" | "relocate">,
  shells: (folder: string) => Promise<string[]>,
): CheckoutConversations {
  const open = (folder: string) => live.summaries()
    .map(({ session }) => session)
    .filter((session) => session.status !== "closed" && holds(folder, session.cwd))
  const named = (session: { title?: string }) => `“${session.title || "Untitled conversation"}”`
  return {
    async holding(folder, waitingFor) {
      const staying = open(folder).filter((session) => {
        const { kind } = live.relocation(session.id)
        return kind === "never" || (kind === "wait" && session.id !== waitingFor)
      }).map(named)
      return [...staying, ...await shells(folder)]
    },
    async leave(from, to) {
      const stayed: string[] = []
      for (const session of open(from)) {
        const there = `${to}${session.cwd.slice(from.length)}`
        const cwd = statSync(there, { throwIfNoEntry: false })?.isDirectory() ? there : to
        if (await live.relocate(session.id, cwd) === undefined) stayed.push(named(session))
      }
      return stayed
    },
  }
}
