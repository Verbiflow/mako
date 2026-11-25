import type { LiveRequest } from "../contracts/live-conversations.js"
import type { ThreadStore } from "../threads/index.js"

/**
 * Whether the turn `requestId` of conversation `id` answers a message another of the person's Threads is still owed a
 * reply to (`ApexMessage`): the message's own turn, the one it was steered into, or a turn that continues either. Nobody
 * watches that turn, so one a stop or a crash cut goes on as a Fin's does, whatever the person chose for their own
 * (`continueAfterRestart`): left for Continue, its reply could wait out the week a message is kept.
 */
export function answersAnotherThread(threads: Pick<ThreadStore, "owedApexMessages"> | undefined, id: string, requests: readonly LiveRequest[], requestId: string): boolean {
  const owed = threads?.owedApexMessages().filter((ask) => ask.conversation === id && !ask.reply)
  if (!owed?.length) return false
  const turns = new Set<string>()
  for (let turn: string | undefined = requestId; turn !== undefined && !turns.has(turn); turn = requests.find((request) => request.id === turn)?.continues?.requestId) turns.add(turn)
  return owed.some((ask) => turns.has(ask.request) || (ask.steered !== undefined && turns.has(ask.steered)))
}
