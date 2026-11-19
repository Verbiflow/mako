import { topic } from "./topic.js"

/**
 * One step of anything a person does to a conversation besides a message's own stages
 * (`conversations/live-stages.ts`): a steer, a Stop, an access change, an approval's answer, a wake, a driver's round
 * trip to its harness. Said as it passes so `npm run bench:actions` times it: a wait before
 * the driver is asked (`begin` and `end` around the await), the driver asked and answering (`asked`, `answered`,
 * `refused`), or a moment with no length (`at`). Name a new wait here rather than timing it where it happens.
 */
export interface LiveStep {
  conversation: string
  step: string
  phase: "begin" | "end" | "asked" | "answered" | "refused" | "at"
  detail?: string
}
export const liveSteps = topic<LiveStep>("mako:live-step")

export function liveStep(conversation: string, step: string, phase: LiveStep["phase"] = "at", detail?: string): void {
  if (liveSteps.heard) liveSteps.publish({ conversation, step, phase, ...detail !== undefined && { detail } })
}

/** `work`, said as it's asked and as it answers or refuses; with nobody listening it is `work()` and nothing more. */
export function stagedCall<Answer>(conversation: string, step: string, work: () => Promise<Answer>): Promise<Answer> {
  if (!liveSteps.heard) return work()
  liveStep(conversation, step, "asked")
  return work().then(
    (answer) => { liveStep(conversation, step, "answered"); return answer },
    (error: Error) => { liveStep(conversation, step, "refused", error.message); throw error })
}

/** As `stagedCall`, for a wait that isn't a call on the driver. */
export function stagedWait<Answer>(conversation: string, step: string, work: () => Promise<Answer>): Promise<Answer> {
  if (!liveSteps.heard) return work()
  liveStep(conversation, step, "begin")
  return work().finally(() => liveStep(conversation, step, "end"))
}
