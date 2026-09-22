import { z } from "zod"
import type { TerminalSession } from "@/lib/types"

export const terminalGroupSchema = z.object({
  id: z.string().min(1).max(128),
  sessionIds: z.array(z.string().min(1).max(128)).min(1).max(4),
  orientation: z.enum(["horizontal", "vertical"]),
})
export type TerminalGroup = z.infer<typeof terminalGroupSchema>
export const MAX_TERMINAL_PANES = 4

/** Every shell belongs to exactly one group, and groups never cross workspaces. */
export function reconcileTerminalGroups(
  groups: TerminalGroup[],
  sessions: TerminalSession[]
): TerminalGroup[] {
  const remaining = new Map(sessions.map((session) => [session.id, session]))
  const result: TerminalGroup[] = []
  for (const group of groups) {
    const cwd = group.sessionIds
      .map((id) => remaining.get(id))
      .find((session) => session !== undefined)?.cwd
    const sessionIds = group.sessionIds.filter((id) => {
      const session = remaining.get(id)
      if (!session || (cwd !== undefined && session.cwd !== cwd)) return false
      remaining.delete(id)
      return true
    })
    if (sessionIds.length)
      result.push({ ...group, id: sessionIds[0], sessionIds })
  }
  for (const session of remaining.values())
    result.push({
      id: session.id,
      sessionIds: [session.id],
      orientation: "horizontal",
    })
  return result
}

export function terminalGroupFor(groups: TerminalGroup[], sessionId?: string) {
  return groups.find(
    (group) => sessionId !== undefined && group.sessionIds.includes(sessionId)
  )
}
