import { z } from "zod"

/**
 * What an agent below full access asks the person to let it do through Mako's tools, kept in its conversation's control
 * (`ConversationControl.asks`), so a restart keeps it and the desk, the web app and the phone read one fact. The person
 * answers on any of them (`mako:agent-ask-answer`, on the conversation's owner).
 */
export const AgentAskWantSchema = z.discriminatedUnion("kind", [
  /** Move to the cloud. `handsOff`: its Thread works in its own worktree; otherwise it goes onto its own branch first, once its turns end. */
  z.object({ kind: z.literal("move"), move: z.string(), handsOff: z.boolean() }),
])
export type AgentAskWant = z.infer<typeof AgentAskWantSchema>

export const AgentAskSchema = z.object({ id: z.string(), at: z.number(), want: AgentAskWantSchema })
export type AgentAsk = z.infer<typeof AgentAskSchema>

/** What a row says while the ask waits, in a line. */
export function agentAskLine(want: AgentAskWant): string {
  switch (want.kind) {
    case "move":
      return "Wants to move this thread to the cloud"
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
  return {
    title: `${name} ${agentAskLine(want).toLowerCase()}`,
    description: want.handsOff ? "with its worktree, branch and sessions" : "onto its own branch first, then the cloud",
    detail: want.handsOff
      ? "Its worktree, branch and every session go to a cloud machine. A turn still running pauses here and goes on there."
      : "Only its own changes leave the project folder for a new branch, once this turn ends; then it moves to a cloud machine.",
    allow: "Move to the cloud",
    keep: "Keep here",
  }
}
