import { z } from "zod"

/**
 * What an agent below full access asks the person to let it do through Mako's tools, kept in its conversation's control
 * (`ConversationControl.asks`), so a restart keeps it and the desk, the web app and the phone read one fact. The person
 * answers on any of them (`mako:agent-ask-answer`, on the conversation's owner).
 */
export const AgentAskWantSchema = z.discriminatedUnion("kind", [
  /** Move to the cloud. `handsOff`: its Thread works in its own worktree; otherwise it goes onto its own branch first, once its turns end. */
  z.object({ kind: z.literal("move"), move: z.string(), handsOff: z.boolean() }),
  /** Rename, Archive and Restore on the Thread's menu. `op`: the operation the answer runs under. */
  z.object({ kind: z.literal("rename"), op: z.string(), title: z.string() }),
  z.object({ kind: z.literal("archive"), op: z.string() }),
  z.object({ kind: z.literal("restore"), op: z.string() }),
])
export type AgentAskWant = z.infer<typeof AgentAskWantSchema>

export const AgentAskSchema = z.object({ id: z.string(), at: z.number(), want: AgentAskWantSchema })
export type AgentAsk = z.infer<typeof AgentAskSchema>

/** An ask's two answers as an approval's options, on the path a Fin's asks take to its Apex and the person. */
export const AGENT_ASK_ALLOW = "allow"
export const AGENT_ASK_KEEP = "keep"

/** What a row says while the ask waits, in a line. */
export function agentAskLine(want: AgentAskWant): string {
  switch (want.kind) {
    case "move":
      return "Wants to move this Thread to the cloud"
    case "rename":
      return `Wants to rename this Thread to ${want.title}`
    case "archive":
      return "Wants to archive this Thread"
    case "restore":
      return "Wants to restore this Thread"
  }
}

/** How every surface says an ask: `name` is the harness's, as the person reads it. */
export interface AgentAskWords {
  title: string
  description: string
  detail: string
  allow: string
  keep: string
}

export function agentAskWords(want: AgentAskWant, name: string): AgentAskWords {
  const title = `${name} ${agentAskLine(want).replace(/^W/, "w")}`
  switch (want.kind) {
    case "move":
      return {
        title,
        description: want.handsOff ? "with its worktree, branch and sessions" : "onto its own branch first, then the cloud",
        detail: want.handsOff
          ? "Its worktree, branch and every session go to a cloud machine. A turn still running pauses here and goes on there."
          : "Only its own changes leave the project folder for a new branch, once this turn ends; then it moves to a cloud machine.",
        allow: "Move to the cloud",
        keep: "Keep here",
      }
    case "rename":
      return { title, description: "its title in the list", detail: "The title it shows everywhere; the agent's work goes on as it is.", allow: "Rename", keep: "Keep this title" }
    case "archive":
      return { title, description: "out of the list", detail: "It leaves the list, and a turn still running stops. Restore brings it back.", allow: "Archive", keep: "Keep it" }
    case "restore":
      return { title, description: "back in the list", detail: "It comes back to the list as it was.", allow: "Restore", keep: "Leave it archived" }
  }
}
